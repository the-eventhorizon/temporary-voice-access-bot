# `src/web/admin.ts`

This module serves the optional settings interface and JSON API with Node's
built-in HTTP server. It is enabled only when the reverse-proxy authentication
secret is configured. Every request must include the configured header with
the exact shared secret; comparison uses constant-time byte comparison. The
proxy must remove client-supplied copies of that header and inject its own
value only after the website's existing authentication succeeds.

Mutating requests additionally require an `Origin` whose host matches the
forwarded request `Host`, preventing cross-site form requests. Responses do
not enable CORS, are marked no-store, and the HTML page has a restrictive
content security policy.

The page provides per-server timer and language settings, safe
role-to-voice-channel mapping add/remove operations, and request-panel posting.
Discord bot tokens, application IDs, and guild IDs are deliberately excluded
from both the UI and API. Configure those values only through environment
variables; the web admin does not return, persist, or modify them.

`createAdminServer()` accepts an injected Discord client/database and can be
tested without binding a public listener. API payloads are size limited,
Discord IDs and timer values are validated, roles are checked against the
bot's role hierarchy, and failures are logged without request bodies or
credentials. The API exposes only connected server configuration and does not
include any Discord credential routes.
