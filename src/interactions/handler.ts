import {
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
  type GuildBasedChannel,
  type GuildTextBasedChannel,
  type Role,
  StringSelectMenuBuilder,
  type StringSelectMenuInteraction,
} from "discord.js";
import { randomUUID } from "node:crypto";
import type { AccessDatabase } from "../persistence/database.js";
import type { AccessRequest } from "../persistence/types.js";
import type { ApprovalWorkflow } from "./approval.js";
import type { GrantLifecycle } from "../services/grant-lifecycle.js";
import { canAssignRole } from "../services/role-policy.js";
import { log } from "../logger.js";
import { translate, type TranslationKey } from "../localization.js";

function isVoiceChannel(channel: GuildBasedChannel | null): boolean {
  return (
    channel?.type === ChannelType.GuildVoice ||
    channel?.type === ChannelType.GuildStageVoice
  );
}

function isTextChannel(channel: unknown): channel is GuildTextBasedChannel {
  return Boolean(
    channel &&
    typeof channel === "object" &&
    "isTextBased" in channel &&
    typeof channel.isTextBased === "function" &&
    channel.isTextBased() &&
    "send" in channel &&
    typeof channel.send === "function",
  );
}

export class InteractionHandler {
  constructor(
    private readonly client: Client,
    private readonly database: AccessDatabase,
    private readonly approvals: ApprovalWorkflow,
    private readonly lifecycle: GrantLifecycle,
  ) {}

  private t(
    guildId: string,
    key: TranslationKey,
    values: Record<string, string | number> = {},
  ): string {
    return translate(
      this.database.getGuildConfig(guildId).language,
      key,
      values,
    );
  }

