import { timingSafeEqual } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type GuildBasedChannel,
  type Role,
} from "discord.js";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { AccessDatabase } from "../persistence/database.js";
import { translate } from "../localization.js";
import { canAssignRole } from "../services/role-policy.js";
import { log } from "../logger.js";

const MAX_BODY_BYTES = 16_384;
const idPattern = /^\d{17,20}$/;

export interface AdminConfig {
  host: string;
  port: number;
  authHeader: string;
  authSecret: string;
}

const page = `<!doctype html>
<html lang="en">
<head>
  <base href="./">
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Voice Access Bot Settings</title>
  <style>
    :root{color-scheme:dark;font:16px system-ui,sans-serif;background:#111827;color:#e5e7eb}
    body{max-width:920px;margin:2rem auto;padding:0 1rem}
    h1,h2{color:#fff}section{background:#1f2937;border:1px solid #374151;border-radius:10px;padding:1rem 1.25rem;margin:1rem 0}
    label{display:block;margin:.8rem 0 .25rem}input,select,button{font:inherit;padding:.55rem;border-radius:6px;border:1px solid #4b5563;background:#111827;color:inherit}
    input,select{max-width:100%;width:30rem}button{background:#2563eb;border:0;cursor:pointer;margin:.6rem .4rem .2rem 0}
    button.danger{background:#991b1b}.row{display:flex;gap:.75rem;flex-wrap:wrap}.row>div{flex:1;min-width:180px}
    .muted{color:#9ca3af}.mapping{display:flex;justify-content:space-between;gap:1rem;border-top:1px solid #374151;padding:.6rem 0}
    #status{position:sticky;top:0;background:#111827;padding:.5rem;color:#93c5fd}small{display:block;color:#9ca3af}
  </style>
</head>
<body>
  <h1>Temporary Voice Access Bot</h1>
  <p id="status" role="status">Loading settings…</p>
  <section>
    <h2>Server configuration</h2>
    <label for="guild">Server</label><select id="guild"></select>
    <form id="guildConfig">
      <div class="row">
        <div><label for="language">Language</label><select id="language"><option value="en">English</option><option value="de">Deutsch</option></select></div>
        <div><label for="joinSeconds">Initial join timeout (seconds)</label><input id="joinSeconds" type="number" min="1" max="86400" required></div>
        <div><label for="graceSeconds">Departure grace (seconds)</label><input id="graceSeconds" type="number" min="1" max="86400" required></div>
        <div><label for="expirationSeconds">Request expiry (seconds)</label><input id="expirationSeconds" type="number" min="30" max="86400" required></div>
      </div>
      <button>Save server settings</button>
    </form>
  </section>
  <section>
    <h2>Requestable role and voice-channel mappings</h2>
    <form id="mapping">
      <label for="role">Assignable role</label><select id="role" required></select>
      <label for="voiceChannel">Voice or stage channel</label><select id="voiceChannel" required></select>
      <button>Add mapping</button>
    </form>
    <div id="mappings"></div>
  </section>
  <section>
    <h2>Request panel</h2>
    <label for="panelChannel">Text channel for the panel</label><select id="panelChannel"></select>
    <button id="postPanel">Post request panel</button>
  </section>
  <script>
    const $ = (id) => document.getElementById(id);
    let guildId = "";
    function status(message, isError=false){ $("status").textContent=message; $("status").style.color=isError?"#fca5a5":"#93c5fd"; }
    async function api(path, options={}) {
      const response=await fetch(path,{...options,headers:{"content-type":"application/json",...(options.headers||{})}});
      const data=await response.json().catch(()=>({}));
      if(!response.ok) throw new Error(data.error||"Request failed");
      return data;
    }
    function fill(select, items, placeholder) {
      select.replaceChildren();
      const empty=document.createElement("option"); empty.value=""; empty.textContent=placeholder; select.append(empty);
      for(const item of items){const option=document.createElement("option");option.value=item.id;option.textContent=item.name+" ("+item.id+")";select.append(option);}
    }
    async function loadGuild() {
      guildId=$("guild").value;if(!guildId)return;
      const data=await api("api/guilds/"+encodeURIComponent(guildId));
      $("language").value=data.config.language;
      $("joinSeconds").value=data.config.initialJoinTimeoutSeconds;
      $("graceSeconds").value=data.config.departureGracePeriodSeconds;
      $("expirationSeconds").value=data.config.requestExpirationSeconds;
      fill($("role"),data.roles,"Select a role");
      fill($("voiceChannel"),data.voiceChannels,"Select a voice channel");
      fill($("panelChannel"),data.textChannels,"Select a text channel");
      const list=$("mappings");list.replaceChildren();
      for(const mapping of data.mappings){
        const row=document.createElement("div");row.className="mapping";
        const label=document.createElement("span");label.textContent=mapping.roleName+" → "+mapping.channelName;
        const remove=document.createElement("button");remove.className="danger";remove.textContent="Remove";
        remove.onclick=async()=>{try{await api("api/guilds/"+encodeURIComponent(guildId)+"/mappings",{method:"DELETE",body:JSON.stringify({roleId:mapping.roleId,channelId:mapping.channelId})});await loadGuild();status("Mapping removed.");}catch(e){status(e.message,true);}};
        row.append(label,remove);list.append(row);
      }
    }
    async function init(){
      try{
        const data=await api("api/bootstrap");
        fill($("guild"),data.guilds,"Select a server");
        if(data.guilds.length){$("guild").value=data.guilds[0].id;await loadGuild();}
        status("Settings loaded.");
      }catch(e){status(e.message,true);}
    }
    $("guild").onchange=()=>loadGuild().catch(e=>status(e.message,true));
    $("guildConfig").onsubmit=async(e)=>{e.preventDefault();try{await api("api/guilds/"+encodeURIComponent(guildId)+"/config",{method:"PUT",body:JSON.stringify({language:$("language").value,initialJoinTimeoutSeconds:Number($("joinSeconds").value),departureGracePeriodSeconds:Number($("graceSeconds").value),requestExpirationSeconds:Number($("expirationSeconds").value)})});status("Server settings saved.");}catch(error){status(error.message,true);}};
    $("mapping").onsubmit=async(e)=>{e.preventDefault();try{await api("api/guilds/"+encodeURIComponent(guildId)+"/mappings",{method:"POST",body:JSON.stringify({roleId:$("role").value,channelId:$("voiceChannel").value})});await loadGuild();status("Mapping added.");}catch(error){status(error.message,true);}};
    $("postPanel").onclick=async()=>{try{await api("api/guilds/"+encodeURIComponent(guildId)+"/panel",{method:"POST",body:JSON.stringify({channelId:$("panelChannel").value})});status("Request panel posted.");}catch(error){status(error.message,true);}};
    init();
  </script>
</body>
</html>`;

