# `src/interactions/handler.ts`

`InteractionHandler` implements slash-command behavior, role autocomplete,
the public request panel, configuration, request submission, status, and
cancellation. Approval decisions themselves are handled by
[`approval.md`](approval.md).

## Shared request validation

The private `submitRequest(guild, requesterId, roleId, selectedChannelId)`
routine is used by both `/request-access` and the panel so
the entry points share authorization:

1. The bot must have Manage Roles; the selected role must exist, be configured,
   non-managed, non-privileged, and below the bot's highest role.
2. The selected target channel must be mapped to that role. If the role maps to
   multiple channels, command callers must select one.
3. The target must still exist and be a voice or stage channel.
4. Fetch the requester; reject if they already have the role, have a live grant,
   or requested the same role in the last 30 seconds.
5. Use the target voice channel's attached text chat for approval posting.
   Require View Channel, Send Messages, Embed Links, and Read Message History
   in that chat. The command/panel source channel is not used for approval
   routing.
6. Create a unique pending record with a configurable expiration, then post
   the approval message in the target voice channel's text chat.

Duplicate pending requests are rejected by both application checks and the
database unique index. If posting fails after inserting the request, the
handler marks it cancelled and reports the failure; the error is logged with
request context.

## `/request-access` and autocomplete

`handleAutocomplete()` returns at most 25 matching configured roles, filtered
by the focused role name/ID and the bot's current role assignment capability.
Autocomplete is for convenience, not authorization: `submitRequest()` checks
the choice again.

`requestAccess()` defers an ephemeral response, invokes the shared submission
routine with the optional target voice channel, then edits the ephemeral
response with the outcome.

## Request-panel interaction

`handlePanelButton()` recognizes the persistent `access-panel:open` button.
It dynamically lists up to 25 uniquely mapped, existing voice channels whose
assigned roles remain safe to grant. It responds with an ephemeral string
select menu. The menu custom ID carries the clicker's ID and panel channel ID;
the response is ephemeral so users do not interfere with each other's
selections.

`handlePanelSelection()` verifies the selection belongs to its user and
includes a source panel channel, reads the chosen target channel, derives its
unique mapped role from SQLite, and invokes `submitRequest()`. It removes the
menu after showing the result. The selected role is never trusted from client
input because only the channel ID is selected.

## Administrator configuration

`configure()` checks Administrator permission at runtime.

- `role-channel`: refetches role and channel, validates the role can be granted
  and the channel is a voice/stage channel, then saves the mapping. A channel
  already owned by another role is refused.
- `remove-mapping`: removes a mapping, disabling its role when it no longer has
  configured channels.
- `request-panel`: posts the persistent button in a server text channel after
  checking the bot can view and send messages there.
- `timers`: persists per-guild timer values.
- `language`: switches the guild's user-facing messages between English and
  German. The selected setting is persisted in `guild_config`; existing
  approval-panel messages are not edited retroactively.
- `view`: displays mappings, timer values, and the fact that approvers are
  members with the requested access role in the exact target voice channel,
  as well as the current language.

`status()` reports up to 12 pending requests and 12 live grants, including
identifiers, members, role/channel, state, deadline, and cleanup-error marker.
Its response is ephemeral and administrator-only.

`cancel()` accepts a request ID or grant/request ID. Pending requests are
cancelled through `ApprovalWorkflow`; live grants are handled through
`GrantLifecycle.cancel()`. It reports successful revocation separately from
ownership-uncertain preservation or retryable cleanup.

## Interaction helpers

`isVoiceChannel()` accepts guild voice and stage channels. `isTextChannel()`
guards text-based channels with a send method; target voice and stage channel
chat is used for approvals, while request panels are posted to text channels.
`isSupportedApprovalChannel()` is an exported type guard wrapping that same
text-channel predicate.
