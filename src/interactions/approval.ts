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

export function approvalComponents(requestId: string, disabled = false) {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`access:accept:${requestId}`)
        .setLabel("Accept")
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(`access:deny:${requestId}`)
        .setLabel("Deny")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(disabled),
    ),
  ];
}

export class ApprovalWorkflow {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly client: Client,
    private readonly database: AccessDatabase,
    private readonly lifecycle: GrantLifecycle,
  ) {}

  async postRequest(
    request: AccessRequest,
    channel: GuildTextBasedChannel,
    approverRoleIds: string[],
    roleName: string,
  ): Promise<string> {
    const approverMentions = approverRoleIds.map((id) => `<@&${id}>`).join(" ");
    const message = await channel.send({
      content: `${approverMentions}\nNew temporary access request`,
      embeds: [
        new EmbedBuilder()
          .setTitle("Voice access request")
          .setDescription(
            `Requester: <@${request.requesterId}>\nRole: <@&${request.roleId}> (${roleName})\nTarget: <#${request.targetChannelId}>\nExpires: <t:${Math.floor(request.expiresAt / 1000)}:R>`,
          )
          .setFooter({ text: `Request ID: ${request.id} • Pending` }),
      ],
      components: approvalComponents(request.id),
      allowedMentions: { users: [request.requesterId], roles: approverRoleIds },
    });
    this.database.setRequestMessageId(request.id, channel.id, message.id);
    this.schedule(request.id, request.expiresAt);
    return message.id;
  }

  async handleButton(interaction: ButtonInteraction): Promise<void> {
    const [, action, requestId] = interaction.customId.split(":");
    if (
      (action !== "accept" && action !== "deny") ||
      !requestId ||
      !interaction.guild
    ) {
      await interaction.reply({
        content: "This approval control is invalid.",
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
      await interaction.editReply("This request is no longer pending.");
      return;
    }
    if (request.expiresAt <= Date.now()) {
      this.database.expireRequest(request.id, Date.now());
      await this.resolveMessage(request, "expired");
      await interaction.editReply("This request has expired.");
      return;
    }
    const approver = await interaction.guild.members
      .fetch(interaction.user.id)
      .catch(() => null);
    const approverRoles = this.database.getApproverRoles(request.guildId);
    if (
      !approver ||
      !approverRoles.some((roleId) => approver.roles.cache.has(roleId)) ||
      approver.voice.channelId !== request.targetChannelId
    ) {
      await interaction.editReply(
        "You must have a configured approver role and be in the target voice channel.",
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
          "Another decision was already recorded, or this request expired.",
        );
        return;
      }
      this.clearTimer(request.id);
      await this.resolveMessage(request, "denied", approver.id);
      await interaction.editReply("Request denied.");
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
      !this.database
        .getApproverRoles(request.guildId)
        .some((roleId) => currentApprover.roles.cache.has(roleId)) ||
      currentApprover.voice.channelId !== request.targetChannelId ||
      (targetChannel?.type !== ChannelType.GuildVoice &&
        targetChannel?.type !== ChannelType.GuildStageVoice) ||
      !botMember.permissions.has(PermissionFlagsBits.ManageRoles) ||
      !canAssignRole(role, guild.id, botMember.roles.highest.position) ||
      !currentChannels.includes(request.targetChannelId) ||
      requester.roles.cache.has(request.roleId)
    ) {
      await interaction.editReply(
        "The requester, role, or channel is no longer eligible. No role was assigned.",
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
        "Another decision was already recorded, or this request expired.",
      );
      return;
    }
    this.clearTimer(request.id);
    await this.resolveMessage(request, "approved", approver.id);
    try {
      await this.lifecycle.completeAssignment(
        grant.id,
        currentConfig.initialJoinTimeoutSeconds,
      );
      await interaction.editReply(
        "Request approved and temporary access granted.",
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
        "The request was approved, but Discord could not assign the role yet. The bot will retry; contact an administrator if it remains unresolved.",
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
      const footer = actorId ? `${status} by ${actorId}` : status;
      const embed = message.embeds[0];
      await message.edit({
        embeds: embed
          ? [
              EmbedBuilder.from(embed).setFooter({
                text: `Request ID: ${request.id} • ${footer}`,
              }),
            ]
          : [],
        components: approvalComponents(request.id, true),
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

  private clearTimer(requestId: string): void {
    const timer = this.timers.get(requestId);
    if (timer) clearTimeout(timer);
    this.timers.delete(requestId);
  }
}
