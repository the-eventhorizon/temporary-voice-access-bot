import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ChannelType, Collection } from "discord.js";
import type {
  ButtonInteraction,
  Client,
  Guild,
  GuildMember,
  GuildTextBasedChannel,
  Role,
  StringSelectMenuInteraction,
  VoiceState,
} from "discord.js";
import { AccessDatabase } from "../src/persistence/database.js";
import type {
  AccessRequest,
  TemporaryGrant,
} from "../src/persistence/types.js";
import { GrantLifecycle } from "../src/services/grant-lifecycle.js";
import { canAssignRole } from "../src/services/role-policy.js";
import { ApprovalWorkflow } from "../src/interactions/approval.js";
import { InteractionHandler } from "../src/interactions/handler.js";

const makeDatabase = () => {
  const directory = mkdtempSync(join(tmpdir(), "access-bot-test-"));
  const database = new AccessDatabase(join(directory, "test.sqlite"));
  return {
    database,
    cleanup: () => {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
};

function makeRequest(id: string, now = Date.now()): AccessRequest {
  return {
    id,
    guildId: "guild-1",
    requesterId: "user-1",
    roleId: "role-1",
    targetChannelId: "voice-1",
    status: "pending",
    createdAt: now,
    expiresAt: now + 60_000,
    messageChannelId: null,
    messageId: null,
    approverId: null,
    decisionAt: null,
  };
}

function makeGrant(requestId: string, now = Date.now()): TemporaryGrant {
  return {
    id: `grant-${requestId}`,
    requestId,
    guildId: "guild-1",
    requesterId: "user-1",
    roleId: "role-1",
    authorizedChannelIds: ["voice-1", "voice-2"],
    state: "assignment_pending",
    roleExistedBefore: false,
    botOwned: false,
    ownershipUncertain: false,
    deadlineAt: null,
    createdAt: now,
    updatedAt: now,
    cleanupError: null,
  };
}

const voiceState = (channelId: string | null): VoiceState =>
  ({
    id: "user-1",
    channelId,
    guild: { id: "guild-1" },
  }) as VoiceState;

test("role autocomplete source contains only explicitly configured roles", (context) => {
  const { database, cleanup } = makeDatabase();
  context.after(cleanup);
  database.addRoleChannel("guild-1", "role-1", "voice-1");
  database.addRoleChannel("guild-1", "role-1", "voice-2");
  assert.deepEqual(database.getRequestableRoles("guild-1"), ["role-1"]);
  assert.deepEqual(database.getRoleChannels("guild-1", "role-1"), [
    "voice-1",
    "voice-2",
  ]);
  assert.deepEqual(database.getRequestableRoles("other-guild"), []);
});

test("requests are unique per member and role while pending", (context) => {
  const { database, cleanup } = makeDatabase();
  context.after(cleanup);
  const now = Date.now();
  database.createRequest(makeRequest("request-1", now));
  assert.throws(() => database.createRequest(makeRequest("request-2", now)));
});

test("a voice channel can be assigned to only one request role", (context) => {
  const { database, cleanup } = makeDatabase();
  context.after(cleanup);
  database.addRoleChannel("guild-1", "role-1", "voice-1");
  assert.throws(
    () => database.addRoleChannel("guild-1", "role-2", "voice-1"),
    /already assigned to role role-1/,
  );
  assert.equal(database.getRoleForChannel("guild-1", "voice-1"), "role-1");
  database.addRoleChannel("guild-1", "role-1", "voice-2");
  assert.equal(database.getRoleForChannel("guild-1", "voice-2"), "role-1");
});

test("concurrent approval claims have exactly one winner", (context) => {
  const { database, cleanup } = makeDatabase();
  context.after(cleanup);
  const now = Date.now();
  database.createRequest(makeRequest("request-1", now));
  const first = database.claimApproval(
    "request-1",
    "approver-1",
    now,
    makeGrant("request-1", now),
  );
  const second = database.claimApproval(
    "request-1",
    "approver-2",
    now,
    makeGrant("request-1", now),
  );
  assert.equal(first, true);
  assert.equal(second, false);
  assert.equal(database.getRequest("request-1")?.approverId, "approver-1");
  assert.equal(
    database.getGrantByRequest("request-1")?.state,
    "assignment_pending",
  );
});

test("expired requests cannot be decided", (context) => {
  const { database, cleanup } = makeDatabase();
  context.after(cleanup);
  const now = Date.now();
  database.createRequest(makeRequest("request-1", now));
  assert.equal(
    database.decideRequest("request-1", "denied", "approver-1", now + 60_001),
    false,
  );
  assert.equal(database.expireRequest("request-1", now + 60_001), true);
  assert.equal(database.getRequest("request-1")?.status, "expired");
});

test("joining an authorized channel cancels the initial-join deadline", async (context) => {
  const { database, cleanup } = makeDatabase();
  context.after(cleanup);
  const now = Date.now();
  database.createRequest(makeRequest("request-1", now));
  database.claimApproval(
    "request-1",
    "approver-1",
    now,
    makeGrant("request-1", now),
  );
  database.confirmRoleAssigned("grant-request-1", now + 90_000, now);
  const lifecycle = new GrantLifecycle({} as Client, database);
  await lifecycle.onVoiceStateUpdate(voiceState(null), voiceState("voice-2"));
  const grant = database.getGrant("grant-request-1");
  assert.equal(grant?.state, "active");
  assert.equal(grant?.deadlineAt, null);
});

test("joining an unrelated channel does not satisfy initial join", async (context) => {
  const { database, cleanup } = makeDatabase();
  context.after(cleanup);
  const now = Date.now();
  database.createRequest(makeRequest("request-1", now));
  database.claimApproval(
    "request-1",
    "approver-1",
    now,
    makeGrant("request-1", now),
  );
  database.confirmRoleAssigned("grant-request-1", now + 90_000, now);
  const lifecycle = new GrantLifecycle({} as Client, database);
  await lifecycle.onVoiceStateUpdate(voiceState(null), voiceState("unrelated"));
  const grant = database.getGrant("grant-request-1");
  assert.equal(grant?.state, "awaiting_initial_join");
  assert.equal(grant?.deadlineAt, now + 90_000);
});

test("leaving starts one grace deadline; an authorized return cancels it", async (context) => {
  context.mock.timers.enable({
    apis: ["setTimeout", "Date"],
    now: Date.now(),
  });
  const { database, cleanup } = makeDatabase();
  context.after(cleanup);
  const now = Date.now();
  database.createRequest(makeRequest("request-1", now));
  database.claimApproval(
    "request-1",
    "approver-1",
    now,
    makeGrant("request-1", now),
  );
  database.confirmRoleAssigned("grant-request-1", now + 90_000, now);
  database.updateGrant("grant-request-1", "active", null, now);
  database.updateGuildConfig("guild-1", { departureGracePeriodSeconds: 90 });
  const lifecycle = new GrantLifecycle({} as Client, database);
  await lifecycle.onVoiceStateUpdate(
    voiceState("voice-1"),
    voiceState("unrelated"),
  );
  const firstDeadline = database.getGrant("grant-request-1")?.deadlineAt;
  await lifecycle.onVoiceStateUpdate(
    voiceState("unrelated"),
    voiceState("unrelated"),
  );
  assert.equal(database.getGrant("grant-request-1")?.deadlineAt, firstDeadline);
  await lifecycle.onVoiceStateUpdate(
    voiceState("unrelated"),
    voiceState("voice-2"),
  );
  context.mock.timers.tick(90_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(database.getGrant("grant-request-1")?.state, "active");
  assert.equal(database.getGrant("grant-request-1")?.deadlineAt, null);
});

test("temporary grants and deadlines survive database reopen", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "access-bot-recovery-"));
  const path = join(directory, "test.sqlite");
  const firstDatabase = new AccessDatabase(path);
  const now = Date.now();
  firstDatabase.createRequest(makeRequest("request-1", now));
  firstDatabase.claimApproval(
    "request-1",
    "approver-1",
    now,
    makeGrant("request-1", now),
  );
  firstDatabase.confirmRoleAssigned("grant-request-1", now + 90_000, now);
  firstDatabase.close();
  const restored = new AccessDatabase(path);
  context.after(() => {
    restored.close();
    rmSync(directory, { recursive: true, force: true });
  });
  assert.equal(restored.getGrant("grant-request-1")?.deadlineAt, now + 90_000);
  assert.equal(
    restored.getGrant("grant-request-1")?.state,
    "awaiting_initial_join",
  );
});

