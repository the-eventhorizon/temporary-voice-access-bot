# Temporary Voice Access Bot

A TypeScript/discord.js bot that grants configured Discord roles temporarily after approval from an authorized member currently in the requested voice channel. Requests can be submitted from anywhere; the bot does not use a waiting-room channel.

## Architecture and lifecycle

- `src/commands` defines the slash-command schemas. `src/interactions` handles requests, role autocomplete, administrative configuration, and approval buttons.
- `src/services/grant-lifecycle.ts` serializes grant transitions per grant, watches voice/role events, resumes persisted deadlines, and retries failed cleanup.
- `src/persistence/database.ts` owns the SQLite schema and migration version. SQLite is the source of truth; in-memory timers are only wake-up optimizations.
- `src/config.ts` validates environment variables and `src/logger.ts` emits structured JSON logs.

Requests transition from `pending` to `approved`, `denied`, `expired`, or `cancelled`. A successful approval creates an `assignment_pending` grant before calling Discord, making interrupted assignment recoverable. Grants transition through `awaiting_initial_join`, `active`, and `grace_period`, then to `expired` or `revoked`; failed cleanup stays retryable in `cleanup_pending`. Ambiguous role ownership is retained in `ownership_uncertain` for administrator review.

SQLite stores guild timer/approval settings, configured role-to-voice-channel mappings, request and message IDs, decisions, role ownership observations, grant states, and deadline timestamps. The DB is created at `DATABASE_PATH`; SQLite WAL mode and foreign keys are enabled. Schema upgrades use `PRAGMA user_version`.

## Requirements and setup

