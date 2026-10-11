import {
  type Client,
  type GuildMember,
  type PartialGuildMember,
  type VoiceState,
} from "discord.js";
import type { AccessDatabase } from "../persistence/database.js";
import type { TemporaryGrant } from "../persistence/types.js";
import { log } from "../logger.js";
import { canAssignRole } from "./role-policy.js";

const keyFor = (guildId: string, userId: string, roleId: string) =>
  `${guildId}:${userId}:${roleId}`;

export class GrantLifecycle {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly ownRoleEvents = new Map<string, number>();

  constructor(
    private readonly client: Client,
    private readonly database: AccessDatabase,
  ) {}

  async initialize(): Promise<void> {
    for (const grant of this.database.listLiveGrants()) {
      await this.reconcile(grant);
    }
  }

  async roleAssigned(grantId: string, timeoutSeconds: number): Promise<void> {
    const deadline = Date.now() + timeoutSeconds * 1000;
    const grant = this.database.getGrant(grantId);
    if (!grant)
      throw new Error(`Grant ${grantId} disappeared after role assignment`);
    this.database.confirmRoleAssigned(grantId, deadline, Date.now());
    this.schedule(grantId, deadline);
  }

  async completeAssignment(
    grantId: string,
    timeoutSeconds: number,
  ): Promise<void> {
    await this.serialize(grantId, async () => {
      const grant = this.database.getGrant(grantId);
      if (!grant || grant.state !== "assignment_pending") {
        throw new Error(`Grant ${grantId} is not waiting for role assignment`);
      }
      try {
        await this.assignPending(grant, timeoutSeconds);
      } catch (error) {
        const retryAt = Date.now() + 60_000;
        this.database.updateGrant(
          grant.id,
          "assignment_pending",
          retryAt,
          Date.now(),
          String(error),
        );
        this.schedule(grant.id, retryAt);
        throw error;
      }
      const updated = this.database.getGrant(grant.id);
      if (updated?.state !== "awaiting_initial_join") {
        throw new Error(
          `Grant ${grantId} could not be assigned safely (${updated?.state ?? "missing"})`,
        );
      }
    });
  }

  async onVoiceStateUpdate(
    oldState: VoiceState,
    newState: VoiceState,
  ): Promise<void> {
    const guildId = newState.guild.id;
    const memberId = newState.id;
    const grants = this.database
      .listLiveGrants()
      .filter(
        (grant) => grant.guildId === guildId && grant.requesterId === memberId,
      );
    await Promise.all(
      grants.map((grant) =>
        this.serialize(grant.id, () =>
          this.processVoiceChange(grant, newState),
        ),
      ),
    );
  }

  async onMemberUpdate(
    oldMember: GuildMember | PartialGuildMember,
    newMember: GuildMember,
  ): Promise<void> {
    const removedRoleIds = oldMember.roles.cache
      .filter((role) => !newMember.roles.cache.has(role.id))
      .map((role) => role.id);
    const addedRoleIds = newMember.roles.cache
      .filter((role) => !oldMember.roles.cache.has(role.id))
      .map((role) => role.id);
    if (addedRoleIds.length === 0 && removedRoleIds.length === 0) return;
    for (const grant of this.database.listLiveGrants()) {
      if (
        grant.guildId !== newMember.guild.id ||
        grant.requesterId !== newMember.id
      )
        continue;
      await this.serialize(grant.id, async () => {
        const current = this.database.getGrant(grant.id);
        if (!current) return;
        if (removedRoleIds.includes(current.roleId)) {
          this.clearTimer(current.id);
          this.database.updateGrant(current.id, "revoked", null, Date.now());
          return;
        }
        if (
          !addedRoleIds.includes(current.roleId) ||
          current.state === "assignment_pending"
        )
          return;
        const key = keyFor(
          current.guildId,
          current.requesterId,
          current.roleId,
        );
        const ownEventExpiresAt = this.ownRoleEvents.get(key);
        if (
          ownEventExpiresAt !== undefined &&
          ownEventExpiresAt >= Date.now()
        ) {
          this.ownRoleEvents.delete(key);
          return;
        }
        this.ownRoleEvents.delete(key);
        this.database.markOwnershipUncertain(current.id);
        this.clearTimer(current.id);
        log(
          "warn",
          "Temporary role ownership became ambiguous; preserving role",
          {
            guildId: current.guildId,
            userId: current.requesterId,
            roleId: current.roleId,
            grantId: current.id,
          },
        );
      });
    }
  }