test("configured timer environment defaults seed newly added guilds", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "access-bot-defaults-"));
  const database = new AccessDatabase(join(directory, "test.sqlite"), {
    initialJoinTimeoutSeconds: 45,
    departureGracePeriodSeconds: 75,
    requestExpirationSeconds: 240,
  });
  context.after(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  assert.deepEqual(database.getGuildConfig("guild-1"), {
    guildId: "guild-1",
    initialJoinTimeoutSeconds: 45,
    departureGracePeriodSeconds: 75,
    requestExpirationSeconds: 240,
  });
});

test("expired initial-join deadlines revoke access without real-time waiting", async (context) => {
  context.mock.timers.enable({
    apis: ["setTimeout", "Date"],
    now: Date.now(),
  });
  const { database, cleanup } = makeDatabase();
  context.after(cleanup);
  const now = Date.now();
  database.createRequest(makeRequest("request-1", now));
  database.claimApproval(
    "request-1",
    "approver-1",
    now,
    makeGrant("request-1", now),
  );
  database.confirmRoleAssigned("grant-request-1", now + 90_000, now);
  const grantedRole = { id: "role-1" } as Role;
  const roleCache = new Collection([["role-1", grantedRole]]);
  let removed = false;
  const member = {
    roles: {
      cache: roleCache,
      remove: async (roleId: string) => {
        removed = true;
        roleCache.delete(roleId);
      },
    },
    voice: { channelId: null },
    send: async () => {},
  };
  const guild = {
    members: { fetch: async () => member },
    roles: { fetch: async () => grantedRole },
  };
  const lifecycle = new GrantLifecycle(
    { guilds: { fetch: async () => guild } } as unknown as Client,
    database,
  );
  await lifecycle.initialize();
  context.mock.timers.tick(90_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(removed, true);
  assert.equal(database.getGrant("grant-request-1")?.state, "expired");
});

test("grace expiry after switching to an unrelated channel revokes access", async (context) => {
  context.mock.timers.enable({
    apis: ["setTimeout", "Date"],
    now: Date.now(),
  });
  const { database, cleanup } = makeDatabase();
  context.after(cleanup);
  const now = Date.now();
  database.createRequest(makeRequest("request-1", now));
  database.claimApproval(
    "request-1",
    "approver-1",
    now,
    makeGrant("request-1", now),
  );
  database.confirmRoleAssigned("grant-request-1", now + 90_000, now);
  database.updateGrant("grant-request-1", "active", null, now);
  const grantedRole = { id: "role-1" } as Role;
  const roleCache = new Collection([["role-1", grantedRole]]);
  let removed = false;
  const member = {
    roles: {
      cache: roleCache,
      remove: async (roleId: string) => {
        removed = true;
        roleCache.delete(roleId);
      },
    },
    voice: { channelId: "unrelated" },
    send: async () => {},
  };
  const guild = {
    members: { fetch: async () => member },
    roles: { fetch: async () => grantedRole },
  };
  const lifecycle = new GrantLifecycle(
    { guilds: { fetch: async () => guild } } as unknown as Client,
    database,
  );
  await lifecycle.onVoiceStateUpdate(
    voiceState("voice-1"),
    voiceState("unrelated"),
  );
  context.mock.timers.tick(90_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(removed, true);
  assert.equal(database.getGrant("grant-request-1")?.state, "expired");
});

test("ownership uncertainty preserves the role during cancellation", async (context) => {
  const { database, cleanup } = makeDatabase();
  context.after(cleanup);
  const now = Date.now();
  database.createRequest(makeRequest("request-1", now));
  database.claimApproval(
    "request-1",
    "approver-1",
    now,
    makeGrant("request-1", now),
  );
  database.confirmRoleAssigned("grant-request-1", now + 90_000, now);
  const oldMember = {
    id: "user-1",
    guild: { id: "guild-1" },
    roles: { cache: new Collection<string, Role>() },
  } as unknown as GuildMember;
  const grantedRole = { id: "role-1" } as Role;
  const newMember = {
    id: "user-1",
    guild: { id: "guild-1" },
    roles: { cache: new Collection([["role-1", grantedRole]]) },
  } as unknown as GuildMember;
  let removed = false;
  const member = {
    roles: {
      cache: new Map([["role-1", grantedRole]]),
      remove: async () => {
        removed = true;
      },
    },
  };
  const guild = {
    members: { fetch: async () => member },
    roles: { fetch: async () => grantedRole },
  };
  const lifecycle = new GrantLifecycle(
    { guilds: { fetch: async () => guild } } as unknown as Client,
    database,
  );
  await lifecycle.onMemberUpdate(oldMember, newMember);
  await lifecycle.cancel("grant-request-1");
  assert.equal(removed, false);
  assert.equal(
    database.getGrant("grant-request-1")?.state,
    "ownership_uncertain",
  );
});

function makeApprovalHarness(approverVoiceChannel = "voice-1") {
  const { database, cleanup } = makeDatabase();
  const now = Date.now();
  database.addRoleChannel("guild-1", "role-1", "voice-1");
  database.addRoleChannel("guild-1", "role-1", "voice-2");
  database.createRequest(makeRequest("request-approval", now));
  const role = {
    id: "role-1",
    managed: false,
    position: 1,
    permissions: { any: () => false },
  } as unknown as Role;
  const approverRole = { id: "role-1" } as Role;
  const approver = {
    id: "approver-1",
    roles: { cache: new Collection([["role-1", approverRole]]) },
    voice: { channelId: approverVoiceChannel },
  };
  const requesterRoles = new Collection<string, Role>();
  let addRoleCalls = 0;
  const requester = {
    id: "user-1",
    roles: {
      cache: requesterRoles,
      add: async (roleId: string) => {
        addRoleCalls += 1;
        requesterRoles.set(roleId, role);
      },
      remove: async () => {},
    },
    voice: { channelId: null },
  };
  const botMember = {
    permissions: { has: () => true },
    roles: { highest: { position: 10 } },
  };
  const guild = {
    id: "guild-1",
    channels: {
      fetch: async () => ({ id: "voice-1", type: ChannelType.GuildVoice }),
    },
    members: {
      me: botMember,
      fetch: async (id: string) => (id === "approver-1" ? approver : requester),
    },
    roles: { fetch: async () => role },
  } as unknown as Guild;
  const client = {
    guilds: { fetch: async () => guild },
  } as unknown as Client;
  const lifecycle = new GrantLifecycle(client, database);
  const workflow = new ApprovalWorkflow(client, database, lifecycle);
  const replies: string[] = [];
  const button = (action: "accept" | "deny") =>
    ({
      customId: `access:${action}:request-approval`,
      guild,
      user: { id: "approver-1" },
      deferReply: async () => {},
      editReply: async (response: string) => {
        replies.push(response);
      },
    }) as unknown as ButtonInteraction;
  return {
    database,
    cleanup,
    workflow,
    button,
    replies,
    moveApproverTo(channelId: string) {
      approver.voice.channelId = channelId;
    },
    get addRoleCalls() {
      return addRoleCalls;
    },
  };
}

test("approvers outside the exact target voice channel cannot decide", async (context) => {
  const harness = makeApprovalHarness("voice-2");
  context.after(harness.cleanup);
  await harness.workflow.handleButton(harness.button("deny"));
  assert.equal(
    harness.database.getRequest("request-approval")?.status,
    "pending",
  );
  assert.match(harness.replies[0] ?? "", /target voice channel/i);
});

test("simultaneous eligible decisions produce one winning decision", async (context) => {
  const harness = makeApprovalHarness();
  context.after(harness.cleanup);
  await Promise.all([
    harness.workflow.handleButton(harness.button("deny")),
    harness.workflow.handleButton(harness.button("deny")),
  ]);
  assert.equal(
    harness.database.getRequest("request-approval")?.status,
    "denied",
  );
  assert.equal(
    harness.replies.filter((reply) => reply === "Request denied.").length,
    1,
  );
});

test("approval message pings only the requested access role", async (context) => {
  const harness = makeApprovalHarness();
  context.after(harness.cleanup);
  let payload:
    | {
        content?: string;
        allowedMentions?: { roles?: string[]; users?: string[] };
      }
    | undefined;
  await harness.workflow.postRequest(
    harness.database.getRequest("request-approval")!,
    {
      id: "approval-channel",
      send: async (message: typeof payload) => {
        payload = message;
        return { id: "posted-message" };
      },
    } as unknown as GuildTextBasedChannel,
    "Scrim Access",
  );
  assert.equal(payload?.content, "<@&role-1>\nNew temporary access request");
  assert.deepEqual(payload?.allowedMentions?.roles, ["role-1"]);
  assert.deepEqual(payload?.allowedMentions?.users, ["user-1"]);
});

test("eligible approval grants the role and persists the initial-join deadline", async (context) => {
  const harness = makeApprovalHarness();
  context.after(harness.cleanup);
  await harness.workflow.handleButton(harness.button("accept"));
  const grant = harness.database.getGrantByRequest("request-approval");
  assert.equal(
    harness.database.getRequest("request-approval")?.status,
    "approved",
  );
  assert.equal(harness.addRoleCalls, 1);
  assert.equal(grant?.state, "awaiting_initial_join");
  assert.ok(grant?.deadlineAt && grant.deadlineAt > Date.now());
});

test("request panel selects a voice channel and derives its unique role", async (context) => {
  const { database, cleanup } = makeDatabase();
  context.after(cleanup);
  database.addRoleChannel("guild-1", "role-1", "voice-1");
  database.addRoleChannel("guild-1", "role-1", "voice-2");

  const role = {
    id: "role-1",
    name: "Scrim Spectator",
    managed: false,
    position: 1,
    permissions: { any: () => false },
  } as unknown as Role;
  const voiceChannels = [
    { id: "voice-1", name: "Scrim One", type: ChannelType.GuildVoice },
    { id: "voice-2", name: "Scrim Two", type: ChannelType.GuildStageVoice },
  ];
  let postedApproval = false;
  const panelChannel = {
    id: "panel-channel",
    guildId: "guild-1",
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: async () => {
      postedApproval = true;
      return { id: "approval-message" };
    },
  };
  const requester = {
    id: "user-1",
    roles: {
      cache: new Collection<string, Role>(),
      add: async () => {},
      remove: async () => {},
    },
  };
  const botMember = {
    permissions: { has: () => true },
    roles: { highest: { position: 10 } },
  };
  const guild = {
    id: "guild-1",
    roles: { cache: new Collection([["role-1", role]]) },
    members: {
      me: botMember,
      fetch: async () => requester,
    },
    channels: {
      cache: new Collection([
        ...voiceChannels.map((channel) => [channel.id, channel] as const),
        ["panel-channel", panelChannel] as const,
      ]),
      fetch: async (id: string) =>
        id === "panel-channel"
          ? panelChannel
          : (voiceChannels.find((channel) => channel.id === id) ?? null),
    },
  } as unknown as Guild;
  const client = { guilds: { fetch: async () => guild } } as unknown as Client;
  const lifecycle = new GrantLifecycle(client, database);
  const approvals = new ApprovalWorkflow(client, database, lifecycle);
  const handler = new InteractionHandler(
    client,
    database,
    approvals,
    lifecycle,
  );

  let completion = "";
  await handler.handlePanelSelection({
    customId: "access-panel:channel:user-1:panel-channel",
    values: ["voice-2"],
    guild,
    user: { id: "user-1" },
    update: async (response: { content?: string }) => {
      completion = response.content ?? "";
    },
  } as unknown as StringSelectMenuInteraction);
  assert.match(
    completion,
    /request for \*\*Scrim Spectator\*\* in <#voice-2> was sent/,
  );
  assert.equal(database.listPendingRequests()[0]?.targetChannelId, "voice-2");
  assert.equal(postedApproval, true);
});

test("an approver who leaves the target VC before accepting is rejected", async (context) => {
  const harness = makeApprovalHarness();
  context.after(harness.cleanup);
  harness.moveApproverTo("voice-2");
  await harness.workflow.handleButton(harness.button("accept"));
  assert.equal(
    harness.database.getRequest("request-approval")?.status,
    "pending",
  );
  assert.equal(harness.addRoleCalls, 0);
});

test("privileged, managed, and above-hierarchy roles are not assignable", () => {
  const makeRole = (overrides: Partial<Role> = {}) =>
    ({
      id: "role-1",
      managed: false,
      position: 1,
      permissions: { any: () => false },
      ...overrides,
    }) as unknown as Role;
  assert.equal(canAssignRole(makeRole(), "guild-1", 2), true);
  assert.equal(canAssignRole(makeRole({ managed: true }), "guild-1", 2), false);
  assert.equal(canAssignRole(makeRole({ position: 2 }), "guild-1", 2), false);
  assert.equal(
    canAssignRole(
      makeRole({
        permissions: { any: () => true } as unknown as Role["permissions"],
      }),
      "guild-1",
      2,
    ),
    false,
  );
});

test("failed Discord role removal persists retryable cleanup state", async (context) => {
  const { database, cleanup } = makeDatabase();
  context.after(cleanup);
  const now = Date.now();
  database.createRequest(makeRequest("request-1", now));
  database.claimApproval(
    "request-1",
    "approver-1",
    now,
    makeGrant("request-1", now),
  );
  database.confirmRoleAssigned("grant-request-1", now + 90_000, now);
  database.updateGrant("grant-request-1", "active", null, now);
  const grantedRole = { id: "role-1" } as Role;
  const member = {
    roles: {
      cache: new Map([["role-1", grantedRole]]),
      remove: async () => {
        throw new Error("Discord API unavailable");
      },
    },
  };
  const guild = {
    members: { fetch: async () => member },
    roles: { fetch: async () => grantedRole },
  };
  const lifecycle = new GrantLifecycle(
    { guilds: { fetch: async () => guild } } as unknown as Client,
    database,
  );
  await lifecycle.cancel("grant-request-1");
  const grant = database.getGrant("grant-request-1");
  assert.equal(grant?.state, "cleanup_pending");
  assert.equal(grant?.cleanupError, "Error: Discord API unavailable");
  assert.ok(grant?.deadlineAt && grant.deadlineAt > Date.now());
});
