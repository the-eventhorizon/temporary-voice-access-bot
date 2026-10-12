# `src/commands/definitions.ts`

This module declares the Discord application-command schemas and exports the
command list used by the startup registrar in [`index.md`](../index.md). It
does not run command logic; dispatch and validation live in
[`interactions/handler.md`](../interactions/handler.md).

## Commands defined here

### `/request-access`

- `role` is a required string option with autocomplete. Discord does not allow
  autocomplete on role-typed options, so values are role IDs provided by
  `InteractionHandler.handleAutocomplete`. The command handler verifies that
  the ID still names an enabled, assignable role.
- `channel` is an optional guild voice/stage channel. It is required at runtime
  if the selected role has multiple mapped voice channels. If there is only one
  mapping, the handler selects it automatically.

### `/access-config`

The root command declares Administrator as its default required permission.
Its subcommands are:

| Subcommand       | Effect                                                                                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `role-channel`   | Add an assignable role-to-voice-channel mapping. A role can map to multiple channels; a voice channel can map to only one role.                          |
| `remove-mapping` | Remove one role/channel mapping. Removing a role's last mapping also makes it unavailable to request.                                                    |
| `request-panel`  | Post a persistent button in a selected text or announcement channel.                                                                                     |
| `timers`         | Set initial-join, departure-grace, and request-expiration durations, each between 1 and 86,400 seconds (request expiration has a 30-second lower bound). |
| `language`       | Set the server's user-facing language to English or German.                                                                                              |
| `view`           | Display mappings, timer values, and the approval policy.                                                                                                 |

The handler also checks Administrator at runtime; command metadata alone is not
the authorization boundary. Command names and option names remain stable for
interaction handling, while command and option descriptions provide German
localizations for Discord clients using German.

### `/access-status`

Administrator-only command for inspecting pending requests, live temporary
grants, deadlines, and cleanup errors. The returned data is ephemeral.

### `/access-cancel`

Administrator-only command. Its `id` string can identify a pending request or
a grant ID/request ID. The interaction handler resolves which record it names
and either cancels the request or asks the lifecycle service to revoke the
temporary grant.

## Registration and edits

`commandDefinitions` is the canonical registration list. `index.ts` converts
each builder to JSON and replaces the application's current guild command set
or global command set. Add/remove command options here and implement their
behavior in the interaction handler. Discord clients may temporarily show
stale cached command options after registration changes.

`applicationCommandType` is an exported chat-input enum value; registration
uses the command builders directly.
