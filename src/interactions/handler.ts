import {
  ChannelType,
  PermissionFlagsBits,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type GuildBasedChannel,
  type GuildTextBasedChannel,
  type Role,
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
    const guild = interaction.guild!;
    const roleId = interaction.options.getString("role", true);
    const role = guild.roles.cache.get(roleId);
    const botMember = guild.members.me ?? (await guild.members.fetchMe());
    if (
      !botMember.permissions.has(PermissionFlagsBits.ManageRoles) ||
      !role ||
      !this.database.getRequestableRoles(guild.id).includes(roleId) ||
      !canAssignRole(role, guild.id, botMember.roles.highest.position)
    ) {
      await interaction.editReply(
        botMember.permissions.has(PermissionFlagsBits.ManageRoles)
          ? "That role is not currently configured for temporary access."
          : "The bot is missing Manage Roles permission. Contact a server administrator.",
      );
      return;
    }
    const channelIds = this.database.getRoleChannels(guild.id, roleId);
    const selectedChannelId = interaction.options.getChannel("channel")?.id;
    if (channelIds.length === 0) {
      await interaction.editReply(
        "This role has no configured target voice channel.",
      );
      return;
    }
    if (channelIds.length > 1 && !selectedChannelId) {
      await interaction.editReply(
        "Select a target channel because this role has multiple configured channels.",
      );
      return;
    }
    const targetChannelId = selectedChannelId ?? channelIds[0]!;
    if (!channelIds.includes(targetChannelId)) {
      await interaction.editReply(
        "That voice channel is not associated with the selected role.",
      );
      return;
    }
    const targetChannel = guild.channels.cache.get(targetChannelId) ?? null;
    if (!isVoiceChannel(targetChannel)) {
      await interaction.editReply(
        "The configured target channel no longer exists or is not a voice channel.",
      );
      return;
    }
    const requester = await guild.members.fetch(interaction.user.id);
    if (requester.roles.cache.has(roleId)) {
      await interaction.editReply("You already have this role.");
      return;
    }
    if (this.database.getLiveGrant(guild.id, requester.id, roleId)) {
      await interaction.editReply(
        "You already have a temporary grant for this role.",
      );
      return;
    }
    if (
      this.database.hasRecentRequest(
        guild.id,
        requester.id,
        roleId,
        Date.now() - 30_000,
      )
    ) {
      await interaction.editReply(
        "Please wait 30 seconds before submitting another request for this role.",
      );
      return;
    }
    const config = this.database.getGuildConfig(guild.id);
    if (this.database.getApproverRoles(guild.id).length === 0) {
      await interaction.editReply(
        "No approver roles are configured. Contact a server administrator.",
      );
      return;
    }
    if (!config.approvalChannelId) {
      await interaction.editReply(
        "The approval channel is not configured. Contact a server administrator.",
      );
      return;
    }
    const approvalChannel = await guild.channels.fetch(
      config.approvalChannelId,
    );
    if (
      !isTextChannel(approvalChannel) ||
      approvalChannel.guildId !== guild.id
    ) {
      await interaction.editReply(
        "The configured approval channel is unavailable. Contact an administrator.",
      );
      return;
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
      await interaction.editReply(
        "You already have a pending request for this role.",
      );
      return;
    }
    try {
      await this.approvals.postRequest(
        request,
        approvalChannel,
        this.database.getApproverRoles(guild.id),
        role.name,
      );
      await interaction.editReply(
        `Your request for **${role.name}** in <#${targetChannelId}> was sent. It expires <t:${Math.floor(request.expiresAt / 1000)}:R>.`,
      );
    } catch (error) {
      this.database.decideRequest(request.id, "cancelled", null, Date.now());
      log("error", "Could not post approval request", {
        requestId: request.id,
        guildId: guild.id,
        error: error instanceof Error ? error.message : String(error),
      });
      await interaction.editReply(
        "The request could not be delivered to the approval channel. Please contact an administrator.",
      );
    }
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
        this.database.addRoleChannel(guild.id, role.id, channel.id);
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
    if (
      subcommand === "approver-role" ||
      subcommand === "remove-approver-role"
    ) {
      const role = interaction.options.getRole("role", true);
      if (role.id === guild.id || !guild.roles.cache.has(role.id)) {
        await interaction.reply({
          content: "Select a valid role from this server.",
          ephemeral: true,
        });
        return;
      }
      if (subcommand === "approver-role")
        this.database.addApproverRole(guild.id, role.id);
      else this.database.removeApproverRole(guild.id, role.id);
      await interaction.reply({
        content: `${subcommand === "approver-role" ? "Added" : "Removed"} <@&${role.id}> ${subcommand === "approver-role" ? "as an approver role" : "from approver roles"}.`,
        ephemeral: true,
      });
      return;
    }
    if (subcommand === "approval-channel") {
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
        !permissions.has(PermissionFlagsBits.SendMessages) ||
        !permissions.has(PermissionFlagsBits.EmbedLinks) ||
        !permissions.has(PermissionFlagsBits.ReadMessageHistory)
      ) {
        await interaction.reply({
          content:
            "The bot needs View Channel, Send Messages, Embed Links, and Read Message History in that channel.",
          ephemeral: true,
        });
        return;
      }
      this.database.updateGuildConfig(guild.id, {
        approvalChannelId: channel.id,
      });
      await interaction.reply({
        content: `Approval requests will be posted in <#${channel.id}>.`,
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
      const approvers = this.database
        .getApproverRoles(guild.id)
        .map((id) => `<@&${id}>`);
      await interaction.reply({
        content: [
          `Approval channel: ${settings.approvalChannelId ? `<#${settings.approvalChannelId}>` : "not set"}`,
          `Initial join: ${settings.initialJoinTimeoutSeconds}s; departure grace: ${settings.departureGracePeriodSeconds}s; request expiration: ${settings.requestExpirationSeconds}s`,
          `Role mappings: ${mappings.join(", ") || "none"}`,
          `Approver roles: ${approvers.join(", ") || "none"}`,
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
