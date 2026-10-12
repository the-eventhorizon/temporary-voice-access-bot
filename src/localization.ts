import type { GuildConfig } from "./persistence/types.js";

const english = {
  guildOnly: "This command can only be used in a server.",
  unexpected:
    "An unexpected error occurred. Please try again or contact an administrator.",
  noAssignableRoles: "No access roles are currently available to request.",
  panelInvalid: "This request panel is invalid.",
  manageRolesMissing:
    "The bot is missing Manage Roles permission. Contact a server administrator.",
  chooseVoiceChannel: "Choose the voice channel you want to access:",
  voiceChannelPlaceholder: "Choose a target voice channel",
  roleRequestDescription: "Request {role}",
  panelSelectionInvalid: "This selection has expired or is not yours.",
  chooseTargetChannel: "Choose a target voice channel.",
  mappingNoLongerValid:
    "This voice channel is no longer configured with exactly one access role. Contact an administrator.",
  roleNotRequestable:
    "That role is not currently configured for temporary access.",
  channelNotMapped:
    "That voice channel is not associated with the selected role.",
  noTargetChannel: "This role has no configured target voice channel.",
  channelRequired:
    "Select a target channel because this role has multiple configured channels.",
  targetUnavailable:
    "The configured target channel no longer exists or is not a voice channel.",
  membershipUnavailable:
    "Your server membership could not be verified. Try again.",
  alreadyHasRole: "You already have this role.",
  liveGrantExists: "You already have a temporary grant for this role.",
  requestCooldown:
    "Please wait 30 seconds before submitting another request for this role.",
  requestChannelUnavailable:
    "The target voice channel's chat is unavailable for approval messages.",
  requestChannelPermissions:
    "The bot needs View Channel, Send Messages, Embed Links, and Read Message History in the target voice channel's chat.",
  duplicateRequest: "You already have a pending request for this role.",
  requestSent:
    "Your request for **{role}** in <#{channel}> was sent. It expires <t:{expires}:R>.",
  postFailed:
    "The request could not be posted in the target voice channel's chat. Please contact an administrator.",
  adminOnly: "Administrator permission is required.",
  languageInvalid: "Choose English or German.",
  languageEnglishSet: "Language set to English.",
  languageGermanSet: "Language set to German.",
  languageConfiguration: "Language: {language}",
  selectedRoleUnavailable: "The selected role or channel is unavailable.",
  roleNotSafe:
    "That role is managed, privileged, @everyone, or not below the bot's highest role.",
  voiceChannelRequired: "Choose a server voice or stage channel.",
  channelAlreadyMapped:
    "That voice channel is already mapped to a different access role. Each voice channel can have only one assigned request role.",
  mappingSaveFailed: "The role-to-channel mapping could not be saved.",
  mappingAdded: "Configured <@&{role}> for <#{channel}>.",
  mappingRemoved: "Removed the mapping between <@&{role}> and <#{channel}>.",
  panelTextChannel: "Choose a server text channel.",
  panelPermissions:
    "The bot needs View Channel and Send Messages in that channel.",
  panelPosted: "Posted the access request panel in <#{channel}>.",
  panelContent:
    "**Temporary voice access**\nClick below to choose a voice channel. Members with that channel's assigned role can approve your request while in the channel.",
  requestButton: "Request access",
  timersUpdated:
    "Timers updated: join {join}s, departure grace {grace}s, request expiration {expiration}s.",
  configApprovalRouting:
    "Approval requests are posted in the target voice channel's text chat.",
  configInitialTimer:
    "Initial join: {join}s; departure grace: {grace}s; request expiration: {expiration}s",
  configMappings: "Role mappings: {mappings}",
  configApprovers:
    "Approvers: members with the requested access role who are in its target voice channel.",
  configEmpty: "none",
  noPendingRequestOrGrant:
    "No pending request or temporary grant matched that ID.",
  requestCancelled: "Pending request cancelled.",
  requestNotPending: "The request is no longer pending.",
  grantAlreadyEnded: "That grant has already ended.",
  grantRevoked: "Temporary role revoked.",
  cleanupNotSafe:
    "Cleanup could not safely remove the role; grant retained as {state} for administrator review.",
  approvalControlInvalid: "This approval control is invalid.",
  accept: "Accept",
  deny: "Deny",
  approvalPingText: "New temporary access request",
  approvalTitle: "Voice access request",
  approvalRequester: "Requester: <@{user}>",
  approvalRole: "Role: <@&{role}> ({name})",
  approvalTarget: "Target: <#{channel}>",
  approvalExpires: "Expires: <t:{expires}:R>",
  requestFooter: "Request ID: {id} • {status}",
  approvalPending: "Pending",
  approvalApproved: "Approved",
  approvalDenied: "Denied",
  approvalExpired: "Expired",
  approvalCancelled: "Cancelled",
  decisionBy: "{status} by {user}",
  requestNoLongerPending: "This request is no longer pending.",
  approverRequired:
    "You must have the requested access role and be in the target voice channel.",
  competingDecision:
    "Another decision was already recorded, or this request expired.",
  requestDenied: "Request denied.",
  requesterApprovalNotice:
    "<@{user}> your temporary voice access request was approved and your role has been assigned.",
  requesterNoLongerEligible:
    "The requester, role, or channel is no longer eligible. No role was assigned.",
  requestApproved: "Request approved and temporary access granted.",
  approvalAssignmentFailed:
    "The request was approved, but Discord could not assign the role yet. The bot will retry; contact an administrator if it remains unresolved.",
  requestExpired: "This request has expired.",
  requestPendingStatus: "Pending requests ({count}):",
  grantsStatus: "Active/cleanup grants ({count}):",
  grantStatusLine: "• `{id}` <@{user}> <@&{role}> — {state}{deadline}{error}",
  requestStatusLine:
    "• `{id}` <@{user}> <@&{role}> <#{channel}> expires <t:{expires}:R>",
  ownershipUncertainError: " (cleanup ownership uncertain)",
  cleanupError: " (cleanup error)",
  cleanupFailureNotice:
    "Temporary access cleanup failed for grant `{grant}` (<@{user}>, <@&{role}>). Cleanup will be retried; inspect with `/access-status`. Error: {error}",
} as const;

