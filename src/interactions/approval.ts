import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  type ButtonInteraction,
  type Client,
  type GuildTextBasedChannel,
} from "discord.js";
import { randomUUID } from "node:crypto";
import type { AccessDatabase } from "../persistence/database.js";
import type { AccessRequest, TemporaryGrant } from "../persistence/types.js";
import type { GrantLifecycle } from "../services/grant-lifecycle.js";
import { canAssignRole } from "../services/role-policy.js";
import { log } from "../logger.js";
import { translate } from "../localization.js";

export function approvalComponents(
  requestId: string,
  disabled = false,
  language: "en" | "de" = "en",
) {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`access:accept:${requestId}`)
        .setLabel(translate(language, "accept"))
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(`access:deny:${requestId}`)
        .setLabel(translate(language, "deny"))
        .setStyle(ButtonStyle.Danger)
        .setDisabled(disabled),
    ),
  ];
}

export class ApprovalWorkflow {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly deletionTimers = new Map<string, NodeJS.Timeout>();
  private static readonly messageDeletionDelayMs = 30_000;

  constructor(
    private readonly client: Client,
    private readonly database: AccessDatabase,
    private readonly lifecycle: GrantLifecycle,
  ) {}

  async postRequest(
    request: AccessRequest,
    channel: GuildTextBasedChannel,
    roleName: string,
  ): Promise<string> {
    const language = this.database.getGuildConfig(request.guildId).language;
    const approverIds = await this.getEligibleApproverIds(request);
    const mentions = approverIds.map((userId) => `<@${userId}>`).join(" ");
    const message = await channel.send({
      content: `${mentions ? `${mentions}\n` : ""}${translate(language, "approvalPingText")}`,
      embeds: [
        new EmbedBuilder()
          .setTitle(translate(language, "approvalTitle"))
          .setDescription(
            [
              translate(language, "approvalRequester", {
                user: request.requesterId,
              }),
              translate(language, "approvalRole", {
                role: request.roleId,
                name: roleName,
              }),
              translate(language, "approvalTarget", {
                channel: request.targetChannelId,
              }),
              translate(language, "approvalExpires", {
                expires: Math.floor(request.expiresAt / 1000),
              }),
            ].join("\n"),
          )
          .setFooter({
            text: translate(language, "requestFooter", {
              id: request.id,
              status: translate(language, "approvalPending"),
            }),
          }),
      ],
      components: approvalComponents(request.id, false, language),
      allowedMentions: {
        users: approverIds,
      },
    });
    this.database.setRequestMessageId(request.id, channel.id, message.id);
    this.schedule(request.id, request.expiresAt);
    return message.id;
  }

