# `src/persistence/database.ts`

`AccessDatabase` is the SQLite persistence boundary. It opens the configured
file with `better-sqlite3`, enables foreign keys and WAL journaling, applies
ordered migrations using `PRAGMA user_version`, and exposes typed operations
for server settings, role/channel policy, requests, and grants.

## Schema and constraints

The schema contains:

- `guild_config`: per-guild language (`en` or `de`) and timer
  defaults/overrides.
- `requestable_roles`: roles explicitly enabled for requests.
- `role_channels`: one or more target channels per role. The implementation
  ensures a given channel belongs to at most one access role.
- `access_requests`: requester, target, status, timestamps, approval message
  location, and decision metadata.
- `temporary_grants`: one grant per approval, authorized voice channels,
  ownership flags, lifecycle state, deadline, and cleanup error.

Partial unique indexes enforce one pending request and one live grant for a
member/role pair. `claimApproval()` wraps the pending-to-approved transition
and grant insertion in a SQLite transaction, so concurrent decisions cannot
both win.

## Migrations

Migrations run in array order inside individual transactions:

1. Create the original tables and indexes. The initial schema included
   `approver_roles` and `guild_config.approval_channel_id`.
2. Drop the separate `approver_roles` table after approvers became the
   requested access role.
3. Drop `approval_channel_id` after requests began posting in their originating
   text channel.
4. Add the per-guild language column, defaulting existing and new servers to
   English.

The version is advanced only with the migration transaction. Existing
installations retain their other configuration and request history.

## Public operations

### Guild and mapping configuration

- `getGuildConfig(guildId)` creates a guild row with constructor-supplied
  timer defaults and English language if absent, then returns persisted values.
- `updateGuildConfig(guildId, update)` merges specified language/timer values
  and persists them.
- `addRequestableRole` and `removeRequestableRole` toggle role eligibility.
- `addRoleChannel` transactionally ensures no different role already owns the
  channel, registers the role, and inserts the mapping.
- `removeRoleChannel` removes one mapping and removes role eligibility when
  that was its final target channel.
- `getRequestableRoles`, `getRoleChannels`, `getRoleForChannel`, and
  `getAllRoleMappings` provide policy lookups. A channel lookup returns a role
  only when exactly one mapping exists.

### Requests

- `createRequest` inserts a new pending request. Database uniqueness handles
  races that pass earlier user-facing checks.
- `setRequestMessageId` records the channel/message needed to update buttons
  during recovery or resolution. The reference is cleared once an approved or
  denied request message has been deleted.
- `getRequest`, `listRequests`, and `listPendingRequests` load request records.
- `listDecidedRequestsWithMessages` returns approved/denied messages awaiting
  cleanup; `clearRequestMessageId` marks the message as deleted or unavailable.
- `hasRecentRequest` supports the request spam cooldown.
- `decideRequest` conditionally applies denial/cancellation or another
  non-approval decision only while the request is pending and not expired.
- `claimApproval` atomically changes request status to approved and inserts an
  `assignment_pending` grant.
- `expireRequest` conditionally expires only pending requests whose deadline
  has elapsed.

### Grants

- `createGrant`, `getGrant`, and `getGrantByRequest` write/read grant records.
- `getLiveGrant` and `listLiveGrants` treat assignment, active, cleanup, and
  uncertain-ownership states as live.
- `listGrants` returns guild history for administrative status.
- `updateGrant` conditionally changes a live grant's state, deadline, update
  time, and cleanup error.
- `confirmRoleAssigned` records successful assignment and starts the initial
  join deadline.
- `markOwnershipUncertain` permanently records conservative ownership state
  for eligible active states.

`close()` closes the native SQLite connection. File creation and directory
creation occur in the constructor; transaction and SQL errors propagate to
callers for contextual handling.
