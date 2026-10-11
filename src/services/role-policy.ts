import { PermissionFlagsBits, type Role } from "discord.js";

const protectedPermissions = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.ViewAuditLog,
  PermissionFlagsBits.ManageNicknames,
  PermissionFlagsBits.ManageEvents,
  PermissionFlagsBits.ManageThreads,
  PermissionFlagsBits.ManageGuildExpressions,
  PermissionFlagsBits.CreateGuildExpressions,
  PermissionFlagsBits.ManageEmojisAndStickers,
  PermissionFlagsBits.MuteMembers,
  PermissionFlagsBits.DeafenMembers,
  PermissionFlagsBits.MoveMembers,
  PermissionFlagsBits.PrioritySpeaker,
  PermissionFlagsBits.MentionEveryone,
];

export function canAssignRole(
  role: Role,
  guildId: string,
  botHighestRolePosition: number,
): boolean {
  return (
    role.id !== guildId &&
    !role.managed &&
    role.position < botHighestRolePosition &&
    !role.permissions.any(protectedPermissions)
  );
}