  private async getEligibleApproverIds(
    request: AccessRequest,
  ): Promise<string[]> {
    try {
      const guild = await this.client.guilds.fetch(request.guildId);
      const channel = await guild.channels.fetch(request.targetChannelId);
      if (
        !channel ||
        (channel.type !== ChannelType.GuildVoice &&
          channel.type !== ChannelType.GuildStageVoice)
      ) {
        log("warn", "Could not find target voice channel to notify approvers", {
          requestId: request.id,
          guildId: request.guildId,
          channelId: request.targetChannelId,
        });
        return [];
      }
      return channel.members
        .filter((member) => member.roles.cache.has(request.roleId))
        .map((member) => member.id)
        .slice(0, 100);
    } catch (error) {
      log(
        "warn",
        "Could not fetch eligible approvers for request notification",
        {
          requestId: request.id,
          guildId: request.guildId,
          channelId: request.targetChannelId,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return [];
    }
  }

  async handleButton(interaction: ButtonInteraction): Promise<void> {
    const [, action, requestId] = interaction.customId.split(":");
    if (
      (action !== "accept" && action !== "deny") ||
      !requestId ||
      !interaction.guild
    ) {
      await interaction.reply({
        content: translate(
          interaction.guildId
            ? this.database.getGuildConfig(interaction.guildId).language
            : "en",
          "approvalControlInvalid",
        ),
        ephemeral: true,
      });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    const request = this.database.getRequest(requestId);
    if (
      !request ||
      request.guildId !== interaction.guild.id ||
      request.status !== "pending"
    ) {
      await interaction.editReply(
        translate(
          this.database.getGuildConfig(interaction.guild.id).language,
          "requestNoLongerPending",
        ),
      );
      return;
    }
    if (request.expiresAt <= Date.now()) {
      this.database.expireRequest(request.id, Date.now());
      await this.resolveMessage(request, "expired");
      await interaction.editReply(
        translate(
          this.database.getGuildConfig(request.guildId).language,
          "requestExpired",
        ),
      );
      return;
    }
    const approver = await interaction.guild.members
      .fetch(interaction.user.id)
      .catch(() => null);
    if (
      !approver ||
      !approver.roles.cache.has(request.roleId) ||
      approver.voice.channelId !== request.targetChannelId
    ) {
      await interaction.editReply(
        translate(
          this.database.getGuildConfig(request.guildId).language,
          "approverRequired",
        ),
      );
      return;
    }

    if (action === "deny") {
      const won = this.database.decideRequest(
        request.id,
        "denied",
        approver.id,
        Date.now(),
      );
      if (!won) {
        await interaction.editReply(
          translate(
            this.database.getGuildConfig(request.guildId).language,
            "competingDecision",
          ),
        );
        return;
      }
      this.clearTimer(request.id);
      await this.resolveMessage(request, "denied", approver.id);
      this.scheduleMessageDeletion(
        request,
        (request.decisionAt ?? Date.now()) +
          ApprovalWorkflow.messageDeletionDelayMs,
      );
      await interaction.editReply(
        translate(
          this.database.getGuildConfig(request.guildId).language,
          "requestDenied",
        ),
      );
      return;
    }

    const guild = interaction.guild;
    const [requester, role] = await Promise.all([
      guild.members.fetch(request.requesterId).catch(() => null),
      guild.roles.fetch(request.roleId),
    ]);
    const currentChannels = this.database.getRoleChannels(
      request.guildId,
      request.roleId,
    );
    const botMember = guild.members.me ?? (await guild.members.fetchMe());
    const currentConfig = this.database.getGuildConfig(request.guildId);
    const [currentApprover, targetChannel] = await Promise.all([
      guild.members.fetch(approver.id).catch(() => null),
      guild.channels.fetch(request.targetChannelId).catch(() => null),
    ]);
    if (
      !requester ||
      !role ||
      !currentApprover ||
      !currentApprover.roles.cache.has(request.roleId) ||
      currentApprover.voice.channelId !== request.targetChannelId ||
      (targetChannel?.type !== ChannelType.GuildVoice &&
        targetChannel?.type !== ChannelType.GuildStageVoice) ||
      !botMember.permissions.has(PermissionFlagsBits.ManageRoles) ||
      !canAssignRole(role, guild.id, botMember.roles.highest.position) ||
      !currentChannels.includes(request.targetChannelId) ||
      requester.roles.cache.has(request.roleId)
    ) {
      await interaction.editReply(
        translate(
          this.database.getGuildConfig(request.guildId).language,
          "requesterNoLongerEligible",
        ),
      );
      return;
    }
    const now = Date.now();
    const grant: TemporaryGrant = {
      id: randomUUID(),
      requestId: request.id,
      guildId: request.guildId,
      requesterId: request.requesterId,
      roleId: request.roleId,
      authorizedChannelIds: currentChannels,
      state: "assignment_pending",
      roleExistedBefore: false,
      botOwned: false,
      ownershipUncertain: false,
      deadlineAt: null,
      createdAt: now,
      updatedAt: now,
      cleanupError: null,
    };
    const won = this.database.claimApproval(
      request.id,
      approver.id,
      now,
      grant,
    );
    if (!won) {
      await interaction.editReply(
        translate(
          this.database.getGuildConfig(request.guildId).language,
          "competingDecision",
        ),
      );
      return;
    }
    this.clearTimer(request.id);
    await this.resolveMessage(request, "approved", approver.id);
    this.scheduleMessageDeletion(
      request,
      (request.decisionAt ?? Date.now()) +
        ApprovalWorkflow.messageDeletionDelayMs,
    );
    try {
      await this.lifecycle.completeAssignment(
        grant.id,
        currentConfig.initialJoinTimeoutSeconds,
      );
      await this.notifyRequesterOfApproval(request);
      await interaction.editReply(
        translate(
          this.database.getGuildConfig(request.guildId).language,
          "requestApproved",
        ),
      );
    } catch (error) {
      log(
        "error",
        "Role assignment failed after approval; grant remains recoverable",
        {
          requestId: request.id,
          grantId: grant.id,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      await interaction.editReply(
        translate(
          this.database.getGuildConfig(request.guildId).language,
          "approvalAssignmentFailed",
        ),
      );
    }
  }

  async recover(): Promise<void> {
    for (const request of this.database.listPendingRequests()) {
      if (request.expiresAt <= Date.now()) {
        this.database.expireRequest(request.id, Date.now());
        await this.resolveMessage(request, "expired");
      } else {
        this.schedule(request.id, request.expiresAt);
      }
    }
    for (const request of this.database.listDecidedRequestsWithMessages()) {
      this.scheduleMessageDeletion(
        request,
        (request.decisionAt ?? Date.now()) +
          ApprovalWorkflow.messageDeletionDelayMs,
      );
    }
  }

  async cancelRequest(request: AccessRequest): Promise<boolean> {
    const cancelled = this.database.decideRequest(
      request.id,
      "cancelled",
      null,
      Date.now(),
    );
    if (!cancelled) return false;
    this.clearTimer(request.id);
    await this.resolveMessage(request, "cancelled");
    return true;
  }

  private schedule(requestId: string, expiresAt: number): void {
    this.clearTimer(requestId);
    const timer = setTimeout(
      () => {
        this.timers.delete(requestId);
        void this.expire(requestId).catch((error: unknown) =>
          log("error", "Request expiration failed", {
            requestId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      },
      Math.max(0, Math.min(expiresAt - Date.now(), 2_147_000_000)),
    );
    timer.unref();
    this.timers.set(requestId, timer);
  }

  private async expire(requestId: string): Promise<void> {
    const changed = this.database.expireRequest(requestId, Date.now());
    const request = this.database.getRequest(requestId);
    if (changed && request) await this.resolveMessage(request, "expired");
    else if (request?.status === "pending")
      this.schedule(request.id, request.expiresAt);
  }

  private scheduleMessageDeletion(
    request: AccessRequest,
    deleteAt: number,
  ): void {
    this.clearDeletionTimer(request.id);
    const timer = setTimeout(
      () => {
        this.deletionTimers.delete(request.id);
        void this.deleteResolvedMessage(request).catch((error: unknown) => {
          log("warn", "Could not delete resolved approval message; retrying", {
            requestId: request.id,
            error: error instanceof Error ? error.message : String(error),
          });
          this.scheduleMessageDeletion(
            request,
            Date.now() + ApprovalWorkflow.messageDeletionDelayMs,
          );
        });
      },
      Math.max(0, Math.min(deleteAt - Date.now(), 2_147_000_000)),
    );
    timer.unref();
    this.deletionTimers.set(request.id, timer);
  }

  private async deleteResolvedMessage(request: AccessRequest): Promise<void> {
    if (!request.messageId || !request.messageChannelId) return;
    try {
      const channel = await this.client.channels.fetch(
        request.messageChannelId,
      );
      if (!channel?.isTextBased() || !("messages" in channel)) {
        this.database.clearRequestMessageId(request.id);
        return;
      }
      const message = await channel.messages.fetch(request.messageId);
      await message.delete();
      this.database.clearRequestMessageId(request.id);
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? error.code
          : undefined;
      if (code === 10003 || code === 10008) {
        this.database.clearRequestMessageId(request.id);
        return;
      }
      throw error;
    }
  }

  private async resolveMessage(
    request: AccessRequest,
    status: string,
    actorId?: string,
  ): Promise<void> {
    if (!request.messageId) return;
    try {
      const channel = request.messageChannelId
        ? await this.client.channels.fetch(request.messageChannelId)
        : null;
      if (!channel?.isTextBased() || !("messages" in channel)) return;
      const message = await channel.messages.fetch(request.messageId);
      const language = this.database.getGuildConfig(request.guildId).language;
      const statusKey =
        status === "approved"
          ? "approvalApproved"
          : status === "denied"
            ? "approvalDenied"
            : status === "expired"
              ? "approvalExpired"
              : status === "cancelled"
                ? "approvalCancelled"
                : "approvalPending";
      const localizedStatus = translate(language, statusKey);
      const footer = translate(language, "requestFooter", {
        id: request.id,
        status: actorId
          ? translate(language, "decisionBy", {
              status: localizedStatus,
              user: actorId,
            })
          : localizedStatus,
      });
      const embed = message.embeds[0];
      await message.edit({
        embeds: embed
          ? [
              EmbedBuilder.from(embed).setFooter({
                text: footer,
              }),
            ]
          : [],
        components: approvalComponents(request.id, true, language),
        content: message.content,
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      log("warn", "Could not update resolved approval message", {
        requestId: request.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async notifyRequesterOfApproval(
    request: AccessRequest,
  ): Promise<void> {
    if (!request.messageChannelId) return;
    try {
      const channel = await this.client.channels.fetch(
        request.messageChannelId,
      );
      if (
        !channel?.isTextBased() ||
        !("send" in channel) ||
        typeof channel.send !== "function"
      ) {
        log("warn", "Could not notify requester of approval", {
          requestId: request.id,
          channelId: request.messageChannelId,
          reason: "Approval channel is unavailable for messages",
        });
        return;
      }
      const language = this.database.getGuildConfig(request.guildId).language;
      await channel.send({
        content: translate(language, "requesterApprovalNotice", {
          user: request.requesterId,
        }),
        allowedMentions: { users: [request.requesterId] },
      });
    } catch (error) {
      log("warn", "Could not notify requester of approval", {
        requestId: request.id,
        channelId: request.messageChannelId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private clearTimer(requestId: string): void {
    const timer = this.timers.get(requestId);
    if (timer) clearTimeout(timer);
    this.timers.delete(requestId);
  }

  private clearDeletionTimer(requestId: string): void {
    const timer = this.deletionTimers.get(requestId);
    if (timer) clearTimeout(timer);
    this.deletionTimers.delete(requestId);
  }
}
