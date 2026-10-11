import {
  ApplicationCommandType,
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";

export const requestAccessCommand = new SlashCommandBuilder()
  .setName("request-access")
  .setDescription("Request temporary access to a configured voice-channel role")
  .addStringOption((option) =>
    option
      .setName("role")
      .setDescription("The configured access role")
      .setRequired(true)
      .setAutocomplete(true),
  )
  .addChannelOption((option) =>
    option
      .setName("channel")
      .setDescription(
        "Target voice channel (required when multiple channels are configured)",
      )
      .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice),
  );

export const accessConfigCommand = new SlashCommandBuilder()
  .setName("access-config")
  .setDescription("Configure temporary voice access")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((subcommand) =>
    subcommand
      .setName("role-channel")
      .setDescription("Add a requestable role and associated voice channel")
      .addRoleOption((option) =>
        option.setName("role").setDescription("Access role").setRequired(true),
      )
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("Authorized voice channel")
          .setRequired(true)
          .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("remove-mapping")
      .setDescription("Remove a requestable role-to-channel mapping")
      .addRoleOption((option) =>
        option.setName("role").setDescription("Access role").setRequired(true),
      )
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("Mapped voice channel")
          .setRequired(true)
          .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("approver-role")
      .setDescription("Add an approver role")
      .addRoleOption((option) =>
        option
          .setName("role")
          .setDescription("Role eligible to approve")
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("remove-approver-role")
      .setDescription("Remove an approver role")
      .addRoleOption((option) =>
        option
          .setName("role")
          .setDescription("Approver role")
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("approval-channel")
      .setDescription("Set the channel where requests are posted")
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("Text channel for approval messages")
          .setRequired(true)
          .addChannelTypes(
            ChannelType.GuildText,
            ChannelType.GuildAnnouncement,
          ),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("timers")
      .setDescription("Configure request and grant timers")
      .addIntegerOption((option) =>
        option
          .setName("initial-join-seconds")
          .setDescription("Seconds to join after approval")
          .setMinValue(1)
          .setMaxValue(86400)
          .setRequired(true),
      )
      .addIntegerOption((option) =>
        option
          .setName("departure-grace-seconds")
          .setDescription("Seconds to return after leaving")
          .setMinValue(1)
          .setMaxValue(86400)
          .setRequired(true),
      )
      .addIntegerOption((option) =>
        option
          .setName("request-expiration-seconds")
          .setDescription("Seconds for an approval request to expire")
          .setMinValue(30)
          .setMaxValue(86400)
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("view")
      .setDescription("View this server's temporary access configuration"),
  );

export const accessStatusCommand = new SlashCommandBuilder()
  .setName("access-status")
  .setDescription(
    "Inspect pending requests, temporary grants, and cleanup timers",
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export const accessCancelCommand = new SlashCommandBuilder()
  .setName("access-cancel")
  .setDescription("Cancel a pending request or revoke a temporary grant")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption((option) =>
    option
      .setName("id")
      .setDescription("Request or grant ID")
      .setRequired(true),
  );

export const commandDefinitions = [
  requestAccessCommand,
  accessConfigCommand,
  accessStatusCommand,
  accessCancelCommand,
];

export const applicationCommandType = ApplicationCommandType.ChatInput;
