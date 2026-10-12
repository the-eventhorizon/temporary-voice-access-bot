# `src/services/grant-lifecycle.ts`

`GrantLifecycle` owns the temporary-role state machine, its persisted deadlines,
voice/member/role events, retryable cleanup, and safe role ownership behavior.
SQLite is authoritative; its in-memory timeout map is a wake-up optimization.

## State progression

```text
approval -> assignment_pending -> awaiting_initial_join -> active
                                      ^                    |
                                      |                    v
                                      +--- grace_period <--+
                                                   |
                                                   v
                                        expired / revoked
```

Any Discord API or reconciliation failure during assignment/cleanup can enter
`cleanup_pending`. When ownership becomes ambiguous, the service records
`ownership_uncertain` and deliberately retains the role.

### Assignment and initial join

- `completeAssignment()` serializes by grant ID and accepts only an
  `assignment_pending` record. It invokes `assignPending()`, retains a
  retryable deadline on failure, and reports success only when assignment and
  deadline persistence reach `awaiting_initial_join`.
- `assignPending()` fetches the member and role, checks Manage Roles and the
  shared role policy, verifies the member still lacks the role, adds it through
  Discord, then persists `bot_owned` and an initial-join deadline.
- A voice update to any configured authorized channel transitions
  `awaiting_initial_join` to `active` and cancels the timer. An unrelated VC
  does not satisfy the deadline.

### Active access and departure grace

- `processVoiceChange()` ignores repeated events while active and does not
  reset an existing grace deadline for further unrelated voice events.
- Leaving all authorized channels or switching to an unrelated channel starts
  a persisted `grace_period` deadline once.
- Returning to any authorized channel before the deadline transitions back to
  `active` and cancels the timer.
- At deadline, `onDeadline()` refetches the member and current voice state. It
  preserves access if the member is in an authorized channel; otherwise it
  attempts cleanup.

## Restart recovery

`initialize()`/`resumeAll()` enumerate live grants and call `reconcile()`.
Reconciliation fetches current guild, member, and role state:

- A missing assigned role ends its grant record.
- A member already in an authorized channel is active and has no timer.
- An active member outside authorized channels starts a grace timer.
- An unexpired persisted deadline is scheduled; an elapsed deadline is
  verified against fresh voice state before cleanup.
- An interrupted `assignment_pending` operation is retried only if the role
  is still absent. A role already present with unknown assignment result is
  preserved as ownership-uncertain.
- Failed fetch/assignment/cleanup becomes retryable with a 60-second deadline
  and stored error where applicable.

## Serialization and timers

`serialize(grantId, operation)` chains asynchronous work per grant so voice
events, role observations, cancellation, and timer callbacks don't mutate a
grant concurrently within this process. Database conditional updates and
unique indexes provide persistent protection for request decisions and grant
creation.

`schedule()` clears an existing timer, bounds the timeout to Node's supported
maximum delay, marks it unreferenced, and dispatches `onDeadline()`. The stored
deadline is checked again when the timer fires; early firings simply reschedule.

## Ownership safety

The requester is rejected before assignment if they already have the role.
Successful role additions are tracked by a short-lived in-memory event marker
so the resulting member-update event is not mistaken for an independent
assignment. If a later observed member update adds the same role, the grant is
marked ownership-uncertain and cleanup timers are cancelled.

Discord does not expose who assigned an already-present role. If an
administrator or another bot adds the role while it is already present, the
bot may not receive an observable role-add event. The lifecycle therefore
uses recorded provenance and event observation as best effort, preserving
access whenever it knows ownership is uncertain. It cannot perfectly detect
independent changes made while the bot is offline.

`revoke()` fetches role/member immediately before removal. It never removes a
pre-existing role or an uncertain/non-bot-owned role. If the role/member no
longer exists, the grant is ended without a removal request. Discord removal
failures are retained as `cleanup_pending`, scheduled for retry, logged, and
reported to the text channel recorded with the original request.

## Events and administration

- `onVoiceStateUpdate()` applies voice changes to all live grants for that
  member in the guild.
- `onMemberUpdate()` serializes external role additions/removals. A detected
  external role removal ends the grant; an unexpected addition marks ownership
  uncertain.
- `onMemberRemove()` ends live grants when a member leaves the guild.
- `onRoleDelete()` ends grants for a deleted access role.
- `cancel()` safely attempts manual revocation and retains/schedules failures.

Member DMs after cleanup are best effort and use the guild's configured
language. Failure to send a DM does not undo the successful role cleanup.
Administrator cleanup-failure notices are localized using that same setting.
