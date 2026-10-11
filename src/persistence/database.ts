import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AccessRequest, GuildConfig, TemporaryGrant } from "./types.js";

const migrations = [
  `
    CREATE TABLE guild_config (
      guild_id TEXT PRIMARY KEY,
      approval_channel_id TEXT,
      initial_join_timeout_seconds INTEGER NOT NULL DEFAULT 90 CHECK (initial_join_timeout_seconds > 0),
      departure_grace_period_seconds INTEGER NOT NULL DEFAULT 90 CHECK (departure_grace_period_seconds > 0),
      request_expiration_seconds INTEGER NOT NULL DEFAULT 300 CHECK (request_expiration_seconds > 0)
    );
    CREATE TABLE requestable_roles (
      guild_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      PRIMARY KEY (guild_id, role_id)
    );
    CREATE TABLE role_channels (
      guild_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      PRIMARY KEY (guild_id, role_id, channel_id),
      FOREIGN KEY (guild_id, role_id) REFERENCES requestable_roles(guild_id, role_id) ON DELETE CASCADE
    );
    CREATE TABLE approver_roles (
      guild_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      PRIMARY KEY (guild_id, role_id)
    );
    CREATE TABLE access_requests (
      id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      requester_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      target_channel_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','approved','denied','expired','cancelled')),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      message_channel_id TEXT,
      message_id TEXT,
      approver_id TEXT,
      decision_at INTEGER
    );
    CREATE UNIQUE INDEX one_pending_request_per_role
      ON access_requests(guild_id, requester_id, role_id) WHERE status = 'pending';
    CREATE TABLE temporary_grants (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE REFERENCES access_requests(id),
      guild_id TEXT NOT NULL,
      requester_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      authorized_channel_ids TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('assignment_pending','awaiting_initial_join','active','grace_period','cleanup_pending','ownership_uncertain','expired','revoked')),
      role_existed_before INTEGER NOT NULL,
      bot_owned INTEGER NOT NULL,
      ownership_uncertain INTEGER NOT NULL DEFAULT 0,
      deadline_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      cleanup_error TEXT
    );
    CREATE UNIQUE INDEX one_live_grant_per_role
      ON temporary_grants(guild_id, requester_id, role_id)
      WHERE state IN ('assignment_pending','awaiting_initial_join','active','grace_period','cleanup_pending','ownership_uncertain');
    CREATE INDEX grant_deadlines ON temporary_grants(state, deadline_at);
    CREATE INDEX request_deadlines ON access_requests(status, expires_at);
  `,
];

function parseRequest(row: Record<string, unknown>): AccessRequest {
  return {
    id: String(row.id),
    guildId: String(row.guild_id),
    requesterId: String(row.requester_id),
    roleId: String(row.role_id),
    targetChannelId: String(row.target_channel_id),
    status: row.status as AccessRequest["status"],
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    messageChannelId:
      row.message_channel_id === null ? null : String(row.message_channel_id),
    messageId: row.message_id === null ? null : String(row.message_id),
    approverId: row.approver_id === null ? null : String(row.approver_id),
    decisionAt: row.decision_at === null ? null : Number(row.decision_at),
  };
}