- Node.js 22 LTS and npm.
- A Discord application and bot. In the [Developer Portal](https://discord.com/developers/applications), enable the **Server Members Intent** under Bot → Privileged Gateway Intents. Guilds, guild members, and guild voice states are the only gateway intents requested by this project.

```sh
npm ci
cp .env.example .env
# Edit .env with the bot token and application ID.
npm run dev
```

To build and run the production JavaScript:

```sh
npm run build
npm start
```

For a test server, set `DISCORD_DEFAULT_GUILD_ID` to register slash commands immediately in that guild. Leave it blank to register globally; global command propagation can take longer. The bot registers its application commands on startup.

## Bot permissions and invitation

Invite the application with the `bot` and `applications.commands` OAuth scopes and only these permissions:

- View Channels
- Send Messages
- Embed Links
- Read Message History
- Manage Roles

The bot's highest role must be above every requestable access role. Do not grant Administrator. The channel where a request is started (the command channel or the panel channel) must permit the bot to view, send, embed, and read message history. Enable the Server Members privileged intent in the Developer Portal before running the bot.

## Environment variables

| Variable                         | Required | Default                    | Description                                                      |
| -------------------------------- | -------- | -------------------------- | ---------------------------------------------------------------- |
| `DISCORD_TOKEN`                  | Yes      | —                          | Bot token; keep it private and out of source control.            |
| `DISCORD_APPLICATION_ID`         | Yes      | —                          | Discord application/client ID.                                   |
| `DISCORD_DEFAULT_GUILD_ID`       | No       | Global commands            | Optional guild for rapid command registration.                   |
| `DATABASE_PATH`                  | No       | `./data/access-bot.sqlite` | Persistent SQLite database file.                                 |
| `INITIAL_JOIN_TIMEOUT_SECONDS`   | No       | `90`                       | Default initial-join timeout for newly configured guilds.        |
| `DEPARTURE_GRACE_PERIOD_SECONDS` | No       | `90`                       | Default grace period for newly configured guilds.                |
| `REQUEST_EXPIRATION_SECONDS`     | No       | `300`                      | Default approval-request expiration for newly configured guilds. |
| `LOG_LEVEL`                      | No       | `info`                     | `debug`, `info`, `warn`, or `error`.                             |

Per-server timer values are persisted and changed with `/access-config timers`; changing environment defaults does not overwrite existing guild configuration.

The bot's user-facing language is configured separately for each server. New server configurations default to English; use `/access-config language language:Deutsch` or choose **English** to switch it. The setting is stored in SQLite and applies to generated command responses, approval messages, and lifecycle notifications. Existing request-panel messages are not edited when the language changes, but new interactions use the current setting.

## Commands

- `/request-access role:<autocomplete> [channel:<voice channel>]` submits a request. The optional channel is required when the selected role has multiple configured target channels.
- `/access-config role-channel role:<role> channel:<voice channel>` registers a requestable role/channel mapping. Repeat for additional channels; each voice channel can be assigned to only one access role.
- `/access-config remove-mapping role:<role> channel:<voice channel>` removes one mapping; the role stops being requestable when its final mapping is removed.
- `/access-config request-panel channel:<text channel>` posts a persistent **Request access** button. Members click it and choose a voice channel from an ephemeral menu; its uniquely mapped role is requested automatically, using the normal validation and approval workflow.
- `/access-config timers initial-join-seconds:<n> departure-grace-seconds:<n> request-expiration-seconds:<n>` changes per-server timers.
- `/access-config language language:<English|Deutsch>` sets the per-server language used for bot messages. English is the default for new server configurations.
- `/access-config view` displays configured settings.
- `/access-status` displays pending requests, live grants, deadlines, and cleanup problems.
- `/access-cancel id:<request-or-grant-id>` cancels a pending request or revokes a temporary grant.

All `/access-config`, `/access-status`, and `/access-cancel` operations require the Discord Administrator permission. Configuration also validates channel types, managed/privileged roles, and bot role hierarchy. An approval message pings only members currently in the requested voice channel who hold the requested role (up to Discord's 100-user mention limit); it never pings the entire role. Members can approve or deny only while holding that exact requested role and currently occupying the request's target voice channel. Both conditions are rechecked when they click.

Repeated requests for the same role are rate-limited for 30 seconds, including after a prior request has been decided.

Approval requests are posted in the channel where `/request-access` is invoked, or in the channel containing the request panel when a member uses its button. After an approval or denial, the message displays the decision for 30 seconds and is then deleted to reduce channel clutter. This cleanup resumes after a restart; if Discord temporarily rejects deletion, the bot retries. Expired and administrator-cancelled requests remain in the channel. `/access-config view` reports the routing behavior; there is no separate approval-channel setting. The panel is a regular bot message and its button remains usable across bot restarts. Run `/access-config request-panel` again to post another copy in a different channel. Discord select menus support at most 25 options, so the panel displays up to 25 configured voice channels.

Discord only permits autocomplete for string, integer, and number slash-command options—not role-typed options. Therefore the request role is selected from Discord's dynamic string autocomplete, populated exclusively from the configured roles, and the selected role ID is revalidated on command execution. This is not treated as authorization.

## Role ownership safety limitation

The bot rejects requests when the member already has the role and records that the role was absent before its own assignment. It never removes roles known to predate a grant. It also watches member role updates; an observed independent role addition during a live grant marks ownership ambiguous and the bot preserves the role rather than removing it.

Discord does not expose role-assignment provenance. If an administrator or another bot independently adds the same role while the temporary role is already present, that change can be indistinguishable from the bot's own assignment (including if gateway events are unavailable during downtime). No implementation can reliably infer that ownership after the fact. This bot makes a best-effort observation and errs on the side of retaining access when it detects ambiguity. Inspect `ownership_uncertain` grants with `/access-status`; resolve them manually after confirming the member's access should end.

## Restart recovery, operations, and troubleshooting

On startup, the bot registers commands, expires overdue requests and disables their buttons, resumes request/grant deadlines, and reconciles each live grant against current guild membership, role assignment, and voice state. An expired deadline is never trusted by itself: current member and voice state are fetched before role removal. Failed removals remain in `cleanup_pending` with an error and retry deadline; review these with `/access-status` and check the bot's Manage Roles permission and role hierarchy.

Keep the `data` directory on persistent storage and run only one bot process against a given SQLite database. SQLite uses a local file and WAL; do not place it on an unreliable network filesystem. SIGINT/SIGTERM shut down the Discord client and close the database. Logs are JSON and do not include tokens.

Common issues:

- **Commands do not appear:** verify `DISCORD_APPLICATION_ID`, bot invitation scope `applications.commands`, and (for guild registration) `DISCORD_DEFAULT_GUILD_ID`.
- **Requests cannot be posted:** grant the bot View Channel, Send Messages, Embed Links, and Read Message History in the channel where the request command or panel is used.
- **Roles cannot be granted or removed:** grant Manage Roles and move the bot's highest role above every managed role.
- **No one can decide a request:** ensure a member has the requested access role and is currently in the exact target voice channel.
- **Member state is unavailable:** enable the Server Members privileged intent in the Developer Portal and retain the configured gateway intents.
- **A role remains after timeout:** inspect the grant state. `ownership_uncertain` is deliberate safe retention; `cleanup_pending` means Discord rejected or could not complete cleanup and will be retried.

## Tests, lint, formatting

```sh
npm test
npm run typecheck
npm run lint
npm run format:check
```

Tests use temporary SQLite files and mock Discord-facing behavior; no real 90-second waits or bot token are needed.

## Docker

Docker is optional for local development. Copy `.env.example` to `.env`, edit it, then run:

```sh
docker compose up --build -d
```

`./data` is mounted persistently at `/app/data`. Back up the database file and stop the bot before restoring an older copy.
