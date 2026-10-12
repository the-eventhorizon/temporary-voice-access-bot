# `src/localization.ts`

This module contains the English and German user-facing message catalogs used
by commands, request-panel interactions, approval messages, and grant cleanup
notifications.

`translate(language, key, values)` selects the requested catalog and replaces
`{name}` placeholders with supplied string or numeric values. Both catalogs
must define the same keys; `TranslationKey` is derived from the English
catalog and the German catalog is typed as a complete `Record` to catch
missing translations at compile time.

`localizedGrantState(language, state)` renders grant lifecycle states in the
selected language for the administrator status command. Unknown states are
displayed with underscores replaced by spaces in English and left unchanged
in German.

The active language is stored per guild in `guild_config.language`. New guild
records default to English; `/access-config language` changes the setting.
The translation applies when messages are generated or updated. Previously
posted request-panel content is not edited when the guild setting changes,
though new interactions use the latest setting.

Discord application-command names and option names remain stable identifiers.
Their descriptions have German localizations in
`src/commands/definitions.ts`; Discord selects those based on the user's client
locale independently of the guild's configured runtime message language.