function parseGrant(row: Record<string, unknown>): TemporaryGrant {
  return {
    id: String(row.id),
    requestId: String(row.request_id),
    guildId: String(row.guild_id),
    requesterId: String(row.requester_id),
    roleId: String(row.role_id),
    authorizedChannelIds: JSON.parse(
      String(row.authorized_channel_ids),
    ) as string[],
    state: row.state as TemporaryGrant["state"],
    roleExistedBefore: Boolean(row.role_existed_before),
    botOwned: Boolean(row.bot_owned),
    ownershipUncertain: Boolean(row.ownership_uncertain),
    deadlineAt: row.deadline_at === null ? null : Number(row.deadline_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    cleanupError: row.cleanup_error === null ? null : String(row.cleanup_error),
  };
}

export class AccessDatabase {
  private readonly db: Database.Database;
  private readonly defaults: Omit<GuildConfig, "guildId" | "approvalChannelId">;

  constructor(
    path: string,
    defaults: Omit<GuildConfig, "guildId" | "approvalChannelId"> = {
      initialJoinTimeoutSeconds: 90,
      departureGracePeriodSeconds: 90,
      requestExpirationSeconds: 300,
    },
  ) {
    const absolutePath = resolve(path);
    mkdirSync(dirname(absolutePath), { recursive: true });
    this.defaults = defaults;
    this.db = new Database(absolutePath);
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("journal_mode = WAL");
    const currentVersion = Number(
      this.db.pragma("user_version", { simple: true }),
    );
    migrations.forEach((sql, index) => {
      if (index + 1 <= currentVersion) return;
      this.db.transaction(() => {
        this.db.exec(sql);
        this.db.pragma(`user_version = ${index + 1}`);
      })();
    });
  }

  close(): void {
    this.db.close();
  }

  getGuildConfig(guildId: string): GuildConfig {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO guild_config
         (guild_id, initial_join_timeout_seconds, departure_grace_period_seconds, request_expiration_seconds)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        guildId,
        this.defaults.initialJoinTimeoutSeconds,
        this.defaults.departureGracePeriodSeconds,
        this.defaults.requestExpirationSeconds,
      );
    const row = this.db
      .prepare("SELECT * FROM guild_config WHERE guild_id = ?")
      .get(guildId) as Record<string, unknown>;
    return {
      guildId,
      approvalChannelId:
        row.approval_channel_id === null
          ? null
          : String(row.approval_channel_id),
      initialJoinTimeoutSeconds: Number(row.initial_join_timeout_seconds),
      departureGracePeriodSeconds: Number(row.departure_grace_period_seconds),
      requestExpirationSeconds: Number(row.request_expiration_seconds),
    };
  }

  updateGuildConfig(
    guildId: string,
    update: Partial<Omit<GuildConfig, "guildId">>,
  ): GuildConfig {
    const current = this.getGuildConfig(guildId);
    const next = { ...current, ...update };
    this.db
      .prepare(
        `UPDATE guild_config SET approval_channel_id = ?, initial_join_timeout_seconds = ?,
         departure_grace_period_seconds = ?, request_expiration_seconds = ? WHERE guild_id = ?`,
      )
      .run(
        next.approvalChannelId,
        next.initialJoinTimeoutSeconds,
        next.departureGracePeriodSeconds,
        next.requestExpirationSeconds,
        guildId,
      );
    return next;
  }

  addRequestableRole(guildId: string, roleId: string): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO requestable_roles (guild_id, role_id) VALUES (?, ?)",
      )
      .run(guildId, roleId);
  }

  removeRequestableRole(guildId: string, roleId: string): void {
    this.db
      .prepare(
        "DELETE FROM requestable_roles WHERE guild_id = ? AND role_id = ?",
      )
      .run(guildId, roleId);
  }

  addRoleChannel(guildId: string, roleId: string, channelId: string): void {
    this.db.transaction(() => {
      this.addRequestableRole(guildId, roleId);
      this.db
        .prepare(
          "INSERT OR IGNORE INTO role_channels (guild_id, role_id, channel_id) VALUES (?, ?, ?)",
        )
        .run(guildId, roleId, channelId);
    })();
  }

  removeRoleChannel(guildId: string, roleId: string, channelId: string): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          "DELETE FROM role_channels WHERE guild_id = ? AND role_id = ? AND channel_id = ?",
        )
        .run(guildId, roleId, channelId);
      const count = this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM role_channels WHERE guild_id = ? AND role_id = ?",
        )
        .get(guildId, roleId) as { count: number };
      if (count.count === 0) this.removeRequestableRole(guildId, roleId);
    })();
  }

  addApproverRole(guildId: string, roleId: string): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO approver_roles (guild_id, role_id) VALUES (?, ?)",
      )
      .run(guildId, roleId);
  }

  removeApproverRole(guildId: string, roleId: string): void {
    this.db
      .prepare("DELETE FROM approver_roles WHERE guild_id = ? AND role_id = ?")
      .run(guildId, roleId);
  }

  getRequestableRoles(guildId: string): string[] {
    return (
      this.db
        .prepare(
          "SELECT role_id FROM requestable_roles WHERE guild_id = ? ORDER BY role_id",
        )
        .all(guildId) as { role_id: string }[]
    ).map(({ role_id }) => role_id);
  }

  getRoleChannels(guildId: string, roleId: string): string[] {
    return (
      this.db
        .prepare(
          "SELECT channel_id FROM role_channels WHERE guild_id = ? AND role_id = ? ORDER BY channel_id",
        )
        .all(guildId, roleId) as { channel_id: string }[]
    ).map(({ channel_id }) => channel_id);
  }

  getAllRoleMappings(
    guildId: string,
  ): Array<{ roleId: string; channelId: string }> {
    return (
      this.db
        .prepare(
          "SELECT role_id, channel_id FROM role_channels WHERE guild_id = ? ORDER BY role_id, channel_id",
        )
        .all(guildId) as { role_id: string; channel_id: string }[]
    ).map((row) => ({ roleId: row.role_id, channelId: row.channel_id }));
  }

  getApproverRoles(guildId: string): string[] {
    return (
      this.db
        .prepare(
          "SELECT role_id FROM approver_roles WHERE guild_id = ? ORDER BY role_id",
        )
        .all(guildId) as { role_id: string }[]
    ).map(({ role_id }) => role_id);
  }

  createRequest(request: AccessRequest): void {
    this.db
      .prepare(
        `INSERT INTO access_requests
         (id, guild_id, requester_id, role_id, target_channel_id, status, created_at, expires_at, message_id)
         VALUES (@id, @guildId, @requesterId, @roleId, @targetChannelId, @status, @createdAt, @expiresAt, @messageId)`,
      )
      .run(request);
  }

  setRequestMessageId(id: string, channelId: string, messageId: string): void {
    this.db
      .prepare(
        "UPDATE access_requests SET message_channel_id = ?, message_id = ? WHERE id = ?",
      )
      .run(channelId, messageId, id);
  }

  getRequest(id: string): AccessRequest | null {
    const row = this.db
      .prepare("SELECT * FROM access_requests WHERE id = ?")
      .get(id);
    return row ? parseRequest(row as Record<string, unknown>) : null;
  }

  hasRecentRequest(
    guildId: string,
    requesterId: string,
    roleId: string,
    since: number,
  ): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM access_requests WHERE guild_id = ? AND requester_id = ? AND role_id = ? AND created_at >= ? LIMIT 1",
        )
        .get(guildId, requesterId, roleId, since),
    );
  }

  listRequests(guildId: string): AccessRequest[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM access_requests WHERE guild_id = ? ORDER BY created_at DESC",
        )
        .all(guildId) as Record<string, unknown>[]
    ).map(parseRequest);
  }

  listPendingRequests(): AccessRequest[] {
    return (
      this.db
        .prepare("SELECT * FROM access_requests WHERE status = 'pending'")
        .all() as Record<string, unknown>[]
    ).map(parseRequest);
  }

  decideRequest(
    id: string,
    decision: "approved" | "denied" | "expired" | "cancelled",
    actorId: string | null,
    now: number,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE access_requests SET status = ?, approver_id = ?, decision_at = ?
         WHERE id = ? AND status = 'pending' AND expires_at > ?`,
      )
      .run(decision, actorId, now, id, now);
    return result.changes === 1;
  }

  claimApproval(
    id: string,
    actorId: string,
    now: number,
    grant: TemporaryGrant,
  ): boolean {
    const claim = this.db.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE access_requests SET status = 'approved', approver_id = ?, decision_at = ?
           WHERE id = ? AND status = 'pending' AND expires_at > ?`,
        )
        .run(actorId, now, id, now);
      if (result.changes !== 1) return false;
      this.db
        .prepare(
          `INSERT INTO temporary_grants
           (id, request_id, guild_id, requester_id, role_id, authorized_channel_ids, state,
            role_existed_before, bot_owned, ownership_uncertain, deadline_at, created_at, updated_at)
           VALUES (@id, @requestId, @guildId, @requesterId, @roleId, @authorizedChannelIds, @state,
            @roleExistedBefore, @botOwned, @ownershipUncertain, @deadlineAt, @createdAt, @updatedAt)`,
        )
        .run({
          ...grant,
          authorizedChannelIds: JSON.stringify(grant.authorizedChannelIds),
          roleExistedBefore: Number(grant.roleExistedBefore),
          botOwned: Number(grant.botOwned),
          ownershipUncertain: Number(grant.ownershipUncertain),
        });
      return true;
    });
    return claim();
  }

  expireRequest(id: string, now: number): boolean {
    const result = this.db
      .prepare(
        "UPDATE access_requests SET status = 'expired', decision_at = ? WHERE id = ? AND status = 'pending' AND expires_at <= ?",
      )
      .run(now, id, now);
    return result.changes === 1;
  }

  createGrant(grant: TemporaryGrant): void {
    this.db
      .prepare(
        `INSERT INTO temporary_grants
         (id, request_id, guild_id, requester_id, role_id, authorized_channel_ids, state,
          role_existed_before, bot_owned, ownership_uncertain, deadline_at, created_at, updated_at)
         VALUES (@id, @requestId, @guildId, @requesterId, @roleId, @authorizedChannelIds, @state,
          @roleExistedBefore, @botOwned, @ownershipUncertain, @deadlineAt, @createdAt, @updatedAt)`,
      )
      .run({
        ...grant,
        authorizedChannelIds: JSON.stringify(grant.authorizedChannelIds),
        roleExistedBefore: Number(grant.roleExistedBefore),
        botOwned: Number(grant.botOwned),
        ownershipUncertain: Number(grant.ownershipUncertain),
      });
  }

  getGrant(id: string): TemporaryGrant | null {
    const row = this.db
      .prepare("SELECT * FROM temporary_grants WHERE id = ?")
      .get(id);
    return row ? parseGrant(row as Record<string, unknown>) : null;
  }

  getGrantByRequest(requestId: string): TemporaryGrant | null {
    const row = this.db
      .prepare("SELECT * FROM temporary_grants WHERE request_id = ?")
      .get(requestId);
    return row ? parseGrant(row as Record<string, unknown>) : null;
  }

  getLiveGrant(
    guildId: string,
    requesterId: string,
    roleId: string,
  ): TemporaryGrant | null {
    const row = this.db
      .prepare(
        `SELECT * FROM temporary_grants WHERE guild_id = ? AND requester_id = ? AND role_id = ?
         AND state IN ('assignment_pending','awaiting_initial_join','active','grace_period','cleanup_pending','ownership_uncertain')`,
      )
      .get(guildId, requesterId, roleId);
    return row ? parseGrant(row as Record<string, unknown>) : null;
  }

  listGrants(guildId: string): TemporaryGrant[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM temporary_grants WHERE guild_id = ? ORDER BY created_at DESC",
        )
        .all(guildId) as Record<string, unknown>[]
    ).map(parseGrant);
  }

  listLiveGrants(): TemporaryGrant[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM temporary_grants WHERE state IN ('assignment_pending','awaiting_initial_join','active','grace_period','cleanup_pending','ownership_uncertain')",
        )
        .all() as Record<string, unknown>[]
    ).map(parseGrant);
  }

  updateGrant(
    id: string,
    state: TemporaryGrant["state"],
    deadlineAt: number | null,
    now: number,
    cleanupError: string | null = null,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE temporary_grants SET state = ?, deadline_at = ?, updated_at = ?, cleanup_error = ?
         WHERE id = ? AND state IN ('assignment_pending','awaiting_initial_join','active','grace_period','cleanup_pending','ownership_uncertain')`,
      )
      .run(state, deadlineAt, now, cleanupError, id);
    return result.changes === 1;
  }

  confirmRoleAssigned(id: string, deadlineAt: number, now: number): void {
    this.db
      .prepare(
        "UPDATE temporary_grants SET bot_owned = 1, state = 'awaiting_initial_join', deadline_at = ?, updated_at = ? WHERE id = ? AND state = 'assignment_pending'",
      )
      .run(deadlineAt, now, id);
  }

  markOwnershipUncertain(id: string): void {
    this.db
      .prepare(
        "UPDATE temporary_grants SET ownership_uncertain = 1, state = 'ownership_uncertain', updated_at = ? WHERE id = ? AND state IN ('awaiting_initial_join','active','grace_period')",
      )
      .run(Date.now(), id);
  }
}
