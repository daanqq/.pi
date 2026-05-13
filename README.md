# pi-config

Personal configuration for the `pi` coding agent.

## Contents

- `agent/settings.json` — agent preferences
- `agent/SYSTEM.md` — custom system prompt
- `agent/extensions/` — local extensions
- `agent/themes/` — custom themes
- `web-search.json` — web search defaults

## Custom extensions

- `compact.ts` — automatically compacts context before agent start when usage exceeds 256k tokens.
- `deepseek-balance.ts` — shows DeepSeek API balance in the footer for DeepSeek models and adds `/deepseek:balance`. Requires `DEEPSEEK_PI_API_KEY`.
- `header.ts` — replaces the default header with a blue gradient session title. Adds `/flow-title` and `/flow-title-builtin`.
- `shortcuts.ts` — adds command aliases: `/exit`, `/q`, `/e` to quit pi, and `/status` as an alias for `/codex:quotas`.
