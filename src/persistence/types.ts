export type RequestStatus =
  "pending" | "approved" | "denied" | "expired" | "cancelled";
export type GrantState =
  | "assignment_pending"
  | "awaiting_initial_join"
  | "active"
  | "grace_period"
  | "cleanup_pending"
  | "ownership_uncertain"
  | "expired"
  | "revoked";

export interface GuildConfig {
  guildId: string;
  initialJoinTimeoutSeconds: number;
  departureGracePeriodSeconds: number;
  requestExpirationSeconds: number;
}

export interface AccessRequest {
  id: string;
  guildId: string;
  requesterId: string;
  roleId: string;
  targetChannelId: string;
  status: RequestStatus;
  createdAt: number;
  expiresAt: number;
  messageChannelId: string | null;
  messageId: string | null;
  approverId: string | null;
  decisionAt: number | null;
}

export interface TemporaryGrant {
  id: string;
  requestId: string;
  guildId: string;
  requesterId: string;
  roleId: string;
  authorizedChannelIds: string[];
  state: GrantState;
  roleExistedBefore: boolean;
  botOwned: boolean;
  ownershipUncertain: boolean;
  deadlineAt: number | null;
  createdAt: number;
  updatedAt: number;
  cleanupError: string | null;
}
