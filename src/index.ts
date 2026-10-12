import { Client, Events, GatewayIntentBits, REST, Routes } from "discord.js";
import { config } from "./config.js";
import { commandDefinitions } from "./commands/definitions.js";
import { AccessDatabase } from "./persistence/database.js";
import { ApprovalWorkflow } from "./interactions/approval.js";
import { InteractionHandler } from "./interactions/handler.js";
import { GrantLifecycle } from "./services/grant-lifecycle.js";
import { log } from "./logger.js";
import { translate } from "./localization.js";
import { createAdminServer, startAdminServer } from "./web/admin.js";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
  ],
});
const database = new AccessDatabase(config.DATABASE_PATH, {
  initialJoinTimeoutSeconds: config.INITIAL_JOIN_TIMEOUT_SECONDS,
  departureGracePeriodSeconds: config.DEPARTURE_GRACE_PERIOD_SECONDS,
  requestExpirationSeconds: config.REQUEST_EXPIRATION_SECONDS,
  language: "en",
});
const discordToken = config.DISCORD_TOKEN;
const lifecycle = new GrantLifecycle(client, database);
const approvals = new ApprovalWorkflow(client, database, lifecycle);
const interactions = new InteractionHandler(
  client,
  database,
  approvals,
  lifecycle,
);

async function registerCommands(): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(config.DISCORD_TOKEN);
  const body = commandDefinitions.map((command) => command.toJSON());
  if (config.DISCORD_DEFAULT_GUILD_ID) {
    await rest.put(
      Routes.applicationGuildCommands(
        config.DISCORD_APPLICATION_ID,
        config.DISCORD_DEFAULT_GUILD_ID,
      ),
      { body },
    );
  } else {
    await rest.put(Routes.applicationCommands(config.DISCORD_APPLICATION_ID), {
      body,
    });
  }
  log("info", "Slash commands registered", {
    guildId: config.DISCORD_DEFAULT_GUILD_ID || "global",
    count: body.length,
  });
}

client.once(Events.ClientReady, async (readyClient) => {
  log("info", "Discord client ready", {
    userId: readyClient.user.id,
    tag: readyClient.user.tag,
  });
  try {
    await registerCommands();
    await approvals.recover();
    await lifecycle.initialize();
  } catch (error) {
    log("error", "Startup recovery or command registration failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isAutocomplete()) {
      await interactions.handleAutocomplete(interaction);
    } else if (interaction.isChatInputCommand()) {
      await interactions.handleCommand(interaction);
    } else if (interaction.isButton()) {
      if (interaction.customId.startsWith("access-panel:")) {
        await interactions.handlePanelButton(interaction);
      } else {
        await approvals.handleButton(interaction);
      }
    } else if (interaction.isStringSelectMenu()) {
      await interactions.handlePanelSelection(interaction);
    }
  } catch (error) {
    log("error", "Interaction handler failed", {
      interactionId: interaction.id,
      commandName: interaction.isChatInputCommand()
        ? interaction.commandName
        : undefined,
      error: error instanceof Error ? error.message : String(error),
    });
    if (interaction.isRepliable()) {
      const message = interaction.guildId
        ? translate(
            database.getGuildConfig(interaction.guildId).language,
            "unexpected",
          )
        : "An unexpected error occurred. Please try again or contact an administrator.";
      if (interaction.deferred || interaction.replied) {
        await interaction
          .followUp({ content: message, ephemeral: true })
          .catch(() => undefined);
      } else {
        await interaction
          .reply({ content: message, ephemeral: true })
          .catch(() => undefined);
      }
    }
  }
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  void lifecycle
    .onVoiceStateUpdate(oldState, newState)
    .catch((error: unknown) =>
      log("error", "Voice-state lifecycle update failed", {
        guildId: newState.guild.id,
        userId: newState.id,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
});

client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
  void lifecycle.onMemberUpdate(oldMember, newMember).catch((error: unknown) =>
    log("error", "Role ownership observation failed", {
      guildId: newMember.guild.id,
      userId: newMember.id,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
});

client.on(Events.GuildMemberRemove, (member) => {
  lifecycle.onMemberRemove(member.guild.id, member.id);
});

client.on(Events.GuildRoleDelete, (role) => {
  lifecycle.onRoleDelete(role.guild.id, role.id);
});

let shuttingDown = false;
let adminServer: ReturnType<typeof createAdminServer> | undefined;
if (config.WEB_ADMIN_AUTH_SECRET) {
  adminServer = createAdminServer({
    config: {
      host: config.WEB_ADMIN_HOST,
      port: config.WEB_ADMIN_PORT,
      authHeader: config.WEB_ADMIN_AUTH_HEADER,
      authSecret: config.WEB_ADMIN_AUTH_SECRET,
    },
    database,
    client,
  });
  startAdminServer(adminServer, config.WEB_ADMIN_HOST, config.WEB_ADMIN_PORT);
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", "Shutting down", { signal });
  adminServer?.close();
  client.destroy();
  database.close();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

client.login(discordToken).catch((error: unknown) => {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const isDisallowedIntent = errorMessage
    .toLocaleLowerCase()
    .includes("disallowed intents");
  log("error", "Discord login failed", {
    error: errorMessage,
    ...(isDisallowedIntent
      ? {
          action:
            "Enable Server Members Intent in Discord Developer Portal → Application → Bot → Privileged Gateway Intents, then restart the bot.",
        }
      : {}),
  });
  database.close();
  process.exitCode = 1;
});