  onMemberRemove(guildId: string, userId: string): void {
    for (const grant of this.database.listLiveGrants()) {
      if (grant.guildId !== guildId || grant.requesterId !== userId) continue;
      this.clearTimer(grant.id);
      this.database.updateGrant(grant.id, "expired", null, Date.now());
      log("info", "Temporary grant ended because the member left the server", {
        guildId,
        userId,
        grantId: grant.id,
      });
    }
  }

  onRoleDelete(guildId: string, roleId: string): void {
    for (const grant of this.database.listLiveGrants()) {
      if (grant.guildId !== guildId || grant.roleId !== roleId) continue;
      this.clearTimer(grant.id);
      this.database.updateGrant(grant.id, "expired", null, Date.now());
      log("info", "Temporary grant ended because its role was deleted", {
        guildId,
        roleId,
        grantId: grant.id,
      });
    }
  }

  async cancel(grantId: string): Promise<boolean> {
    let found = false;
    await this.serialize(grantId, async () => {
      const grant = this.database.getGrant(grantId);
      if (!grant || grant.state === "expired" || grant.state === "revoked")
        return;
      found = true;
      try {
        await this.revoke(grant, "revoked");
      } catch (error) {
        const retryAt = Date.now() + 60_000;
        this.database.updateGrant(
          grant.id,
          "cleanup_pending",
          retryAt,
          Date.now(),
          String(error),
        );
        this.schedule(grant.id, retryAt);
        log("error", "Manual grant revocation failed and will be retried", {
          grantId: grant.id,
          error: error instanceof Error ? error.message : String(error),
        });
        await this.notifyCleanupFailure(grant, error);
      }
    });
    return found;
  }

  async resumeAll(): Promise<void> {
    for (const grant of this.database.listLiveGrants())
      await this.reconcile(grant);
  }

  private async processVoiceChange(
    grant: TemporaryGrant,
    state: VoiceState,
  ): Promise<void> {
    const latest = this.database.getGrant(grant.id);
    if (!latest) return;
    const authorized =
      state.channelId !== null &&
      latest.authorizedChannelIds.includes(state.channelId);
    const now = Date.now();
    if (authorized) {
      if (
        latest.state === "awaiting_initial_join" ||
        latest.state === "grace_period"
      ) {
        this.database.updateGrant(latest.id, "active", null, now);
        this.clearTimer(latest.id);
      }
      return;
    }
    if (latest.state === "active") {
      const config = this.database.getGuildConfig(latest.guildId);
      const deadline = now + config.departureGracePeriodSeconds * 1000;
      this.database.updateGrant(latest.id, "grace_period", deadline, now);
      this.schedule(latest.id, deadline);
    }
  }

