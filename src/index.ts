import { Client, Events, GatewayIntentBits, REST, Routes } from "discord.js";
import { config } from "./config.js";
import { commandDefinitions } from "./commands/definitions.js";
import { AccessDatabase } from "./persistence/database.js";
import { ApprovalWorkflow } from "./interactions/approval.js";
import { InteractionHandler } from "./interactions/handler.js";
import { GrantLifecycle } from "./services/grant-lifecycle.js";
import { log } from "./logger.js";

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
});
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
      const message =
        "An unexpected error occurred. Please try again or contact an administrator.";
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
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", "Shutting down", { signal });
  client.destroy();
  database.close();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

client.login(config.DISCORD_TOKEN).catch((error: unknown) => {
  log("error", "Discord login failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  database.close();
  process.exitCode = 1;
});
