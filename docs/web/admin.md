# `src/web/admin.ts`

This module serves the settings interface and JSON API with Node's built-in
HTTP server. `APP_ENV` supports `local`, `dev`, and `prod` (default: `local`). In `local`
and `dev`, the secret may be omitted; then unauthenticated access is allowed
only for connections where both the listener and peer addresses are loopback.
If a secret is configured, it is required on all requests. `prod` requires a
secret of at least 32 characters at startup. Secrets are compared using
constant-time byte comparison. A reverse proxy must remove client-supplied
copies of the configured header and inject its own value only after the
website's existing authentication succeeds.

Mutating requests additionally require an `Origin` whose host matches the
forwarded request `Host`, preventing cross-site form requests. Responses do
not enable CORS, are marked no-store, and the HTML page has a restrictive
content security policy. The page allows same-origin base URLs for reverse
proxy subpaths and `data:` images for the embedded SVG favicon.

The page provides per-server timer and Discord-message language settings, safe
role-to-voice-channel mapping add/remove operations, and request-panel posting.
Its own interface language (English or German) and light/dark theme are
independent of the server's language setting and saved in browser local
storage. The interface uses the logo palette: orange `#ff6700`, black
`#151515`, and off-white `#e5e5e5`, with separate light and dark surfaces.
The original orange LES icon SVG is embedded as the page favicon.
Discord bot tokens, application IDs, and guild IDs are deliberately excluded
from both the UI and API. Configure those values only through environment
variables; the web admin does not return, persist, or modify them.

`createAdminServer()` accepts an injected Discord client/database and can be
tested without binding a public listener. In `local` and `dev`, the interface
starts without a secret only when `WEB_ADMIN_HOST` is localhost or a loopback
IP address. In `prod`, configuration validation always requires a secret.
API payloads are size limited,
Discord IDs and timer values are validated, roles are checked against the
bot's role hierarchy, and failures are logged without request bodies or
credentials. The API exposes only connected server configuration and does not
include any Discord credential routes.
