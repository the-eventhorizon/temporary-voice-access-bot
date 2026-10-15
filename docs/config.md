# `src/config.ts`

This module loads environment variables using `dotenv/config`, validates and
converts them with Zod, then exports the typed `config` object. Importing it
fails fast with a validation error if a required credential is missing or a
configured value has the wrong shape.

## Settings

| Property                         | Validation and fallback                                                | Used for                                                                    |
| -------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `APP_ENV`                        | `local`, `dev`, or `prod`; defaults to `local`                         | Selects deployment mode; `prod` requires a web-admin auth secret.           |
| `DISCORD_TOKEN`                  | Required non-empty string                                              | Gateway login and REST authentication.                                      |
| `DISCORD_APPLICATION_ID`         | Required non-empty string                                              | Slash-command registration target.                                          |
| `DISCORD_DEFAULT_GUILD_ID`       | Optional string, defaults to empty                                     | When present, register commands to this guild; otherwise register globally. |
| `DATABASE_PATH`                  | Non-empty string, defaults to `./data/access-bot.sqlite`               | SQLite file path.                                                           |
| `INITIAL_JOIN_TIMEOUT_SECONDS`   | Coerced positive integer, defaults to `90`                             | Initial timer default for new guild records.                                |
| `DEPARTURE_GRACE_PERIOD_SECONDS` | Coerced positive integer, defaults to `90`                             | Departure timer default for new guild records.                              |
| `REQUEST_EXPIRATION_SECONDS`     | Coerced positive integer, defaults to `300`                            | Approval-request expiration default for new guild records.                  |
| `LOG_LEVEL`                      | `debug`, `info`, `warn`, or `error`; defaults to `info`                | Minimum severity emitted by the logger.                                     |
| `WEB_ADMIN_HOST`                 | Defaults to `127.0.0.1`; empty with empty port disables the interface  | Listener bind address for the optional web interface.                       |
| `WEB_ADMIN_PORT`                 | Defaults to `8787`; empty with empty host disables the interface       | Listener port.                                                              |
| `WEB_ADMIN_AUTH_HEADER`          | Defaults to `X-Website-Admin`                                          | Trusted header that the authenticated reverse proxy injects.                |
| `WEB_ADMIN_AUTH_SECRET`          | Optional in `local`/`dev`; required in `prod`; 32+ characters when set | Web-admin authentication; never sent to browser JavaScript.                 |

In `local` and `dev`, an auth secret may be omitted. Without a secret,
unauthenticated access is limited to loopback-bound listeners and loopback
clients. If configured, the secret is required for every request. In `prod`,
startup fails unless `WEB_ADMIN_AUTH_SECRET` is set to at least 32 characters
when the web interface is enabled. Set both `WEB_ADMIN_HOST` and
`WEB_ADMIN_PORT` to empty to disable it; setting only one empty is invalid.
Non-loopback binds should only be used behind a trusted reverse proxy.

Environment timer values seed a guild's SQLite settings the first time that
guild is read/initialized. They do not overwrite persisted values on later
starts. Administrators update an existing guild's timer values with
`/access-config timers`.

## Security

The module never logs the token. Keep `.env` private and out of source control.
Configuration contains no role, channel, or guild authorization policy; those
values are persisted and checked in the database and interaction layer.

See [`web/admin.md`](web/admin.md) for the web-admin reverse-proxy contract.
The reverse proxy must strip any website mount prefix before forwarding to the
bot and preserve the original `Host` header.
