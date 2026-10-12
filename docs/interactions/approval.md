# `src/interactions/approval.ts`

This module implements the posted approval message, Accept/Deny button
authorization, single-winner decisions, expiration, and approval-message
recovery. Temporary role state transitions are delegated to
[`grant-lifecycle.md`](../services/grant-lifecycle.md); atomic writes are
provided by [`database.md`](../persistence/database.md).

## Approval UI

`approvalComponents(requestId, disabled, language)` creates one action row
containing localized Accept and Deny buttons with request-specific custom IDs.
The locale is read from the request guild configuration:

- `access:accept:<request-id>`
- `access:deny:<request-id>`

Resolved or expired requests use the same IDs with both buttons disabled.

`postRequest(request, channel, roleName)` posts a localized embed showing
requester, requested role, target channel, expiration, request ID, and pending
status. Before posting, it fetches the target voice channel and selects members
currently in it who hold the requested access role. It pings only those users,
with a maximum of 100 mentions; it never pings the entire role. If the channel
cannot be fetched, the bot logs a warning and posts without notifying anyone.
The message is posted to the target voice channel's attached text chat. The
approval message IDs are persisted and request expiry is scheduled.

After an approval or denial, the decision is shown with disabled buttons for
30 seconds, then the approval message is deleted. The deletion deadline is
derived from the persisted decision timestamp; startup recovery resumes or
performs overdue deletions. If Discord temporarily rejects deletion, the
message reference remains persisted and deletion is retried. Expired and
administrator-cancelled requests are not automatically deleted.

## Button decision flow

`handleButton(interaction)` proceeds through these guards:

1. Parse a valid action and request ID; require a guild interaction.
2. Acknowledge ephemerally, load the request, verify guild and pending status,
   and immediately expire it if its persisted deadline has elapsed.
3. Fetch the clicking member. Require the requested access role and current
   presence in the exact target voice channel. An ineligible click only gets
   an ephemeral rejection; it does not change the request or disable its
   buttons, so an eligible member can still decide it.
4. For Deny, atomically apply `denied`; if another decision/expiry won, report
   that no decision was made. On success disable the buttons and record who
   denied.
5. For Accept, fetch the requester, role, current approver, and target channel.
   Recheck approver role and VC, channel type, bot Manage Roles and hierarchy,
   request mapping, requester membership, and that the requester does not
   already have the role.
6. Build a temporary grant in `assignment_pending`, atomically claim approval
   and persist the grant, then disable the buttons.
7. Ask `GrantLifecycle.completeAssignment()` to assign the role and persist its
   initial-join deadline. The user is told only that assignment succeeded after
   the Discord API call succeeds. Failures leave the grant recoverable and are
   logged.

The button handler's initial check provides immediate feedback; acceptance
re-fetches the approver and rechecks its role/voice conditions just before the
grant decision. The database conditional transition prevents duplicate or
concurrent clicks from winning.

## Expiration and recovery

- `recover()` checks every pending request after startup. Expired requests are
  marked expired and their messages updated; unexpired requests receive a new
  in-memory timer for their persisted deadline.
- `schedule()` sets a bounded Node timer as an optimization, calls `unref()`,
  and routes callback errors to structured logging.
- `expire()` uses a conditional database update. If it fired early, it
  re-schedules against the stored deadline.
- `cancelRequest()` atomically cancels a pending request and disables its
  controls.
- `resolveMessage()` fetches the stored message and disables its components,
  recording status/actor in the embed footer. A deleted/unavailable message
  produces a warning; the database decision remains authoritative.

## Operational note

The target voice channel's attached text chat is stored with the approval
message. Message updates and cleanup notices therefore use that same chat.
