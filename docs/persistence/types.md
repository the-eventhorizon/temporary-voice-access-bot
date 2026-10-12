# `src/persistence/types.ts`

This module defines the shared TypeScript record shapes persisted by
[`database.md`](database.md) and consumed by the interaction and lifecycle
services. It contains no runtime logic.

## State unions

`RequestStatus` enumerates request decisions:

- `pending`: awaiting a decision.
- `approved`: accepted; a temporary grant record exists.
- `denied`: rejected.
- `expired`: the request deadline elapsed before a decision.
- `cancelled`: an administrator cancelled it or posting it failed.

`GrantState` models role assignment and cleanup:

- `assignment_pending`: approval was atomically recorded, but the Discord role
  assignment may not have completed.
- `awaiting_initial_join`: role assigned; initial target-VC join deadline is
  running.
- `active`: requester is in an authorized voice channel.
- `grace_period`: requester left authorized voice; return deadline is running.
- `cleanup_pending`: role cleanup or reconciliation failed and should retry.
- `ownership_uncertain`: removing the role could remove independently granted
  access; preserve it pending review.
- `expired`: lifecycle ended by deadline, deletion, departure, or observed
  external removal.
- `revoked`: administrator cancellation completed.

## Record shapes

### `GuildConfig`

Contains the guild ID, persisted UI language (`en` or `de`), initial-join
timeout, departure grace, and request expiration durations. Values are per
guild. Approval-message channel is intentionally not a guild setting: each
request records its target voice channel's text chat in `AccessRequest`.

### `AccessRequest`

Stores unique request ID, guild/requester/role/target-channel IDs, status,
creation and expiration times (Unix milliseconds), approval message channel
(the target voice channel's text chat) and message IDs, deciding approver ID,
and decision timestamp. Message IDs may be null before posting succeeds.

### `TemporaryGrant`

Stores its ID and source request, guild/member/role, all authorized channels,
state, ownership evidence, deadline, timestamps, and the most recent cleanup
error. `roleExistedBefore` and `botOwned` distinguish known pre-existing
access from the bot's assignment; `ownershipUncertain` forces conservative
retention.

## Timestamp convention

All persisted timestamps are Unix epoch milliseconds. When displayed in
Discord timestamp markup, callers convert to whole seconds.