function send(
  response: ServerResponse,
  statusCode: number,
  value: unknown,
): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy":
      "default-src 'none'; frame-ancestors 'self'; base-uri 'none'",
  });
  response.end(JSON.stringify(value));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of request) {
    body += chunk.toString();
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
      throw new Error("Request body is too large");
    }
  }
  return JSON.parse(body);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSnowflake(value: unknown): value is string {
  return typeof value === "string" && idPattern.test(value);
}

function hasSameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (!origin || !host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

function getGuild(client: Client, guildId: string): Guild | null {
  return client.guilds.cache.get(guildId) ?? null;
}

function isTextChannel(
  channel: GuildBasedChannel | null,
): channel is GuildBasedChannel & {
  send: (payload: unknown) => Promise<unknown>;
} {
  return (
    channel?.type === ChannelType.GuildText ||
    channel?.type === ChannelType.GuildAnnouncement
  );
}

export function createAdminServer(options: {
  config: AdminConfig;
  database: AccessDatabase;
  client: Client;
}): Server {
  const { config, database, client } = options;
  const expectedAuth = Buffer.from(config.authSecret);

  const server = createServer(async (request, response) => {
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("cache-control", "no-store");

    const suppliedHeader = request.headers[config.authHeader.toLowerCase()];
    const suppliedAuth = Buffer.from(
      Array.isArray(suppliedHeader)
        ? (suppliedHeader[0] ?? "")
        : (suppliedHeader ?? ""),
    );
    if (
      suppliedAuth.length !== expectedAuth.length ||
      !timingSafeEqual(suppliedAuth, expectedAuth)
    ) {
      send(response, 401, { error: "Unauthorized" });
      return;
    }

    if (
      request.method !== "GET" &&
      request.method !== "HEAD" &&
      !hasSameOrigin(request)
    ) {
      send(response, 403, { error: "Invalid request origin" });
      return;
    }

    const url = new URL(request.url ?? "/", "http://localhost");
    try {
      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "x-frame-options": "SAMEORIGIN",
          "content-security-policy":
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'self'; base-uri 'none'",
        });
        response.end(page);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/bootstrap") {
        send(response, 200, {
          guilds: client.guilds.cache.map((guild) => ({
            id: guild.id,
            name: guild.name,
          })),
        });
        return;
      }
      const guildMatch =
        /^\/api\/guilds\/([^/]+)(?:\/(config|mappings|panel))?$/.exec(
          url.pathname,
        );
      if (!guildMatch) {
        send(response, 404, { error: "Not found" });
        return;
      }
      const guildId = decodeURIComponent(guildMatch[1] ?? "");
      const resource = guildMatch[2] ?? "";
      if (!isSnowflake(guildId)) {
        send(response, 400, { error: "Invalid server ID" });
        return;
      }
      const guild = getGuild(client, guildId);
      if (!guild) {
        send(response, 404, {
          error: "The bot is not connected to that server",
        });
        return;
      }
      if (request.method === "GET" && !resource) {
        const botMember = guild.members.me ?? (await guild.members.fetchMe());
        const settings = database.getGuildConfig(guild.id);
        const mappings = database
          .getAllRoleMappings(guild.id)
          .map((mapping) => ({
            ...mapping,
            roleName:
              guild.roles.cache.get(mapping.roleId)?.name ?? mapping.roleId,
            channelName:
              guild.channels.cache.get(mapping.channelId)?.name ??
              mapping.channelId,
          }));
        send(response, 200, {
          config: settings,
          mappings,
          roles: guild.roles.cache
            .filter((role: Role) =>
              canAssignRole(role, guild.id, botMember.roles.highest.position),
            )
            .map((role: Role) => ({ id: role.id, name: role.name })),
          voiceChannels: guild.channels.cache
            .filter(
              (channel) =>
                channel.type === ChannelType.GuildVoice ||
                channel.type === ChannelType.GuildStageVoice,
            )
            .map((channel) => ({ id: channel.id, name: channel.name })),
          textChannels: guild.channels.cache
            .filter(
              (channel) =>
                channel.type === ChannelType.GuildText ||
                channel.type === ChannelType.GuildAnnouncement,
            )
            .map((channel) => ({ id: channel.id, name: channel.name })),
        });
        return;
      }
      if (request.method === "PUT" && resource === "config") {
        const body = await readJson(request);
        if (
          !isRecord(body) ||
          (body.language !== "en" && body.language !== "de") ||
          !Number.isInteger(body.initialJoinTimeoutSeconds) ||
          !Number.isInteger(body.departureGracePeriodSeconds) ||
          !Number.isInteger(body.requestExpirationSeconds) ||
          Number(body.initialJoinTimeoutSeconds) < 1 ||
          Number(body.initialJoinTimeoutSeconds) > 86400 ||
          Number(body.departureGracePeriodSeconds) < 1 ||
          Number(body.departureGracePeriodSeconds) > 86400 ||
          Number(body.requestExpirationSeconds) < 30 ||
          Number(body.requestExpirationSeconds) > 86400
        ) {
          send(response, 400, { error: "Invalid language or timer values" });
          return;
        }
        const updated = database.updateGuildConfig(guild.id, {
          language: body.language,
          initialJoinTimeoutSeconds: Number(body.initialJoinTimeoutSeconds),
          departureGracePeriodSeconds: Number(body.departureGracePeriodSeconds),
          requestExpirationSeconds: Number(body.requestExpirationSeconds),
        });
        send(response, 200, { config: updated });
        return;
      }
      if (
        (request.method === "POST" || request.method === "DELETE") &&
        resource === "mappings"
      ) {
        const body = await readJson(request);
        if (
          !isRecord(body) ||
          !isSnowflake(body.roleId) ||
          !isSnowflake(body.channelId)
        ) {
          send(response, 400, { error: "Invalid role or channel ID" });
          return;
        }
        if (request.method === "DELETE") {
          database.removeRoleChannel(guild.id, body.roleId, body.channelId);
          send(response, 200, { message: "Mapping removed" });
          return;
        }
        const [role, channel, botMember] = await Promise.all([
          guild.roles.fetch(body.roleId),
          guild.channels.fetch(body.channelId),
          guild.members.me ?? guild.members.fetchMe(),
        ]);
        if (
          !role ||
          !canAssignRole(role, guild.id, botMember.roles.highest.position) ||
          !botMember.permissions.has(PermissionFlagsBits.ManageRoles)
        ) {
          send(response, 400, {
            error:
              "Role is unavailable or cannot safely be assigned by the bot",
          });
          return;
        }
        if (
          channel?.type !== ChannelType.GuildVoice &&
          channel?.type !== ChannelType.GuildStageVoice
        ) {
          send(response, 400, { error: "Choose a voice or stage channel" });
          return;
        }
        database.addRoleChannel(guild.id, role.id, channel.id);
        send(response, 200, { message: "Mapping added" });
        return;
      }
      if (request.method === "POST" && resource === "panel") {
        const body = await readJson(request);
        if (!isRecord(body) || !isSnowflake(body.channelId)) {
          send(response, 400, { error: "Invalid text channel ID" });
          return;
        }
        const channel = await guild.channels.fetch(body.channelId);
        if (!isTextChannel(channel)) {
          send(response, 400, {
            error: "Choose a server text or announcement channel",
          });
          return;
        }
        const language = database.getGuildConfig(guild.id).language;
        await channel.send({
          content: translate(language, "panelContent"),
          components: [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setCustomId("access-panel:open")
                .setLabel(translate(language, "requestButton"))
                .setStyle(ButtonStyle.Primary),
            ),
          ],
          allowedMentions: { parse: [] },
        });
        send(response, 200, { message: "Request panel posted" });
        return;
      }
      send(response, 404, { error: "Not found" });
    } catch (error) {
      if (error instanceof SyntaxError) {
        send(response, 400, { error: "Invalid JSON request body" });
        return;
      }
      if (
        error instanceof Error &&
        error.message === "Request body is too large"
      ) {
        send(response, 413, { error: error.message });
        return;
      }
      if (
        error instanceof Error &&
        error.message.includes("already assigned to role")
      ) {
        send(response, 409, { error: error.message });
        return;
      }
      log("error", "Web admin request failed", {
        method: request.method,
        path: url.pathname,
        error: error instanceof Error ? error.message : String(error),
      });
      send(response, 500, { error: "The operation failed; check bot logs" });
    }
  });
  return server;
}

export function startAdminServer(
  server: Server,
  host: string,
  port: number,
): void {
  server.listen(port, host, () => {
    const address = server.address() as AddressInfo;
    log("info", "Web admin interface listening", {
      host,
      port: address.port,
    });
  });
}