type TranslationKey = keyof typeof english;
type Language = GuildConfig["language"];

const german: Record<TranslationKey, string> = {
  guildOnly: "Dieser Befehl kann nur in einem Server verwendet werden.",
  unexpected:
    "Ein unerwarteter Fehler ist aufgetreten. Bitte versuche es erneut oder wende dich an einen Administrator.",
  noAssignableRoles: "Derzeit sind keine Zugangsrollen zur Anfrage verfügbar.",
  panelInvalid: "Dieses Anfrage-Panel ist ungültig.",
  manageRolesMissing:
    "Dem Bot fehlt die Berechtigung „Rollen verwalten“. Bitte wende dich an einen Administrator.",
  chooseVoiceChannel: "Wähle den Sprachkanal aus, zu dem du Zugang möchtest:",
  voiceChannelPlaceholder: "Ziel-Sprachkanal auswählen",
  roleRequestDescription: "{role} anfragen",
  panelSelectionInvalid: "Diese Auswahl ist abgelaufen oder gehört nicht dir.",
  chooseTargetChannel: "Wähle einen Ziel-Sprachkanal.",
  mappingNoLongerValid:
    "Dieser Sprachkanal ist nicht mehr genau einer Zugangsrolle zugeordnet. Bitte wende dich an einen Administrator.",
  roleNotRequestable:
    "Diese Rolle ist derzeit nicht für temporären Zugang konfiguriert.",
  channelNotMapped:
    "Dieser Sprachkanal ist der ausgewählten Rolle nicht zugeordnet.",
  noTargetChannel: "Für diese Rolle ist kein Ziel-Sprachkanal konfiguriert.",
  channelRequired:
    "Wähle einen Zielkanal aus, da dieser Rolle mehrere Kanäle zugeordnet sind.",
  targetUnavailable:
    "Der konfigurierte Zielkanal existiert nicht mehr oder ist kein Sprachkanal.",
  membershipUnavailable:
    "Deine Servermitgliedschaft konnte nicht überprüft werden. Bitte versuche es erneut.",
  alreadyHasRole: "Du hast diese Rolle bereits.",
  liveGrantExists: "Du hast bereits eine temporäre Freigabe für diese Rolle.",
  requestCooldown:
    "Bitte warte 30 Sekunden, bevor du erneut Zugriff auf diese Rolle anfragst.",
  requestChannelUnavailable:
    "Der Chat des Ziel-Sprachkanals ist für Genehmigungsnachrichten nicht verfügbar.",
  requestChannelPermissions:
    "Der Bot benötigt im Chat des Ziel-Sprachkanals die Berechtigungen „Kanal ansehen“, „Nachrichten senden“, „Links einbetten“ und „Nachrichtenverlauf anzeigen“.",
  duplicateRequest: "Du hast bereits eine offene Anfrage für diese Rolle.",
  requestSent:
    "Deine Anfrage für **{role}** in <#{channel}> wurde gesendet. Sie läuft <t:{expires}:R> ab.",
  postFailed:
    "Die Anfrage konnte nicht im Chat des Ziel-Sprachkanals gepostet werden. Bitte wende dich an einen Administrator.",
  adminOnly: "Die Administrator-Berechtigung ist erforderlich.",
  languageInvalid: "Wähle Englisch oder Deutsch.",
  languageConfiguration: "Sprache: {language}",
  selectedRoleUnavailable:
    "Die ausgewählte Rolle oder der Kanal ist nicht verfügbar.",
  roleNotSafe:
    "Diese Rolle ist verwaltet, privilegiert, @everyone oder steht nicht unter der höchsten Bot-Rolle.",
  voiceChannelRequired: "Wähle einen Sprach- oder Bühnenkanal dieses Servers.",
  channelAlreadyMapped:
    "Dieser Sprachkanal ist bereits einer anderen Zugangsrolle zugeordnet. Jeder Sprachkanal kann nur eine Zugangsrolle haben.",
  mappingSaveFailed:
    "Die Rollenzuordnung zum Kanal konnte nicht gespeichert werden.",
  mappingAdded: "<@&{role}> wurde für <#{channel}> konfiguriert.",
  mappingRemoved:
    "Die Zuordnung von <@&{role}> zu <#{channel}> wurde entfernt.",
  panelTextChannel: "Wähle einen Textkanal dieses Servers.",
  panelPermissions:
    "Der Bot benötigt in diesem Kanal die Berechtigungen „Kanal ansehen“ und „Nachrichten senden“.",
  panelPosted: "Das Anfrage-Panel wurde in <#{channel}> gepostet.",
  panelContent:
    "**Temporärer Sprachzugang**\nKlicke unten, um einen Sprachkanal auszuwählen. Mitglieder mit der zugeordneten Rolle können deine Anfrage genehmigen, während sie sich im Kanal befinden.",
  requestButton: "Zugang anfragen",
  languageEnglishSet: "Sprache auf Englisch eingestellt.",
  languageGermanSet: "Sprache auf Deutsch eingestellt.",
  timersUpdated:
    "Timer aktualisiert: Beitritt {join}s, Karenzzeit nach Verlassen {grace}s, Anfrageablauf {expiration}s.",
  configApprovalRouting:
    "Genehmigungsanfragen werden im Chat des Ziel-Sprachkanals gepostet.",
  configInitialTimer:
    "Erstbeitritt: {join}s; Karenzzeit nach Verlassen: {grace}s; Anfrageablauf: {expiration}s",
  configMappings: "Rollenzuordnungen: {mappings}",
  configApprovers:
    "Genehmigen können Mitglieder mit der angefragten Zugangsrolle im zugehörigen Sprachkanal.",
  configEmpty: "keine",
  noPendingRequestOrGrant:
    "Keine offene Anfrage oder temporäre Freigabe mit dieser ID gefunden.",
  requestCancelled: "Die offene Anfrage wurde abgebrochen.",
  requestNotPending: "Die Anfrage ist nicht mehr offen.",
  grantAlreadyEnded: "Diese Freigabe ist bereits beendet.",
  grantRevoked: "Temporäre Rolle wurde entzogen.",
  cleanupNotSafe:
    "Die Rolle konnte nicht sicher entfernt werden; die Freigabe bleibt als {state} zur Prüfung durch einen Administrator bestehen.",
  approvalControlInvalid: "Diese Genehmigungsaktion ist ungültig.",
  accept: "Genehmigen",
  deny: "Ablehnen",
  approvalPingText: "Neue Anfrage für temporären Zugang",
  approvalTitle: "Anfrage für Sprachzugang",
  approvalRequester: "Anfragende Person: <@{user}>",
  approvalRole: "Rolle: <@&{role}> ({name})",
  approvalTarget: "Ziel: <#{channel}>",
  approvalExpires: "Läuft ab: <t:{expires}:R>",
  requestFooter: "Anfrage-ID: {id} • {status}",
  approvalPending: "Offen",
  approvalApproved: "Genehmigt",
  approvalDenied: "Abgelehnt",
  approvalExpired: "Abgelaufen",
  approvalCancelled: "Abgebrochen",
  decisionBy: "{status} von {user}",
  requestNoLongerPending: "Diese Anfrage ist nicht mehr offen.",
  approverRequired:
    "Du benötigst die angefragte Zugangsrolle und musst dich im Ziel-Sprachkanal befinden.",
  competingDecision:
    "Eine andere Entscheidung wurde bereits getroffen oder die Anfrage ist abgelaufen.",
  requestDenied: "Anfrage abgelehnt.",
  requesterApprovalNotice:
    "<@{user}> deine Anfrage für temporären Sprachzugang wurde genehmigt und deine Rolle wurde zugewiesen.",
  requesterNoLongerEligible:
    "Anfragende Person, Rolle oder Kanal ist nicht mehr berechtigt. Es wurde keine Rolle vergeben.",
  requestApproved: "Anfrage genehmigt und temporärer Zugang erteilt.",
  approvalAssignmentFailed:
    "Die Anfrage wurde genehmigt, aber Discord konnte die Rolle noch nicht vergeben. Der Bot versucht es erneut; wende dich bei anhaltendem Problem an einen Administrator.",
  requestExpired: "Diese Anfrage ist abgelaufen.",
  requestPendingStatus: "Offene Anfragen ({count}):",
  grantsStatus: "Aktive Freigaben/Bereinigungen ({count}):",
  grantStatusLine: "• `{id}` <@{user}> <@&{role}> — {state}{deadline}{error}",
  requestStatusLine:
    "• `{id}` <@{user}> <@&{role}> <#{channel}> läuft <t:{expires}:R> ab",
  ownershipUncertainError: " (unklare Rollenzugehörigkeit)",
  cleanupError: " (Bereinigungsfehler)",
  cleanupFailureNotice:
    "Die Bereinigung des temporären Zugangs für Freigabe `{grant}` (<@{user}>, <@&{role}>) ist fehlgeschlagen. Sie wird erneut versucht; Details mit `/access-status`. Fehler: {error}",
};

export function translate(
  language: Language,
  key: TranslationKey,
  values: Record<string, string | number> = {},
): string {
  const template = language === "de" ? german[key] : english[key];
  return template.replace(/\{([^}]+)\}/g, (match, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : match,
  );
}

export type { Language, TranslationKey };

export function localizedGrantState(language: Language, state: string): string {
  if (language === "en") return state.replaceAll("_", " ");
  const states: Record<string, string> = {
    assignment_pending: "Rollenzuweisung ausstehend",
    awaiting_initial_join: "Wartet auf ersten Beitritt",
    active: "Aktiv",
    grace_period: "Karenzzeit",
    cleanup_pending: "Bereinigung ausstehend",
    ownership_uncertain: "Rollenzugehörigkeit unklar",
    expired: "Abgelaufen",
    revoked: "Widerrufen",
  };
  return states[state] ?? state;
}
