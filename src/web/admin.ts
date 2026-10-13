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

function parseIpv4(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) =>
    /^\d{1,3}$/.test(part) ? Number(part) : Number.NaN,
  );
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

function parseIpv6(address: string): number[] | null {
  const normalized = address.toLowerCase().replace(/%[^%]+$/, "");
  const dottedTail = normalized.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  let value = normalized;
  if (dottedTail) {
    const octets = parseIpv4(dottedTail);
    if (!octets) return null;
    const high = ((octets[0]! << 8) | octets[1]!).toString(16);
    const low = ((octets[2]! << 8) | octets[3]!).toString(16);
    value = value.replace(dottedTail, `${high}:${low}`);
  }

  const halves = value.split("::");
  if (halves.length > 2) return null;
  const parseHalf = (half: string) =>
    half
      ? half
          .split(":")
          .map((group) =>
            /^[\da-f]{1,4}$/.test(group)
              ? Number.parseInt(group, 16)
              : Number.NaN,
          )
      : [];
  const left = parseHalf(halves[0] ?? "");
  const right = parseHalf(halves[1] ?? "");
  if (
    [...left, ...right].some((group) => !Number.isInteger(group)) ||
    (halves.length === 1 && left.length !== 8) ||
    (halves.length === 2 && left.length + right.length >= 8)
  ) {
    return null;
  }
  return halves.length === 1
    ? left
    : [
        ...left,
        ...Array<number>(8 - left.length - right.length).fill(0),
        ...right,
      ];
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const unwrapped = address.replace(/^\[|\]$/g, "");
  const ipv4 = parseIpv4(unwrapped);
  if (ipv4) return ipv4[0] === 127;
  const ipv6 = parseIpv6(unwrapped);
  if (!ipv6) return false;
  const isIpv6Loopback =
    ipv6.slice(0, 7).every((group) => group === 0) && ipv6[7] === 1;
  const isIpv4MappedLoopback =
    ipv6.slice(0, 5).every((group) => group === 0) &&
    ipv6[5] === 0xffff &&
    ipv6[6]! >> 8 === 127;
  return isIpv6Loopback || isIpv4MappedLoopback;
}

export function isLoopbackHost(host: string): boolean {
  return host.toLowerCase() === "localhost" || isLoopbackAddress(host);
}

function isLocalAdminRequest(
  request: IncomingMessage,
  server: Server,
): boolean {
  const address = server.address();
  return (
    address !== null &&
    typeof address !== "string" &&
    isLoopbackAddress(address.address) &&
    isLoopbackAddress(request.socket.remoteAddress)
  );
}