  private async reconcile(grant: TemporaryGrant): Promise<void> {
    await this.serialize(grant.id, async () => {
      const current = this.database.getGrant(grant.id);
      if (!current) return;
      if (current.ownershipUncertain || current.roleExistedBefore) {
        this.database.updateGrant(
          current.id,
          "ownership_uncertain",
          null,
          Date.now(),
        );
        return;
      }
      try {
        const guild = await this.client.guilds.fetch(current.guildId);
        const member = await guild.members.fetch(current.requesterId);
        if (current.state === "assignment_pending") {
          if (member.roles.cache.has(current.roleId)) {
            this.database.markOwnershipUncertain(current.id);
          } else {
            await this.assignPending(current);
          }
          return;
        }
        if (!member.roles.cache.has(current.roleId)) {
          this.database.updateGrant(current.id, "expired", null, Date.now());
          this.clearTimer(current.id);
          return;
        }
        const inAuthorizedChannel =
          member.voice.channelId !== null &&
          current.authorizedChannelIds.includes(member.voice.channelId);
        if (inAuthorizedChannel) {
          if (current.state !== "active")
            this.database.updateGrant(current.id, "active", null, Date.now());
          this.clearTimer(current.id);
          return;
        }
        if (current.state === "active") {
          const deadline =
            Date.now() +
            this.database.getGuildConfig(current.guildId)
              .departureGracePeriodSeconds *
              1000;
          this.database.updateGrant(
            current.id,
            "grace_period",
            deadline,
            Date.now(),
          );
          this.schedule(current.id, deadline);
          return;
        }
        if (current.state === "cleanup_pending") {
          this.schedule(current.id, Date.now() + 1_000);
          return;
        }
        if (current.deadlineAt !== null && current.deadlineAt <= Date.now()) {
          await this.revoke(current, "expired");
          return;
        }
        if (current.deadlineAt !== null)
          this.schedule(current.id, current.deadlineAt);
      } catch (error) {
        log("error", "Grant reconciliation failed", {
          grantId: current.id,
          guildId: current.guildId,
          userId: current.requesterId,
          error: error instanceof Error ? error.message : String(error),
        });
        if (current.state !== "ownership_uncertain") {
          const retryAt = Date.now() + 60_000;
          const retryState =
            current.state === "assignment_pending"
              ? "assignment_pending"
              : "cleanup_pending";
          this.database.updateGrant(
            current.id,
            retryState,
            retryAt,
            Date.now(),
            String(error),
          );
          this.schedule(current.id, retryAt);
        }
      }
    });
  }

  private async assignPending(
    grant: TemporaryGrant,
    timeoutSeconds?: number,
  ): Promise<void> {
    const guild = await this.client.guilds.fetch(grant.guildId);
    const [member, role] = await Promise.all([
      guild.members.fetch(grant.requesterId).catch(() => null),
      guild.roles.fetch(grant.roleId),
    ]);
    if (!member || !role) {
      this.database.updateGrant(grant.id, "expired", null, Date.now());
      return;
    }
    const botMember = guild.members.me ?? (await guild.members.fetchMe());
    if (
      !botMember.permissions.has("ManageRoles") ||
      !canAssignRole(role, guild.id, botMember.roles.highest.position)
    ) {
      throw new Error(`Bot cannot safely assign role ${grant.roleId}`);
    }
    if (member.roles.cache.has(grant.roleId)) {
      this.database.markOwnershipUncertain(grant.id);
      return;
    }
    const roleEventKey = keyFor(grant.guildId, grant.requesterId, grant.roleId);
    this.ownRoleEvents.set(roleEventKey, Date.now() + 5_000);
    try {
      await member.roles.add(
        grant.roleId,
        `Temporary voice access grant ${grant.id}`,
      );
    } catch (error) {
      this.ownRoleEvents.delete(roleEventKey);
      throw error;
    }
    const timeout =
      timeoutSeconds ??
      this.database.getGuildConfig(grant.guildId).initialJoinTimeoutSeconds;
    await this.roleAssigned(grant.id, timeout);
  }

