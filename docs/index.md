# `src/index.ts`

The executable entry point constructs the Discord client and the application
services, registers event listeners, performs startup recovery, and handles
process shutdown.

## Client and service composition

The client requests only the `Guilds`, `GuildMembers`, and `GuildVoiceStates`
gateway intents. The member intent is privileged and must be enabled in the
Discord Developer Portal; Discord rejects gateway login if a requested
privileged intent is not authorized.

Startup creates an `AccessDatabase` using the configured SQLite path and
environment defaults for a newly initialized guild, followed by:

1. `GrantLifecycle`, which owns temporary grant timers, transitions, and
   reconciliation.
2. `ApprovalWorkflow`, which posts/updates decision messages and handles
   approval buttons.
3. `InteractionHandler`, which implements commands, autocomplete, and the
   request-panel UI.

See [`persistence/database.md`](persistence/database.md),
[`localization.md`](localization.md),
[`services/grant-lifecycle.md`](services/grant-lifecycle.md),
[`interactions/approval.md`](interactions/approval.md), and
[`interactions/handler.md`](interactions/handler.md) for those modules'
details.

## Slash-command registration

`registerCommands()` serializes `commandDefinitions` and replaces the
application's complete chat-input command collection:

- If `DISCORD_DEFAULT_GUILD_ID` is set, commands are guild-scoped for quick
  development updates.
- Otherwise, commands are registered globally, where Discord may take longer
  to propagate changes.

Removing a command from the builder and restarting replaces the registered
set, but Discord clients can cache removed command schemas temporarily.

## Startup and recovery

On `ClientReady`, the application logs the bot identity and then attempts, in
order:

1. Register slash commands.
2. `approvals.recover()` to expire overdue requests, disable their message
   buttons, and reschedule unexpired requests.
3. `lifecycle.initialize()` to fetch current Discord state for live grants and
   restore or reconcile timers.

A startup failure is logged with context. Login errors include a corrective
hint when the text indicates disallowed intents.

## Gateway event routing

- `InteractionCreate`: dispatches autocomplete, chat-input commands, request
  panel buttons, approval buttons, and panel string-select menus. Unexpected
  failures are logged and the user receives an ephemeral error when the
  interaction can still be answered.
- `VoiceStateUpdate`: delegates requester channel transitions to the lifecycle
  service.
- `GuildMemberUpdate`: delegates role additions/removals for ownership
  observation.
- `GuildMemberRemove`: ends that member's live grants because they have left
  the server.
- `GuildRoleDelete`: ends grants tied to the deleted role.

Each asynchronous gateway callback logs errors rather than silently swallowing
them.

## Shutdown

SIGINT and SIGTERM trigger a one-shot shutdown: the Discord client is destroyed
and SQLite is closed. A failed initial login also closes the database and sets
a non-zero process exit code.
