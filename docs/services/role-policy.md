# `src/services/role-policy.ts`

This module is the shared safety check for whether the bot should be permitted
to assign a Discord role. `canAssignRole(role, guildId,
botHighestRolePosition)` returns `true` only if all of these hold:

- The role ID is not the guild ID (`@everyone`).
- The role is not managed by an integration.
- Its position is strictly below the bot's highest role position.
- The role does not carry any permission in `protectedPermissions`.

The protected set covers server administration and moderation powers, role,
channel, webhook, message, event, thread, expression/emoji, voice moderation,
audit-log, and everyone-mention permissions. This policy is called from
autocomplete, request submission, configuration, approval revalidation, and
grant assignment, rather than trusting an earlier UI check.

This helper does not check the bot's Manage Roles permission or the channel
mapping; callers check those separately. The role hierarchy and permissions
can change between interaction and assignment, so the grant lifecycle repeats
the check immediately before adding the role.