  async handleAutocomplete(
    interaction: AutocompleteInteraction,
  ): Promise<void> {
    if (interaction.commandName !== "request-access" || !interaction.guild) {
      await interaction.respond([]);
      return;
    }
    const focused = interaction.options.getFocused().toLocaleLowerCase();
    const botMember =
      interaction.guild.members.me ??
      (await interaction.guild.members.fetchMe());
    if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
      await interaction.respond([]);
      return;
    }
    const suggestions = this.database
      .getRequestableRoles(interaction.guild.id)
      .map((id) => interaction.guild!.roles.cache.get(id))
      .filter((role): role is Role => Boolean(role))
      .filter((role) =>
        canAssignRole(
          role,
          interaction.guild!.id,
          botMember.roles.highest.position,
        ),
      )
      .filter(
        (role) =>
          role.name.toLocaleLowerCase().includes(focused) ||
          role.id.includes(focused),
      )
      .slice(0, 25)
      .map((role) => ({ name: role.name.slice(0, 100), value: role.id }));
    await interaction.respond(suggestions);
  }

  async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        ephemeral: true,
      });
      return;
    }
    switch (interaction.commandName) {
      case "request-access":
        await this.requestAccess(interaction);
        return;
      case "access-config":
        await this.configure(interaction);
        return;
      case "access-status":
        await this.status(interaction);
        return;
      case "access-cancel":
        await this.cancel(interaction);
        return;
      default:
        return;
    }
  }

  private async requestAccess(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    const response = await this.submitRequest(
      interaction.guild!,
      interaction.user.id,
      interaction.options.getString("role", true),
      interaction.options.getChannel("channel")?.id,
    );
    await interaction.editReply(response);
  }

  private async submitRequest(
    guild: Guild,
    requesterId: string,
    roleId: string,
    selectedChannelId?: string,
  ): Promise<string> {
    const role = guild.roles.cache.get(roleId);
    const botMember = guild.members.me ?? (await guild.members.fetchMe());
    if (
      !botMember.permissions.has(PermissionFlagsBits.ManageRoles) ||
      !role ||
      !this.database.getRequestableRoles(guild.id).includes(roleId) ||
      !canAssignRole(role, guild.id, botMember.roles.highest.position)
    ) {
      return botMember.permissions.has(PermissionFlagsBits.ManageRoles)
        ? this.t(guild.id, "roleNotRequestable")
        : this.t(guild.id, "manageRolesMissing");
    }
    const channelIds = this.database.getRoleChannels(guild.id, roleId);
    if (channelIds.length === 0) {
      return this.t(guild.id, "noTargetChannel");
    }
    if (channelIds.length > 1 && !selectedChannelId) {
      return this.t(guild.id, "channelRequired");
    }
    const targetChannelId = selectedChannelId ?? channelIds[0]!;
    if (!channelIds.includes(targetChannelId)) {
      return this.t(guild.id, "channelNotMapped");
    }
    const targetChannel = await guild.channels
      .fetch(targetChannelId)
      .catch(() => null);
    if (!isVoiceChannel(targetChannel)) {
      return this.t(guild.id, "targetUnavailable");
    }
    const requester = await guild.members.fetch(requesterId).catch(() => null);
    if (!requester) return this.t(guild.id, "membershipUnavailable");
    if (requester.roles.cache.has(roleId)) {
      return this.t(guild.id, "alreadyHasRole");
    }
    if (this.database.getLiveGrant(guild.id, requester.id, roleId)) {
      return this.t(guild.id, "liveGrantExists");
    }
    if (
      this.database.hasRecentRequest(
        guild.id,
        requester.id,
        roleId,
        Date.now() - 30_000,
      )
    ) {
      return this.t(guild.id, "requestCooldown");
    }
    const config = this.database.getGuildConfig(guild.id);
    if (!isTextChannel(targetChannel)) {
      return this.t(guild.id, "requestChannelUnavailable");
    }
    const approvalPermissions = targetChannel.permissionsFor(botMember);
    if (
      !approvalPermissions?.has(PermissionFlagsBits.ViewChannel) ||
      !approvalPermissions.has(PermissionFlagsBits.SendMessages) ||
      !approvalPermissions.has(PermissionFlagsBits.EmbedLinks) ||
      !approvalPermissions.has(PermissionFlagsBits.ReadMessageHistory)
    ) {
      return this.t(guild.id, "requestChannelPermissions");
    }
    const now = Date.now();
    const request: AccessRequest = {
      id: randomUUID(),
      guildId: guild.id,
      requesterId: requester.id,
      roleId,
      targetChannelId,
      status: "pending",
      createdAt: now,
      expiresAt: now + config.requestExpirationSeconds * 1000,
      messageChannelId: null,
      messageId: null,
      approverId: null,
      decisionAt: null,
    };
    try {
      this.database.createRequest(request);
    } catch (error) {
      log("warn", "Duplicate or conflicting access request rejected", {
        guildId: guild.id,
        requesterId: requester.id,
        roleId,
        error: error instanceof Error ? error.message : String(error),
      });
      return this.t(guild.id, "duplicateRequest");
    }
    try {
      await this.approvals.postRequest(request, targetChannel, role.name);
      return this.t(guild.id, "requestSent", {
        role: role.name,
        channel: targetChannelId,
        expires: Math.floor(request.expiresAt / 1000),
      });
    } catch (error) {
      this.database.decideRequest(request.id, "cancelled", null, Date.now());
      log("error", "Could not post approval request", {
        requestId: request.id,
        guildId: guild.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return this.t(guild.id, "postFailed");
    }
  }

  async handlePanelButton(interaction: ButtonInteraction): Promise<void> {
    if (
      interaction.customId !== "access-panel:open" ||
      !interaction.guild ||
      !interaction.channelId
    ) {
      await interaction.reply({
        content: this.t(interaction.guild?.id ?? "", "panelInvalid"),
        ephemeral: true,
      });
      return;
    }
    const botMember =
      interaction.guild.members.me ??
      (await interaction.guild.members.fetchMe());
    if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
      await interaction.reply({
        content: this.t(interaction.guild.id, "manageRolesMissing"),
        ephemeral: true,
      });
      return;
    }
    const channelChoices = this.database
      .getAllRoleMappings(interaction.guild.id)
      .filter(
        (mapping) =>
          this.database.getRoleForChannel(
            interaction.guild!.id,
            mapping.channelId,
          ) === mapping.roleId,
      )
      .map((mapping) => ({
        ...mapping,
        channel: interaction.guild!.channels.cache.get(mapping.channelId),
        role: interaction.guild!.roles.cache.get(mapping.roleId),
      }))
      .filter(
        (mapping) =>
          isVoiceChannel(mapping.channel ?? null) &&
          mapping.role !== undefined &&
          canAssignRole(
            mapping.role,
            interaction.guild!.id,
            botMember.roles.highest.position,
          ),
      )
      .slice(0, 25);
    if (channelChoices.length === 0) {
      await interaction.reply({
        content: this.t(interaction.guild.id, "noAssignableRoles"),
        ephemeral: true,
      });
      return;
    }
    await interaction.reply({
      content: this.t(interaction.guild.id, "chooseVoiceChannel"),
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(
              `access-panel:channel:${interaction.user.id}:${interaction.channelId}`,
            )
            .setPlaceholder(
              this.t(interaction.guild.id, "voiceChannelPlaceholder"),
            )
            .addOptions(
              channelChoices.map(({ channel, role }) => ({
                label: channel!.name.slice(0, 100),
                description: this.t(
                  interaction.guild!.id,
                  "roleRequestDescription",
                  {
                    role: role!.name,
                  },
                ).slice(0, 100),
                value: channel!.id,
              })),
            ),
        ),
      ],
      ephemeral: true,
    });
  }

  async handlePanelSelection(
    interaction: StringSelectMenuInteraction,
  ): Promise<void> {
    if (!interaction.guild || !interaction.customId.startsWith("access-panel:"))
      return;
    const [, selectionType, ownerId, sourceChannelId] =
      interaction.customId.split(":");
    if (
      selectionType !== "channel" ||
      ownerId !== interaction.user.id ||
      !sourceChannelId
    ) {
      await interaction.reply({
        content: this.t(interaction.guild.id, "panelSelectionInvalid"),
        ephemeral: true,
      });
      return;
    }
    const targetChannelId = interaction.values[0];
    if (!targetChannelId) {
      await interaction.update({
        content: this.t(interaction.guild.id, "chooseTargetChannel"),
        components: [],
      });
      return;
    }
    const roleId = this.database.getRoleForChannel(
      interaction.guild.id,
      targetChannelId,
    );
    if (!roleId) {
      await interaction.update({
        content: this.t(interaction.guild.id, "mappingNoLongerValid"),
        components: [],
      });
      return;
    }
    const response = await this.submitRequest(
      interaction.guild,
      interaction.user.id,
      roleId,
      targetChannelId,
    );
    await interaction.update({ content: response, components: [] });
  }

  private async configure(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    if (
      !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
    ) {
      await interaction.reply({
        content: this.t(interaction.guild!.id, "adminOnly"),
        ephemeral: true,
      });
      return;
    }
    const guild = interaction.guild!;
    const subcommand = interaction.options.getSubcommand();
    const botMember = guild.members.me ?? (await guild.members.fetchMe());
    if (subcommand === "role-channel" || subcommand === "remove-mapping") {
      const selectedRole = interaction.options.getRole("role", true);
      const selectedChannel = interaction.options.getChannel("channel", true);
      const role = await guild.roles.fetch(selectedRole.id);
      const channel = await guild.channels.fetch(selectedChannel.id);
      if (!role || !channel) {
        await interaction.reply({
          content: this.t(guild.id, "selectedRoleUnavailable"),
          ephemeral: true,
        });
        return;
      }
      if (subcommand === "role-channel") {
        if (
          !botMember.permissions.has(PermissionFlagsBits.ManageRoles) ||
          !canAssignRole(role, guild.id, botMember.roles.highest.position)
        ) {
          await interaction.reply({
            content: this.t(guild.id, "roleNotSafe"),
            ephemeral: true,
          });
          return;
        }
        if (!isVoiceChannel(channel)) {
          await interaction.reply({
            content: this.t(guild.id, "voiceChannelRequired"),
            ephemeral: true,
          });
          return;
        }
        try {
          this.database.addRoleChannel(guild.id, role.id, channel.id);
        } catch (error) {
          await interaction.reply({
            content:
              error instanceof Error &&
              error.message.includes("already assigned")
                ? this.t(guild.id, "channelAlreadyMapped")
                : this.t(guild.id, "mappingSaveFailed"),
            ephemeral: true,
          });
          return;
        }
        await interaction.reply({
          content: this.t(guild.id, "mappingAdded", {
            role: role.id,
            channel: channel.id,
          }),
          ephemeral: true,
        });
        return;
      }
      this.database.removeRoleChannel(guild.id, role.id, channel.id);
      await interaction.reply({
        content: this.t(guild.id, "mappingRemoved", {
          role: role.id,
          channel: channel.id,
        }),
        ephemeral: true,
      });
      return;
    }
    if (subcommand === "request-panel") {
      const channel = interaction.options.getChannel("channel", true);
      if (!isTextChannel(channel) || channel.guildId !== guild.id) {
        await interaction.reply({
          content: this.t(guild.id, "panelTextChannel"),
          ephemeral: true,
        });
        return;
      }
      const permissions = channel.permissionsFor(botMember);
      if (
        !permissions?.has(PermissionFlagsBits.ViewChannel) ||
        !permissions.has(PermissionFlagsBits.SendMessages)
      ) {
        await interaction.reply({
          content: this.t(guild.id, "panelPermissions"),
          ephemeral: true,
        });
        return;
      }
      await channel.send({
        content: this.t(guild.id, "panelContent"),
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId("access-panel:open")
              .setLabel(this.t(guild.id, "requestButton"))
              .setStyle(ButtonStyle.Primary),
          ),
        ],
        allowedMentions: { parse: [] },
      });
      await interaction.reply({
        content: this.t(guild.id, "panelPosted", { channel: channel.id }),
        ephemeral: true,
      });
      return;
    }
    if (subcommand === "timers") {
      const initialJoinTimeoutSeconds = interaction.options.getInteger(
        "initial-join-seconds",
        true,
      );
      const departureGracePeriodSeconds = interaction.options.getInteger(
        "departure-grace-seconds",
        true,
      );
      const requestExpirationSeconds = interaction.options.getInteger(
        "request-expiration-seconds",
        true,
      );
      this.database.updateGuildConfig(guild.id, {
        initialJoinTimeoutSeconds,
        departureGracePeriodSeconds,
        requestExpirationSeconds,
      });
      await interaction.reply({
        content: this.t(guild.id, "timersUpdated", {
          join: initialJoinTimeoutSeconds,
          grace: departureGracePeriodSeconds,
          expiration: requestExpirationSeconds,
        }),
        ephemeral: true,
      });
      return;
    }
    if (subcommand === "language") {
      const language = interaction.options.getString("language", true);
      if (language !== "en" && language !== "de") {
        await interaction.reply({
          content: this.t(guild.id, "languageInvalid"),
          ephemeral: true,
        });
        return;
      }
      this.database.updateGuildConfig(guild.id, { language });
      await interaction.reply({
        content: this.t(
          guild.id,
          language === "de" ? "languageGermanSet" : "languageEnglishSet",
        ),
        ephemeral: true,
      });
      return;
    }
    if (subcommand === "view") {
      const settings = this.database.getGuildConfig(guild.id);
      const mappings = this.database
        .getAllRoleMappings(guild.id)
        .map((mapping) => `<@&${mapping.roleId}> → <#${mapping.channelId}>`);
      await interaction.reply({
        content: [
          this.t(guild.id, "configApprovalRouting"),
          this.t(guild.id, "configInitialTimer", {
            join: settings.initialJoinTimeoutSeconds,
            grace: settings.departureGracePeriodSeconds,
            expiration: settings.requestExpirationSeconds,
          }),
          this.t(guild.id, "configMappings", {
            mappings: mappings.join(", ") || this.t(guild.id, "configEmpty"),
          }),
          this.t(guild.id, "configApprovers"),
          this.t(guild.id, "languageConfiguration", {
            language: settings.language === "de" ? "Deutsch" : "English",
          }),
        ]
          .join("\n")
          .slice(0, 1900),
        ephemeral: true,
      });
    }
  }

  private async status(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    if (
      !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
    ) {
      await interaction.reply({
        content: this.t(interaction.guild!.id, "adminOnly"),
        ephemeral: true,
      });
      return;
    }
    const requests = this.database.listRequests(interaction.guild!.id);
    const pending = requests.filter((request) => request.status === "pending");
    const grants = this.database.listGrants(interaction.guild!.id);
    const live = grants.filter(
      (grant) => !["expired", "revoked"].includes(grant.state),
    );
    const lines = [
      this.t(interaction.guild!.id, "requestPendingStatus", {
        count: pending.length,
      }),
      ...pending.slice(0, 12).map((request) =>
        this.t(interaction.guild!.id, "requestStatusLine", {
          id: request.id,
          user: request.requesterId,
          role: request.roleId,
          channel: request.targetChannelId,
          expires: Math.floor(request.expiresAt / 1000),
        }),
      ),
      this.t(interaction.guild!.id, "grantsStatus", { count: live.length }),
      ...live.slice(0, 12).map((grant) =>
        this.t(interaction.guild!.id, "grantStatusLine", {
          id: grant.id,
          user: grant.requesterId,
          role: grant.roleId,
          state: grant.state,
          deadline: grant.deadlineAt
            ? ` until <t:${Math.floor(grant.deadlineAt / 1000)}:R>`
            : "",
          error: grant.cleanupError
            ? this.t(interaction.guild!.id, "cleanupError")
            : "",
        }),
      ),
    ];
    await interaction.reply({
      content: lines.join("\n").slice(0, 1950),
      ephemeral: true,
    });
  }

  private async cancel(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    if (
      !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
    ) {
      await interaction.reply({
        content: this.t(interaction.guild!.id, "adminOnly"),
        ephemeral: true,
      });
      return;
    }
    const id = interaction.options.getString("id", true);
    const request = this.database.getRequest(id);
    if (
      request?.guildId === interaction.guild!.id &&
      request.status === "pending"
    ) {
      const cancelled = await this.approvals.cancelRequest(request);
      await interaction.reply({
        content: cancelled
          ? this.t(interaction.guild!.id, "requestCancelled")
          : this.t(interaction.guild!.id, "requestNotPending"),
        ephemeral: true,
      });
      return;
    }
    const grant =
      this.database.getGrant(id) ?? this.database.getGrantByRequest(id);
    if (!grant || grant.guildId !== interaction.guild!.id) {
      await interaction.reply({
        content: this.t(interaction.guild!.id, "noPendingRequestOrGrant"),
        ephemeral: true,
      });
      return;
    }
    const cancelled = await this.lifecycle.cancel(grant.id);
    const updated = this.database.getGrant(grant.id);
    await interaction.reply({
      content: !cancelled
        ? this.t(interaction.guild!.id, "grantAlreadyEnded")
        : updated?.state === "revoked"
          ? this.t(interaction.guild!.id, "grantRevoked")
          : this.t(interaction.guild!.id, "cleanupNotSafe", {
              state: updated?.state ?? "unknown",
            }),
      ephemeral: true,
    });
  }
}

export function isSupportedApprovalChannel(
  channel: unknown,
): channel is GuildTextBasedChannel {
  return isTextChannel(channel);
}
