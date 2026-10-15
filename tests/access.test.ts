import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Script } from "node:vm";
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
import { localizedGrantState, translate } from "../src/localization.js";
import {
  createAdminServer,
  isLoopbackHost,
  type AdminConfig,
} from "../src/web/admin.js";

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

test("guild language defaults to English and persists changes", (context) => {
  const { database, cleanup } = makeDatabase();
  context.after(cleanup);
  assert.equal(database.getGuildConfig("guild-1").language, "en");
  assert.equal(
    database.updateGuildConfig("guild-1", { language: "de" }).language,
    "de",
  );
  assert.equal(database.getGuildConfig("guild-1").language, "de");
  assert.equal(translate("en", "accept"), "Accept");
  assert.equal(translate("de", "accept"), "Genehmigen");
  assert.equal(
    translate("de", "approvalRequester", { user: "123" }),
    "Anfragende Person: <@123>",
  );
  assert.equal(
    localizedGrantState("de", "awaiting_initial_join"),
    "Wartet auf ersten Beitritt",
  );
});

test("APP_ENV controls whether web-admin authentication is required", async () => {
  const environmentKeys = [
    "APP_ENV",
    "DISCORD_TOKEN",
    "DISCORD_APPLICATION_ID",
    "WEB_ADMIN_AUTH_SECRET",
  ] as const;
  const originalValues = new Map(
    environmentKeys.map((key) => [key, process.env[key]]),
  );
  process.env.APP_ENV = "local";
  process.env.DISCORD_TOKEN = "test-token";
  process.env.DISCORD_APPLICATION_ID = "test-application-id";
  process.env.WEB_ADMIN_AUTH_SECRET = "";
  try {
    const { configSchema } = await import("../src/config.js");
    const baseConfig = {
      DISCORD_TOKEN: "test-token",
      DISCORD_APPLICATION_ID: "test-application-id",
    };
    assert.equal(
      configSchema.safeParse({
        ...baseConfig,
        APP_ENV: "local",
        WEB_ADMIN_AUTH_SECRET: "",
      }).success,
      true,
    );
    assert.equal(
      configSchema.safeParse({
        ...baseConfig,
        APP_ENV: "dev",
        WEB_ADMIN_AUTH_SECRET: "",
      }).success,
      true,
    );
    assert.equal(
      configSchema.safeParse({
        ...baseConfig,
        APP_ENV: "prod",
        WEB_ADMIN_AUTH_SECRET: "",
      }).success,
      false,
    );
    assert.equal(
      configSchema.safeParse({
        ...baseConfig,
        APP_ENV: "prod",
        WEB_ADMIN_AUTH_SECRET: "a".repeat(32),
      }).success,
      true,
    );
    assert.equal(
      configSchema.safeParse({
        ...baseConfig,
        APP_ENV: "prod",
        WEB_ADMIN_HOST: "",
        WEB_ADMIN_PORT: "",
        WEB_ADMIN_AUTH_SECRET: "",
      }).success,
      true,
    );
    assert.equal(
      configSchema.safeParse({
        ...baseConfig,
        APP_ENV: "local",
        WEB_ADMIN_HOST: "",
        WEB_ADMIN_PORT: "8787",
      }).success,
      false,
    );
    assert.equal(
      configSchema.safeParse({
        ...baseConfig,
        APP_ENV: "local",
        WEB_ADMIN_HOST: "127.0.0.1",
        WEB_ADMIN_PORT: "",
      }).success,
      false,
    );
    assert.equal(
      configSchema.safeParse({
        ...baseConfig,
        APP_ENV: "staging",
        WEB_ADMIN_AUTH_SECRET: "",
      }).success,
      false,
    );
  } finally {
    for (const key of environmentKeys) {
      const value = originalValues.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("web admin requires trusted proxy auth and exposes no credential management", async () => {
  const { database, cleanup } = makeDatabase();
  const authSecret = "test-proxy-secret-that-is-long-enough";
  const adminConfig: AdminConfig = {
    host: "127.0.0.1",
    port: 0,
    authHeader: "X-Website-Admin",
    authSecret,
  };
  const server = createAdminServer({
    config: adminConfig,
    database,
    client: { guilds: { cache: new Collection() } } as unknown as Client,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const headers = {
    "content-type": "application/json",
    "X-Website-Admin": authSecret,
    origin: baseUrl,
  };
  try {
    const unauthorized = await fetch(`${baseUrl}/api/bootstrap`);
    assert.equal(unauthorized.status, 401);

    const bootstrap = await fetch(`${baseUrl}/api/bootstrap`, {
      headers: { "X-Website-Admin": authSecret },
    });
    const bootstrapBody = await bootstrap.text();
    assert.equal(bootstrap.status, 200);
    assert.deepEqual(JSON.parse(bootstrapBody), { guilds: [] });

    const pageResponse = await fetch(`${baseUrl}/`, {
      headers: { "X-Website-Admin": authSecret },
    });
    const pageBody = await pageResponse.text();
    const contentSecurityPolicy = pageResponse.headers.get(
      "content-security-policy",
    );
    assert.match(contentSecurityPolicy ?? "", /base-uri 'self'/);
    assert.match(contentSecurityPolicy ?? "", /img-src 'self' data:/);
    assert.equal(pageBody.includes("bot token"), false);
    assert.equal(pageBody.includes("/api/credentials"), false);
    assert.equal(pageBody.includes("#ff6700"), true);
    assert.equal(pageBody.includes('id="uiLanguage"'), true);
    assert.equal(pageBody.includes('id="serverLanguage"'), true);
    assert.equal(pageBody.includes('data-theme="dark"'), true);
    const favicon = pageBody.match(
      /rel="icon"[^>]+href="data:image\/svg\+xml;base64,([^"]+)"/,
    )?.[1];
    assert.ok(favicon);
    const faviconSvg = Buffer.from(favicon, "base64").toString("utf8");
    assert.match(faviconSvg, /fill:#ff6700/);
    assert.match(faviconSvg, /M530\.74,515\.88/);
    const script = pageBody.match(/<script>([\s\S]*)<\/script>/)?.[1];
    assert.ok(script);
    assert.doesNotThrow(() => new Script(script));

    const badOrigin = await fetch(`${baseUrl}/api/unknown`, {
      method: "PUT",
      headers: { ...headers, origin: "https://attacker.example" },
      body: "{}",
    });
    assert.equal(badOrigin.status, 403);
    const noCredentialEndpoint = await fetch(`${baseUrl}/api/credentials`, {
      headers: { "X-Website-Admin": authSecret },
    });
    assert.equal(noCredentialEndpoint.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    cleanup();
  }
});

test("web admin permits unauthenticated access over loopback when no secret is configured", async () => {
  const { database, cleanup } = makeDatabase();
  const server = createAdminServer({
    config: {
      host: "127.0.0.1",
      port: 0,
      authHeader: "X-Website-Admin",
      authSecret: "",
    },
    database,
    client: { guilds: { cache: new Collection() } } as unknown as Client,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const page = await fetch(`${baseUrl}/`);
    assert.equal(page.status, 200);

    const bootstrap = await fetch(`${baseUrl}/api/bootstrap`);
    assert.equal(bootstrap.status, 200);
    assert.deepEqual(await bootstrap.json(), { guilds: [] });

    assert.equal(isLoopbackHost("localhost"), true);
    assert.equal(isLoopbackHost("127.0.0.2"), true);
    assert.equal(isLoopbackHost("::1"), true);
    assert.equal(isLoopbackHost("0.0.0.0"), false);
    assert.equal(isLoopbackHost("192.168.1.10"), false);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    cleanup();
  }
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
    language: "en",
  });
  context.after(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  assert.deepEqual(database.getGuildConfig("guild-1"), {
    guildId: "guild-1",
    language: "en",
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
  const secondEligibleApprover = {
    id: "approver-2",
    roles: { cache: new Collection([["role-1", approverRole]]) },
    voice: { channelId: "voice-1" },
  };
  const memberWithoutAccessRole = {
    id: "member-without-role",
    roles: { cache: new Collection<string, Role>() },
    voice: { channelId: "voice-1" },
  };
  const targetVoiceChannel = {
    id: "voice-1",
    type: ChannelType.GuildVoice,
    members: new Collection([
      ["approver-1", approver],
      ["approver-2", secondEligibleApprover],
      ["member-without-role", memberWithoutAccessRole],
    ]),
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: async () => ({ id: "approval-message" }),
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
      fetch: async () => targetVoiceChannel,
    },
    members: {
      me: botMember,
      fetch: async (id: string) => (id === "approver-1" ? approver : requester),
    },
    roles: { fetch: async () => role },
  } as unknown as Guild;
  const client = {
    guilds: { fetch: async () => guild },
    channels: {
      fetch: async () => ({
        isTextBased: () => true,
        send: async (payload: {
          content?: string;
          allowedMentions?: { users?: string[] };
        }) => {
          approvalNotices.push(payload);
          return { id: "requester-notice" };
        },
        messages: {
          fetch: async () => ({
            embeds: [],
            edit: async () => {},
            delete: async () => {
              deletedMessages += 1;
            },
          }),
        },
      }),
    },
  } as unknown as Client;
  let deletedMessages = 0;
  const approvalNotices: {
    content?: string;
    allowedMentions?: { users?: string[] };
  }[] = [];
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
    approvalNotices,
    moveApproverTo(channelId: string) {
      approver.voice.channelId = channelId;
    },
    get addRoleCalls() {
      return addRoleCalls;
    },
    get deletedMessages() {
      return deletedMessages;
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

test("ineligible approve and deny clicks leave the request available to eligible approvers", async (context) => {
  const harness = makeApprovalHarness("voice-2");
  context.after(harness.cleanup);
  harness.database.setRequestMessageId(
    "request-approval",
    "approval-channel",
    "approval-message",
  );

  await harness.workflow.handleButton(harness.button("accept"));
  await harness.workflow.handleButton(harness.button("deny"));
  assert.equal(
    harness.database.getRequest("request-approval")?.status,
    "pending",
  );
  assert.equal(harness.addRoleCalls, 0);
  assert.equal(harness.deletedMessages, 0);

  harness.moveApproverTo("voice-1");
  await harness.workflow.handleButton(harness.button("deny"));
  assert.equal(
    harness.database.getRequest("request-approval")?.status,
    "denied",
  );
  assert.equal(harness.deletedMessages, 0);
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

test("accepted and denied approval messages are deleted after 30 seconds", async (context) => {
  context.mock.timers.enable({
    apis: ["setTimeout", "Date"],
    now: Date.now(),
  });
  for (const action of ["accept", "deny"] as const) {
    const harness = makeApprovalHarness();
    context.after(harness.cleanup);
    harness.database.setRequestMessageId(
      "request-approval",
      "approval-channel",
      `message-${action}`,
    );
    await harness.workflow.handleButton(harness.button(action));
    assert.equal(harness.deletedMessages, 0);
    context.mock.timers.tick(29_999);
    assert.equal(harness.deletedMessages, 0);
    context.mock.timers.tick(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(harness.deletedMessages, 1);
    assert.equal(
      harness.database.getRequest("request-approval")?.messageId,
      null,
    );
  }
});

test("approval message pings only role holders currently in the target voice channel", async (context) => {
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
      id: "voice-1",
      send: async (message: typeof payload) => {
        payload = message;
        return { id: "posted-message" };
      },
    } as unknown as GuildTextBasedChannel,
    "Scrim Access",
  );
  assert.equal(
    payload?.content,
    "<@approver-1> <@approver-2>\nNew temporary access request",
  );
  assert.equal(payload?.allowedMentions?.roles, undefined);
  assert.deepEqual(payload?.allowedMentions?.users, [
    "approver-1",
    "approver-2",
  ]);
  assert.equal(
    harness.database.getRequest("request-approval")?.messageChannelId,
    "voice-1",
  );
});

test("eligible approval grants the role and persists the initial-join deadline", async (context) => {
  const harness = makeApprovalHarness();
  context.after(harness.cleanup);
  harness.database.setRequestMessageId(
    "request-approval",
    "approval-channel",
    "approval-message",
  );
  await harness.workflow.handleButton(harness.button("accept"));
  const grant = harness.database.getGrantByRequest("request-approval");
  assert.equal(
    harness.database.getRequest("request-approval")?.status,
    "approved",
  );
  assert.equal(harness.addRoleCalls, 1);
  assert.deepEqual(harness.approvalNotices, [
    {
      content:
        "<@user-1> your temporary voice access request was approved and your role has been assigned.",
      allowedMentions: { users: ["user-1"] },
    },
  ]);
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
  let postedApprovalChannel: string | null = null;
  const panelChannel = {
    id: "panel-channel",
    guildId: "guild-1",
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: async () => ({ id: "panel-message" }),
  };
  const approvalVoiceChannel = {
    ...voiceChannels[1]!,
    members: new Collection(),
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: async () => {
      postedApprovalChannel = "voice-2";
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
          : id === "voice-2"
            ? approvalVoiceChannel
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
  assert.equal(postedApprovalChannel, "voice-2");
  assert.equal(
    database.getRequest(database.listPendingRequests()[0]!.id)
      ?.messageChannelId,
    "voice-2",
  );
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
