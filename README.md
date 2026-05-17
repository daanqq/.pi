# pi-config

Personal configuration repository for the `pi` coding agent.

## Current setup

- Default provider/model: `openai-codex/gpt-5.5`
- Default thinking level: `low`
- Theme: `alabaster`
- Quiet startup enabled
- Built-in compaction enabled
- Skill commands enabled
- Installed pi packages:
  - `pi-web-access`
  - `pi-rtk-optimizer`
  - `pi-total-recall`

## Tracked files

- `agent/settings.json` — main pi settings: model defaults, packages, UI behavior, enabled models, terminal/editor preferences.
- `agent/extensions/` — local TypeScript extensions.
- `agent/extensions/pi-rtk-optimizer/config.json` — local RTK/output compaction settings.
- `agent/themes/alabaster.json` — custom theme.
- `web-search.json` — web-search defaults.
- `.gitignore` — excludes local auth, sessions, memory DBs, indexes, logs, caches, and editor files.

## Local/runtime files intentionally not tracked

- `agent/auth.json` and backups — local provider credentials.
- `agent/sessions/` — local pi session logs.
- `memory/` — local memory database.
- `session-search/` — local session-search index.
- `*.db`, `*.db-shm`, `*.db-wal`, `*.sqlite*` — runtime databases.
- `.env*`, keys, logs, cache and editor directories.

## Custom extensions

| Extension | What it does | Commands / shortcuts |
| --- | --- | --- |
| `answer.ts` | Extracts questions from the last assistant message, opens an interactive Q&A TUI, then sends the compiled answers back into the session. Prefers `openai-codex/gpt-5.3` for extraction when available, then falls back to Claude Haiku or the current model. | `/answer`, `ctrl+.` |
| `codex-quotas.ts` | Fetches ChatGPT/Codex subscription quota from `chatgpt.com/backend-api/wham/usage`, caches it, refreshes it on session/model/turn events, and exposes footer status for Codex models. Uses `openai-codex` OAuth from pi auth and falls back to `~/.codex/auth.json` for account id. | `/codex:quotas` |
| `compact.ts` | Automatically compacts context before agent start when context usage exceeds `256000` tokens. | — |
| `deepseek-balance.ts` | Shows DeepSeek account balance for DeepSeek models and refreshes it on session/model/turn events. Requires `DEEPSEEK_PI_API_KEY`. | `/deepseek:balance` |
| `header.ts` | Replaces the built-in header with a blue gradient block logo showing the selected model and project name. | `/flow-title`, `/flow-title-builtin` |
| `right-status-footer.ts` | Installs a custom footer with cwd, git branch, session name, token/cost/context stats, model/thinking level, and moves selected extension statuses (`codex-quotas`, `deepseek-balance`) to the right side. | — |
| `shortcuts.ts` | Adds quit aliases and a status shortcut that delegates to the Codex quota command. | `/exit`, `/q`, `/e`, `/status` |
| `skill-dollar.ts` | Adds inline `$skill-name` skill selection: autocomplete after `$`, resolves selected skills, injects their `SKILL.md` content into the next turn, and warns on unknown/unreadable skills. | `$<skill-name>` inline syntax |