  private schedule(grantId: string, deadlineAt: number): void {
    this.clearTimer(grantId);
    const delay = Math.max(0, Math.min(deadlineAt - Date.now(), 2_147_000_000));
    const timer = setTimeout(() => {
      this.timers.delete(grantId);
      void this.onDeadline(grantId).catch((error: unknown) =>
        log("error", "Grant deadline handler failed", {
          grantId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }, delay);
    timer.unref();
    this.timers.set(grantId, timer);
  }

  private async onDeadline(grantId: string): Promise<void> {
    await this.serialize(grantId, async () => {
      const grant = this.database.getGrant(grantId);
      if (!grant || grant.deadlineAt === null) return;
      if (grant.deadlineAt > Date.now()) {
        this.schedule(grant.id, grant.deadlineAt);
        return;
      }
      if (grant.state === "ownership_uncertain" || grant.roleExistedBefore)
        return;
      try {
        if (grant.state === "assignment_pending") {
          await this.assignPending(grant);
          return;
        }
        const guild = await this.client.guilds.fetch(grant.guildId);
        const member = await guild.members.fetch(grant.requesterId);
        if (
          member.voice.channelId !== null &&
          grant.authorizedChannelIds.includes(member.voice.channelId)
        ) {
          this.database.updateGrant(grant.id, "active", null, Date.now());
          return;
        }
        await this.revoke(grant, "expired");
      } catch (error) {
        const retryAt = Date.now() + 60_000;
        const retryState =
          grant.state === "assignment_pending"
            ? "assignment_pending"
            : "cleanup_pending";
        this.database.updateGrant(
          grant.id,
          retryState,
          retryAt,
          Date.now(),
          String(error),
        );
        this.schedule(grant.id, retryAt);
        log("error", "Temporary role cleanup will be retried", {
          grantId,
          error: error instanceof Error ? error.message : String(error),
        });
        await this.notifyCleanupFailure(grant, error);
      }
    });
  }

  private async revoke(
    grant: TemporaryGrant,
    terminalState: "expired" | "revoked",
  ): Promise<void> {
    this.clearTimer(grant.id);
    const guild = await this.client.guilds.fetch(grant.guildId);
    const [member, role] = await Promise.all([
      guild.members.fetch(grant.requesterId).catch(() => null),
      guild.roles.fetch(grant.roleId).catch((error: unknown) => {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === 10011
        ) {
          return null;
        }
        throw error;
      }),
    ]);
    if (!role || !member || !member.roles.cache.has(grant.roleId)) {
      this.database.updateGrant(grant.id, terminalState, null, Date.now());
      return;
    }
    if (grant.roleExistedBefore) {
      this.database.updateGrant(grant.id, terminalState, null, Date.now());
      return;
    }
    if (grant.ownershipUncertain || !grant.botOwned) {
      this.database.updateGrant(
        grant.id,
        "ownership_uncertain",
        null,
        Date.now(),
      );
      return;
    }
    await member.roles.remove(
      grant.roleId,
      `Temporary voice access ${terminalState}: ${grant.id}`,
    );
    this.database.updateGrant(grant.id, terminalState, null, Date.now());
    try {
      await member.send(
        `Your temporary access to <#${grant.authorizedChannelIds[0]}> has ended.`,
      );
    } catch {
      log("debug", "Could not notify member of access cleanup", {
        grantId: grant.id,
        userId: grant.requesterId,
      });
    }
  }

  private clearTimer(grantId: string): void {
    const timer = this.timers.get(grantId);
    if (timer) clearTimeout(timer);
    this.timers.delete(grantId);
  }

  private async notifyCleanupFailure(
    grant: TemporaryGrant,
    error: unknown,
  ): Promise<void> {
    const channelId = this.database.getRequest(
      grant.requestId,
    )?.messageChannelId;
    if (!channelId) return;
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isTextBased() || !("send" in channel)) return;
      await channel.send({
        content:
          `Temporary access cleanup failed for grant \`${grant.id}\` (<@${grant.requesterId}>, <@&${grant.roleId}>). Cleanup will be retried; inspect with \`/access-status\`. Error: ${error instanceof Error ? error.message : String(error)}`.slice(
            0,
            1900,
          ),
        allowedMentions: { parse: [] },
      });
    } catch (notificationError) {
      log("error", "Could not notify administrators about cleanup failure", {
        grantId: grant.id,
        error:
          notificationError instanceof Error
            ? notificationError.message
            : String(notificationError),
      });
    }
  }

  private async serialize(
    id: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.locks.set(id, current);
    try {
      await current;
    } finally {
      if (this.locks.get(id) === current) this.locks.delete(id);
    }
  }
}
