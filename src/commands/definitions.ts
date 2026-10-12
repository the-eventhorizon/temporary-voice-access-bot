import {
  ApplicationCommandType,
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";

export const requestAccessCommand = new SlashCommandBuilder()
  .setName("request-access")
  .setDescription("Request temporary access to a configured voice-channel role")
  .setDescriptionLocalizations({
    de: "Temporären Zugang zu einer konfigurierten Sprachkanal-Rolle anfragen",
  })
  .addStringOption((option) =>
    option
      .setName("role")
      .setDescription("The configured access role")
      .setDescriptionLocalizations({ de: "Die konfigurierte Zugangsrolle" })
      .setRequired(true)
      .setAutocomplete(true),
  )
  .addChannelOption((option) =>
    option
      .setName("channel")
      .setDescription(
        "Target voice channel (required when multiple channels are configured)",
      )
      .setDescriptionLocalizations({
        de: "Ziel-Sprachkanal (erforderlich, wenn mehrere Kanäle konfiguriert sind)",
      })
      .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice),
  );

export const accessConfigCommand = new SlashCommandBuilder()
  .setName("access-config")
  .setDescription("Configure temporary voice access")
  .setDescriptionLocalizations({ de: "Temporären Sprachzugang konfigurieren" })
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((subcommand) =>
    subcommand
      .setName("role-channel")
      .setDescription("Add a requestable role and associated voice channel")
      .setDescriptionLocalizations({
        de: "Anfragbare Rolle und zugehörigen Sprachkanal hinzufügen",
      })
      .addRoleOption((option) =>
        option
          .setName("role")
          .setDescription("Access role")
          .setDescriptionLocalizations({ de: "Zugangsrolle" })
          .setRequired(true),
      )
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("Authorized voice channel")
          .setDescriptionLocalizations({ de: "Berechtigender Sprachkanal" })
          .setRequired(true)
          .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("remove-mapping")
      .setDescription("Remove a requestable role-to-channel mapping")
      .setDescriptionLocalizations({
        de: "Zuordnung zwischen Rolle und Sprachkanal entfernen",
      })
      .addRoleOption((option) =>
        option
          .setName("role")
          .setDescription("Access role")
          .setDescriptionLocalizations({ de: "Zugangsrolle" })
          .setRequired(true),
      )
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("Mapped voice channel")
          .setDescriptionLocalizations({ de: "Zugeordneter Sprachkanal" })
          .setRequired(true)
          .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("request-panel")
      .setDescription("Post a persistent temporary access request button")
      .setDescriptionLocalizations({
        de: "Dauerhaften Button zum Anfragen temporären Zugangs posten",
      })
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("Text channel where members can request access")
          .setDescriptionLocalizations({
            de: "Textkanal, in dem Mitglieder Zugang anfragen können",
          })
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
      .setDescriptionLocalizations({
        de: "Timer für Anfragen und Zugangsfreigaben konfigurieren",
      })
      .addIntegerOption((option) =>
        option
          .setName("initial-join-seconds")
          .setDescription("Seconds to join after approval")
          .setDescriptionLocalizations({
            de: "Sekunden für den Beitritt nach Genehmigung",
          })
          .setMinValue(1)
          .setMaxValue(86400)
          .setRequired(true),
      )
      .addIntegerOption((option) =>
        option
          .setName("departure-grace-seconds")
          .setDescription("Seconds to return after leaving")
          .setDescriptionLocalizations({
            de: "Sekunden für die Rückkehr nach dem Verlassen",
          })
          .setMinValue(1)
          .setMaxValue(86400)
          .setRequired(true),
      )
      .addIntegerOption((option) =>
        option
          .setName("request-expiration-seconds")
          .setDescription("Seconds for an approval request to expire")
          .setDescriptionLocalizations({
            de: "Sekunden bis zum Ablauf einer Zugangs-Anfrage",
          })
          .setMinValue(30)
          .setMaxValue(86400)
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("language")
      .setDescription("Set the bot's language for this server")
      .setDescriptionLocalizations({
        de: "Sprache des Bots für diesen Server festlegen",
      })
      .addStringOption((option) =>
        option
          .setName("language")
          .setDescription("Choose English or German")
          .setDescriptionLocalizations({ de: "Englisch oder Deutsch wählen" })
          .setRequired(true)
          .addChoices(
            { name: "English", value: "en" },
            { name: "Deutsch", value: "de" },
          ),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("view")
      .setDescription("View this server's temporary access configuration")
      .setDescriptionLocalizations({
        de: "Konfiguration des temporären Zugangs für diesen Server anzeigen",
      }),
  );

export const accessStatusCommand = new SlashCommandBuilder()
  .setName("access-status")
  .setDescription(
    "Inspect pending requests, temporary grants, and cleanup timers",
  )
  .setDescriptionLocalizations({
    de: "Offene Anfragen, temporäre Freigaben und Bereinigungs-Timer anzeigen",
  })
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export const accessCancelCommand = new SlashCommandBuilder()
  .setName("access-cancel")
  .setDescription("Cancel a pending request or revoke a temporary grant")
  .setDescriptionLocalizations({
    de: "Offene Anfrage abbrechen oder temporäre Freigabe widerrufen",
  })
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption((option) =>
    option
      .setName("id")
      .setDescription("Request or grant ID")
      .setDescriptionLocalizations({ de: "Anfrage- oder Freigabe-ID" })
      .setRequired(true),
  );

export const commandDefinitions = [
  requestAccessCommand,
  accessConfigCommand,
  accessStatusCommand,
  accessCancelCommand,
];

export const applicationCommandType = ApplicationCommandType.ChatInput;
