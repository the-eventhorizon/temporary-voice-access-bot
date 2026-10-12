# `src/logger.ts`

This module exports one structured logging function:

```ts
log(level, message, context?)
```

## Behavior

- Accepted levels are `debug`, `info`, `warn`, and `error`, with numeric
  ordering from least to most severe.
- The minimum emitted level is read from `process.env.LOG_LEVEL` when this
  module is imported. An absent or invalid value falls back to `info`.
- Each emitted line is a JSON object containing an ISO timestamp, level,
  message, and supplied context properties.
- Error records go to `console.error`, warning records to `console.warn`, and
  debug/info records to `console.log`.

Callers should include useful identifiers such as guild, request, grant, or
member IDs, and a sanitized error message. Do not include bot tokens or other
credentials. Error handling remains at call sites so operations can add
appropriate retries, user responses, or cleanup state rather than relying on
the logger to alter application behavior.