const page = `<!doctype html>
<html lang="en" data-theme="light">
<head>
  <base href="./">
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz48c3ZnIGlkPSJMYXllcl8xIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA4NjQgODY0Ij48ZGVmcz48c3R5bGU+LmNscy0xe2ZpbGw6I2ZmNjcwMDtzdHJva2Utd2lkdGg6MHB4O308L3N0eWxlPjwvZGVmcz48cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik01MzAuNzQsNTE1Ljg4bC05Ni44LDE5My42Yy0uOCwxLjYtMy4wOSwxLjYtMy44OSwwbC0zOC4xNC03Ni4yN2MtMi40NS00Ljg5LTIuNDUtMTAuNjUsMC0xNS41NWw1MC44OS0xMDEuNzhjMi40NS00Ljg5LDIuNDUtMTAuNjUsMC0xNS41NWwtMTA5LjU1LTIxOS4xYy0yLjQ1LTQuODktMi40NS0xMC42NSwwLTE1LjU1bDYuODctMTMuNzVjMi4xNS00LjI5LDcuMzctNi4wMywxMS42Ni0zLjg5bDYyLjY0LDMxLjMyYzUuMDUsMi41Miw5LjE0LDYuNjEsMTEuNjYsMTEuNjZsMTA0LjY1LDIwOS4zYzIuNDUsNC44OSwyLjQ1LDEwLjY1LDAsMTUuNTVaTTMwMy44NywyNjUuNjhsNjkuNzUtMTM5LjUxYy45My0xLjg3LTEuMDUtMy44NS0yLjkxLTIuOTFsLTEwMy42NCw1MS44MmMtNS4wNSwyLjUyLTkuMTQsNi42MS0xMS42NiwxMS42NmwtMzkuNDcsNzguOTRjLTIuNDUsNC44OS0yLjQ1LDEwLjY1LDAsMTUuNTVsMTU1LjQ2LDMxMC45MmMuOCwxLjYsMy4wOSwxLjYsMy44OSwwbDM4LjE0LTc2LjI3YzIuNDUtNC44OSwyLjQ1LTEwLjY1LDAtMTUuNTVsLTEwOS41NS0yMTkuMWMtMi40NS00Ljg5LTIuNDUtMTAuNjUsMC0xNS41NVpNNDAwLjY3LDg2LjY2bDcyLjQ4LDM2LjI0YzQuMjksMi4xNSw2LjAzLDcuMzcsMy44OSwxMS42NmwtMy45OCw3Ljk3Yy0yLjE1LDQuMjktNy4zNyw2LjAzLTExLjY2LDMuODlsLTQ3LjAzLTIzLjUxYy00LjI5LTIuMTUtOS41MS0uNDEtMTEuNjYsMy44OWwtNDMuMDQsODYuMDljLTIuMTUsNC4yOS0uNDEsOS41MSwzLjg5LDExLjY2bDcwLjQ3LDM1LjI0YzUuMDUsMi41Miw5LjE0LDYuNjEsMTEuNjYsMTEuNjZsMTguMywzNi42YzIuNTIsNS4wNSw2LjYxLDkuMTQsMTEuNjYsMTEuNjZsMTQ2LjA3LDczLjAzYzQuMjksMi4xNSw5LjUxLjQxLDExLjY2LTMuODlsNzQuMzMtMTQ4LjY2YzIuMTUtNC4yOS40MS05LjUxLTMuODktMTEuNjZsLTkxLjMzLTQ1LjY3Yy01LjA1LTIuNTItOS4xNC02LjYxLTExLjY2LTExLjY2bC0xOC4zLTM2LjZjLTIuNTItNS4wNS02LjYxLTkuMTQtMTEuNjYtMTEuNjZsLTE3MC4yLTg1LjFjLTQuODktMi40NS0xMC42NS0yLjQ1LTE1LjU1LDBsLTIyNC45MywxMTIuNDdjLTQuMjksMi4xNS02LjAzLDcuMzctMy44OSwxMS42NmwzOS4xMSw3OC4yMmMuOCwxLjYsMy4wOSwxLjYsMy44OSwwbDM2LjUyLTczLjAzYzIuNTItNS4wNSw2LjYxLTkuMTQsMTEuNjYtMTEuNjZsMTM3LjY1LTY4LjgyYzQuODktMi40NSwxMC42NS0yLjQ1LDE1LjU1LDBaTTU2MC4xMyw1MTUuODhsLTEwOS41NSwyMTkuMWMtMi40NSw0Ljg5LTIuNDUtMTAuNjUsMCwxNS41NWwzOC4xNCw3Ni4yN2MuOCwxLjYsMy4wOSwxLjYsMy44OSwwbDE4My44MS0zNjcuNjJjMi4xNS00LjI5LjQxLTkuNTEtMy44OS0xMS42NmwtMTc5LjIzLTg5LjYyYy0xLjg3LS45My0zLjg1LDEuMDUtMi45MiwyLjkybDY5Ljc1LDEzOS41MWMyLjQ1LDQuODksMi40NSwxMC42NSwwLDE1LjU1WiIvPjwvc3ZnPg==">
  <title>Voice Access Bot Settings</title>
  <style>
    :root{font:16px system-ui,sans-serif;color-scheme:light;--accent:#ff6700;--accent-hover:#e65d00;--bg:#f3f1ed;--surface:#fff;--surface-alt:#e9e5df;--text:#151515;--muted:#5d5a56;--border:#d4cec5;--input:#fff;--danger:#a52b20;--status:#8a3900;--focus:#ff9a59}
    :root[data-theme="dark"]{color-scheme:dark;--bg:#151515;--surface:#222;--surface-alt:#2d2d2d;--text:#e5e5e5;--muted:#b4b4b4;--border:#49433f;--input:#191919;--danger:#e45443;--status:#ff9a59;--focus:#ff8b42}
    *{box-sizing:border-box}
    body{max-width:920px;margin:2rem auto;padding:0 1rem;background:var(--bg);color:var(--text);transition:background-color .18s,color .18s}
    header{display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap;border-bottom:3px solid var(--accent);padding-bottom:1rem}
    h1,h2{color:var(--text)}h1{margin:.2rem 0;font-size:1.65rem}h2{margin-top:0;font-size:1.2rem}
    section{background:var(--surface);border:1px solid var(--border);border-left:4px solid var(--accent);border-radius:10px;padding:1rem 1.25rem;margin:1rem 0;box-shadow:0 3px 12px #15151512}
    label{display:block;margin:.8rem 0 .25rem;font-weight:600}
    input,select,button{font:inherit;padding:.6rem .7rem;border-radius:6px;border:1px solid var(--border);background:var(--input);color:var(--text)}
    input,select{max-width:100%;width:30rem}button{background:var(--accent);border-color:var(--accent);color:#151515;font-weight:700;cursor:pointer;margin:.6rem .4rem .2rem 0}
    button:hover{background:var(--accent-hover);border-color:var(--accent-hover)}button:focus-visible,select:focus-visible,input:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
    button.danger{background:var(--surface-alt);border-color:var(--danger);color:var(--danger)}
    .settings{display:flex;gap:.75rem;align-items:center}.settings label{margin:0;font-size:.9rem}
    .settings select{width:auto;min-width:8rem}.row{display:flex;gap:.75rem;flex-wrap:wrap}.row>div{flex:1;min-width:180px}
    .muted{color:var(--muted)}.mapping{display:flex;justify-content:space-between;align-items:center;gap:1rem;border-top:1px solid var(--border);padding:.6rem 0}
    #status{position:sticky;top:0;background:var(--surface-alt);border-left:4px solid var(--accent);border-radius:4px;padding:.7rem;color:var(--status)}small{display:block;color:var(--muted)}
    @media(max-width:560px){body{margin:1rem auto}.settings{width:100%;justify-content:space-between}.mapping{align-items:flex-start;flex-direction:column}}
  </style>
</head>
<body>
  <header>
    <h1 data-i18n="title">Temporary Voice Access Bot</h1>
    <div class="settings">
      <label for="uiLanguage" data-i18n="interfaceLanguage">Interface language</label>
      <select id="uiLanguage">
        <option value="en">English</option><option value="de">Deutsch</option>
      </select>
      <label for="theme" data-i18n="theme">Theme</label>
      <select id="theme">
        <option value="light" data-i18n="light">Light</option>
        <option value="dark" data-i18n="dark">Dark</option>
      </select>
    </div>
  </header>
  <p id="status" role="status" aria-live="polite" data-i18n="loading">Loading settings…</p>
  <section>
    <h2 data-i18n="serverConfig">Server configuration</h2>
    <label for="guild" data-i18n="server">Server</label><select id="guild"></select>
    <form id="guildConfig">
      <div class="row">
        <div><label for="serverLanguage" data-i18n="serverLanguage">Server language (Discord messages)</label><select id="serverLanguage"><option value="en">English</option><option value="de">Deutsch</option></select></div>
        <div><label for="expirationSeconds" data-i18n="requestExpiry">Request expiry (seconds)</label><input id="expirationSeconds" type="number" min="30" max="86400" required></div>
      </div>
      <div class="row">
      <div><label for="joinSeconds" data-i18n="joinTimeout">Initial join timeout (seconds)</label><input id="joinSeconds" type="number" min="1" max="86400" required></div>
        <div><label for="graceSeconds" data-i18n="departureGrace">Departure grace (seconds)</label><input id="graceSeconds" type="number" min="1" max="86400" required></div>
</div>
      <button data-i18n="saveSettings">Save server settings</button>
    </form>
  </section>
  <section>
    <h2 data-i18n="mappingsTitle">Requestable role and voice-channel mappings</h2>
    <form id="mapping">
      <label for="role" data-i18n="assignableRole">Assignable role</label><select id="role" required></select>
      <label for="voiceChannel" data-i18n="voiceChannel">Voice or stage channel</label><select id="voiceChannel" required></select>
      <button data-i18n="addMapping">Add mapping</button>
    </form>
    <div id="mappings"></div>
  </section>
  <section>
    <h2 data-i18n="requestPanel">Request panel</h2>
    <label for="panelChannel" data-i18n="panelTextChannel">Text channel for the panel</label><select id="panelChannel"></select>
    <button id="postPanel" data-i18n="postPanel">Post request panel</button>
  </section>
  <script>
    const $ = (id) => document.getElementById(id);
    const translations = {
      en: {title:"Temporary Voice Access Bot",interfaceLanguage:"Interface language",theme:"Theme",light:"Light",dark:"Dark",loading:"Loading settings…",serverConfig:"Server configuration",server:"Server",serverLanguage:"Server language (Discord messages)",joinTimeout:"Initial join timeout (seconds)",departureGrace:"Departure grace (seconds)",requestExpiry:"Request expiry (seconds)",saveSettings:"Save server settings",mappingsTitle:"Requestable role and voice-channel mappings",assignableRole:"Assignable role",voiceChannel:"Voice or stage channel",addMapping:"Add mapping",requestPanel:"Request panel",panelTextChannel:"Text channel for the panel",postPanel:"Post request panel",selectServer:"Select a server",selectRole:"Select a role",selectVoiceChannel:"Select a voice channel",selectTextChannel:"Select a text channel",remove:"Remove",settingsLoaded:"Settings loaded.",settingsSaved:"Server settings saved.",mappingAdded:"Mapping added.",mappingRemoved:"Mapping removed.",panelPosted:"Request panel posted.",requestFailed:"The request failed.",unauthorized:"Unauthorized.",invalidOrigin:"Invalid request origin.",notFound:"Not found.",invalidServerId:"Invalid server ID.",serverUnavailable:"The bot is not connected to that server.",invalidConfig:"Invalid language or timer values.",invalidMapping:"Invalid role or channel ID.",unsafeRole:"Role is unavailable or cannot safely be assigned by the bot.",voiceChannelRequired:"Choose a voice or stage channel.",textChannelRequired:"Choose a server text or announcement channel.",invalidJson:"Invalid JSON request body.",bodyTooLarge:"Request body is too large.",mappingConflict:"That voice channel is already assigned to role {role}.",operationFailed:"The operation failed; check bot logs."},
      de: {title:"Temporärer Sprachzugang",interfaceLanguage:"Sprache der Oberfläche",theme:"Darstellung",light:"Hell",dark:"Dunkel",loading:"Einstellungen werden geladen…",serverConfig:"Serverkonfiguration",server:"Server",serverLanguage:"Serversprache (Discord-Nachrichten)",joinTimeout:"Zeit bis zum ersten Beitritt (Sekunden)",departureGrace:"Karenzzeit nach Verlassen (Sekunden)",requestExpiry:"Ablauf der Anfrage (Sekunden)",saveSettings:"Servereinstellungen speichern",mappingsTitle:"Anfragbare Rollen- und Sprachkanalzuordnungen",assignableRole:"Zuweisbare Rolle",voiceChannel:"Sprach- oder Bühnenkanal",addMapping:"Zuordnung hinzufügen",requestPanel:"Anfrage-Panel",panelTextChannel:"Textkanal für das Panel",postPanel:"Anfrage-Panel posten",selectServer:"Server auswählen",selectRole:"Rolle auswählen",selectVoiceChannel:"Sprachkanal auswählen",selectTextChannel:"Textkanal auswählen",remove:"Entfernen",settingsLoaded:"Einstellungen geladen.",settingsSaved:"Servereinstellungen gespeichert.",mappingAdded:"Zuordnung hinzugefügt.",mappingRemoved:"Zuordnung entfernt.",panelPosted:"Anfrage-Panel gepostet.",requestFailed:"Die Anfrage ist fehlgeschlagen.",unauthorized:"Nicht autorisiert.",invalidOrigin:"Ungültiger Anfrage-Ursprung.",notFound:"Nicht gefunden.",invalidServerId:"Ungültige Server-ID.",serverUnavailable:"Der Bot ist nicht mit diesem Server verbunden.",invalidConfig:"Ungültige Sprache oder Timerwerte.",invalidMapping:"Ungültige Rollen- oder Kanal-ID.",unsafeRole:"Die Rolle ist nicht verfügbar oder kann vom Bot nicht sicher zugewiesen werden.",voiceChannelRequired:"Wähle einen Sprach- oder Bühnenkanal.",textChannelRequired:"Wähle einen Text- oder Ankündigungskanal des Servers.",invalidJson:"Ungültiger JSON-Anfrageinhalt.",bodyTooLarge:"Der Anfrageinhalt ist zu groß.",mappingConflict:"Dieser Sprachkanal ist bereits der Rolle {role} zugeordnet.",operationFailed:"Der Vorgang ist fehlgeschlagen; siehe Bot-Protokolle."}
    };
    let guildId = "";
    let uiLanguage = localStorage.getItem("access-ui-language")==="de"?"de":"en";
    function t(key){return translations[uiLanguage][key] || translations.en[key] || key;}
    function errorText(message){const keys={"Unauthorized":"unauthorized","Invalid request origin":"invalidOrigin","Not found":"notFound","Invalid server ID":"invalidServerId","The bot is not connected to that server":"serverUnavailable","Invalid language or timer values":"invalidConfig","Invalid role or channel ID":"invalidMapping","Role is unavailable or cannot safely be assigned by the bot":"unsafeRole","Choose a voice or stage channel":"voiceChannelRequired","Choose a server text or announcement channel":"textChannelRequired","Invalid JSON request body":"invalidJson","Request body is too large":"bodyTooLarge","The operation failed; check bot logs":"operationFailed"};if(!message)return t("requestFailed");if(keys[message])return t(keys[message]);const conflict=message.match(/^Voice channel .+ is already assigned to role (.+)$/);return conflict?t("mappingConflict").replace("{role}",conflict[1]):message;}
    function status(message, isError=false){ $("status").textContent=message; $("status").style.color=isError?"var(--danger)":"var(--status)"; }
    function applyLanguage(){
      document.documentElement.lang=uiLanguage;
      document.title=t("title");
      document.querySelectorAll("[data-i18n]").forEach((element)=>{const key=element.dataset.i18n;if(key)element.textContent=t(key);});
      $("uiLanguage").value=uiLanguage;
      if($("guild").options[0])$("guild").options[0].textContent=t("selectServer");
      if($("role").options[0])$("role").options[0].textContent=t("selectRole");
      if($("voiceChannel").options[0])$("voiceChannel").options[0].textContent=t("selectVoiceChannel");
      if($("panelChannel").options[0])$("panelChannel").options[0].textContent=t("selectTextChannel");
    }
    async function api(path, options={}) {
      const response=await fetch(path,{...options,headers:{"content-type":"application/json",...(options.headers||{})}});
      const data=await response.json().catch(()=>({}));
      if(!response.ok) throw new Error(data.error||"Request failed");
      return data;
    }
    function fill(select, items, placeholderKey) {
      select.replaceChildren();
      const empty=document.createElement("option"); empty.value=""; empty.textContent=t(placeholderKey); select.append(empty);
      for(const item of items){const option=document.createElement("option");option.value=item.id;option.textContent=item.name+" ("+item.id+")";select.append(option);}
    }
    async function loadGuild() {
      guildId=$("guild").value;if(!guildId)return;
      const data=await api("api/guilds/"+encodeURIComponent(guildId));
      $("serverLanguage").value=data.config.language;
      $("joinSeconds").value=data.config.initialJoinTimeoutSeconds;
      $("graceSeconds").value=data.config.departureGracePeriodSeconds;
      $("expirationSeconds").value=data.config.requestExpirationSeconds;
      fill($("role"),data.roles,"selectRole");
      fill($("voiceChannel"),data.voiceChannels,"selectVoiceChannel");
      fill($("panelChannel"),data.textChannels,"selectTextChannel");
      const list=$("mappings");list.replaceChildren();
      for(const mapping of data.mappings){
        const row=document.createElement("div");row.className="mapping";
        const label=document.createElement("span");label.textContent=mapping.roleName+" → "+mapping.channelName;
        const remove=document.createElement("button");remove.className="danger";remove.textContent=t("remove");
        remove.onclick=async()=>{try{await api("api/guilds/"+encodeURIComponent(guildId)+"/mappings",{method:"DELETE",body:JSON.stringify({roleId:mapping.roleId,channelId:mapping.channelId})});await loadGuild();status(t("mappingRemoved"));}catch(e){status(errorText(e.message),true);}};
        row.append(label,remove);list.append(row);
      }
    }
    async function init(){
      try{
        const data=await api("api/bootstrap");
        fill($("guild"),data.guilds,"selectServer");
        if(data.guilds.length){$("guild").value=data.guilds[0].id;await loadGuild();}
        status(t("settingsLoaded"));
      }catch(e){status(errorText(e.message),true);}
    }
    $("guild").onchange=()=>loadGuild().catch(e=>status(errorText(e.message),true));
    $("uiLanguage").onchange=()=>{uiLanguage=$("uiLanguage").value;localStorage.setItem("access-ui-language",uiLanguage);applyLanguage();};
    $("theme").onchange=()=>{document.documentElement.dataset.theme=$("theme").value;localStorage.setItem("access-ui-theme",$("theme").value);};
    $("guildConfig").onsubmit=async(e)=>{e.preventDefault();try{await api("api/guilds/"+encodeURIComponent(guildId)+"/config",{method:"PUT",body:JSON.stringify({language:$("serverLanguage").value,initialJoinTimeoutSeconds:Number($("joinSeconds").value),departureGracePeriodSeconds:Number($("graceSeconds").value),requestExpirationSeconds:Number($("expirationSeconds").value)})});status(t("settingsSaved"));}catch(error){status(errorText(error.message),true);}};
    $("mapping").onsubmit=async(e)=>{e.preventDefault();try{await api("api/guilds/"+encodeURIComponent(guildId)+"/mappings",{method:"POST",body:JSON.stringify({roleId:$("role").value,channelId:$("voiceChannel").value})});await loadGuild();status(t("mappingAdded"));}catch(error){status(errorText(error.message),true);}};
    $("postPanel").onclick=async()=>{try{await api("api/guilds/"+encodeURIComponent(guildId)+"/panel",{method:"POST",body:JSON.stringify({channelId:$("panelChannel").value})});status(t("panelPosted"));}catch(error){status(errorText(error.message),true);}};
    const savedTheme=localStorage.getItem("access-ui-theme");
    document.documentElement.dataset.theme=savedTheme==="dark"?"dark":"light";
    $("theme").value=document.documentElement.dataset.theme;
    applyLanguage();
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
    const validAuth =
      expectedAuth.length > 0 &&
      suppliedAuth.length === expectedAuth.length &&
      timingSafeEqual(suppliedAuth, expectedAuth);
    const unauthenticatedLocalAccess =
      expectedAuth.length === 0 &&
      isLoopbackHost(config.host) &&
      isLocalAdminRequest(request, server);
    if (!validAuth && !unauthenticatedLocalAccess) {
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
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'self'; base-uri 'self'",
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
