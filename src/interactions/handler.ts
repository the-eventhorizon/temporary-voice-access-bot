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
      interaction.channelId ?? undefined,
    );
    await interaction.editReply(response);
  }

  private async submitRequest(
    guild: Guild,
    requesterId: string,
    roleId: string,
    selectedChannelId?: string,
    requestChannelId?: string,
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
        ? "That role is not currently configured for temporary access."
        : "The bot is missing Manage Roles permission. Contact a server administrator.";
    }
    const channelIds = this.database.getRoleChannels(guild.id, roleId);
    if (channelIds.length === 0) {
      return "This role has no configured target voice channel.";
    }
    if (channelIds.length > 1 && !selectedChannelId) {
      return "Select a target channel because this role has multiple configured channels.";
    }
    const targetChannelId = selectedChannelId ?? channelIds[0]!;
    if (!channelIds.includes(targetChannelId)) {
      return "That voice channel is not associated with the selected role.";
    }
    const targetChannel = await guild.channels
      .fetch(targetChannelId)
      .catch(() => null);
    if (!isVoiceChannel(targetChannel)) {
      return "The configured target channel no longer exists or is not a voice channel.";
    }
    const requester = await guild.members.fetch(requesterId).catch(() => null);
    if (!requester)
      return "Your server membership could not be verified. Try again.";
    if (requester.roles.cache.has(roleId)) {
      return "You already have this role.";
    }
    if (this.database.getLiveGrant(guild.id, requester.id, roleId)) {
      return "You already have a temporary grant for this role.";
    }
    if (
      this.database.hasRecentRequest(
        guild.id,
        requester.id,
        roleId,
        Date.now() - 30_000,
      )
    ) {
      return "Please wait 30 seconds before submitting another request for this role.";
    }
    const config = this.database.getGuildConfig(guild.id);
    const approvalChannel = requestChannelId
      ? await guild.channels.fetch(requestChannelId).catch(() => null)
      : null;
    if (
      !isTextChannel(approvalChannel) ||
      approvalChannel.guildId !== guild.id
    ) {
      return "This channel cannot be used for approval messages.";
    }
    const approvalPermissions = approvalChannel.permissionsFor(botMember);
    if (
      !approvalPermissions?.has(PermissionFlagsBits.ViewChannel) ||
      !approvalPermissions.has(PermissionFlagsBits.SendMessages) ||
      !approvalPermissions.has(PermissionFlagsBits.EmbedLinks) ||
      !approvalPermissions.has(PermissionFlagsBits.ReadMessageHistory)
    ) {
      return "The bot needs View Channel, Send Messages, Embed Links, and Read Message History in this channel.";
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
      return "You already have a pending request for this role.";
    }
    try {
      await this.approvals.postRequest(request, approvalChannel, role.name);
      return `Your request for **${role.name}** in <#${targetChannelId}> was sent. It expires <t:${Math.floor(request.expiresAt / 1000)}:R>.`;
    } catch (error) {
      this.database.decideRequest(request.id, "cancelled", null, Date.now());
      log("error", "Could not post approval request", {
        requestId: request.id,
        guildId: guild.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return "The request could not be posted in this channel. Please contact an administrator.";
    }
  }

  async handlePanelButton(interaction: ButtonInteraction): Promise<void> {
    if (
      interaction.customId !== "access-panel:open" ||
      !interaction.guild ||
      !interaction.channelId
    ) {
      await interaction.reply({
        content: "This request panel is invalid.",
        ephemeral: true,
      });
      return;
    }
    const botMember =
      interaction.guild.members.me ??
      (await interaction.guild.members.fetchMe());
    if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
      await interaction.reply({
        content: "The bot is missing Manage Roles permission.",
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
        content:
          "No unambiguous access voice channels are currently available to request.",
        ephemeral: true,
      });
      return;
    }
    await interaction.reply({
      content: "Choose the voice channel you want to access:",
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(
              `access-panel:channel:${interaction.user.id}:${interaction.channelId}`,
            )
            .setPlaceholder("Choose a target voice channel")
            .addOptions(
              channelChoices.map(({ channel, role }) => ({
                label: channel!.name.slice(0, 100),
                description: `Request ${role!.name}`.slice(0, 100),
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
        content: "This selection has expired or is not yours.",
        ephemeral: true,
      });
      return;
    }
    const targetChannelId = interaction.values[0];
    if (!targetChannelId) {
      await interaction.update({
        content: "Choose a target voice channel.",
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
        content:
          "This voice channel is no longer configured with exactly one access role. Contact an administrator.",
        components: [],
      });
      return;
    }
    const response = await this.submitRequest(
      interaction.guild,
      interaction.user.id,
      roleId,
      targetChannelId,
      sourceChannelId,
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
        content: "Administrator permission is required.",
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
          content: "The selected role or channel is unavailable.",
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
            content:
              "That role is managed, privileged, @everyone, or not below the bot's highest role.",
            ephemeral: true,
          });
          return;
        }
        if (!isVoiceChannel(channel)) {
          await interaction.reply({
            content: "Choose a server voice or stage channel.",
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
                ? "That voice channel is already mapped to a different access role. Each voice channel can have only one assigned request role."
                : "The role-to-channel mapping could not be saved.",
            ephemeral: true,
          });
          return;
        }
        await interaction.reply({
          content: `Configured <@&${role.id}> for <#${channel.id}>.`,
          ephemeral: true,
        });
        return;
      }
      this.database.removeRoleChannel(guild.id, role.id, channel.id);
      await interaction.reply({
        content: `Removed the mapping between <@&${role.id}> and <#${channel.id}>.`,
        ephemeral: true,
      });
      return;
    }
    if (subcommand === "request-panel") {
      const channel = interaction.options.getChannel("channel", true);
      if (!isTextChannel(channel) || channel.guildId !== guild.id) {
        await interaction.reply({
          content: "Choose a server text channel.",
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
          content:
            "The bot needs View Channel and Send Messages in that channel.",
          ephemeral: true,
        });
        return;
      }
      await channel.send({
        content:
          "**Temporary voice access**\nClick below to choose a voice channel. Members with that channel's assigned role can approve your request while in the channel.",
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId("access-panel:open")
              .setLabel("Request access")
              .setStyle(ButtonStyle.Primary),
          ),
        ],
        allowedMentions: { parse: [] },
      });
      await interaction.reply({
        content: `Posted the access request panel in <#${channel.id}>.`,
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
        content: `Timers updated: join ${initialJoinTimeoutSeconds}s, departure grace ${departureGracePeriodSeconds}s, request expiration ${requestExpirationSeconds}s.`,
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
          "Approval requests are posted where the request is started.",
          `Initial join: ${settings.initialJoinTimeoutSeconds}s; departure grace: ${settings.departureGracePeriodSeconds}s; request expiration: ${settings.requestExpirationSeconds}s`,
          `Role mappings: ${mappings.join(", ") || "none"}`,
          "Approvers: members with the requested access role who are in its target voice channel.",
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
        content: "Administrator permission is required.",
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
      `Pending requests (${pending.length}):`,
      ...pending
        .slice(0, 12)
        .map(
          (request) =>
            `• \`${request.id}\` <@${request.requesterId}> <@&${request.roleId}> <#${request.targetChannelId}> expires <t:${Math.floor(request.expiresAt / 1000)}:R>`,
        ),
      `Active/cleanup grants (${live.length}):`,
      ...live
        .slice(0, 12)
        .map(
          (grant) =>
            `• \`${grant.id}\` <@${grant.requesterId}> <@&${grant.roleId}> — ${grant.state}${grant.deadlineAt ? ` until <t:${Math.floor(grant.deadlineAt / 1000)}:R>` : ""}${grant.cleanupError ? " (cleanup error)" : ""}`,
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
        content: "Administrator permission is required.",
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
          ? "Pending request cancelled."
          : "The request is no longer pending.",
        ephemeral: true,
      });
      return;
    }
    const grant =
      this.database.getGrant(id) ?? this.database.getGrantByRequest(id);
    if (!grant || grant.guildId !== interaction.guild!.id) {
      await interaction.reply({
        content: "No pending request or temporary grant matched that ID.",
        ephemeral: true,
      });
      return;
    }
    const cancelled = await this.lifecycle.cancel(grant.id);
    const updated = this.database.getGrant(grant.id);
    await interaction.reply({
      content: !cancelled
        ? "That grant has already ended."
        : updated?.state === "revoked"
          ? "Temporary role revoked."
          : `Cleanup could not safely remove the role; grant retained as ${updated?.state ?? "unknown"} for administrator review.`,
      ephemeral: true,
    });
  }
}

export function isSupportedApprovalChannel(
  channel: unknown,
): channel is GuildTextBasedChannel {
  return isTextChannel(channel);
}
