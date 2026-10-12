# `src/web/admin.ts`

This module serves the settings interface and JSON API with Node's built-in
HTTP server. When bound to a loopback address, unauthenticated access is
allowed only for connections whose local listener and peer addresses are both
loopback. If an auth secret is configured, it is still required for local
requests. Non-loopback access requires the configured secret, compared using
constant-time byte comparison. A reverse proxy must remove client-supplied
copies of the configured header and inject its own value only after the
website's existing authentication succeeds.

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
tested without binding a public listener. The interface starts without a
secret only when `WEB_ADMIN_HOST` is localhost or a loopback IP address.
API payloads are size limited,
Discord IDs and timer values are validated, roles are checked against the
bot's role hierarchy, and failures are logged without request bodies or
credentials. The API exposes only connected server configuration and does not
include any Discord credential routes.
