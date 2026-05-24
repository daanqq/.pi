# pi-config

Personal configuration repository for the `pi` coding agent.

## Current setup

- Default provider/model: `openai-codex/gpt-5.5`
- Default thinking level: `low`
- Enabled models:
  - `openai-codex/gpt-5.5`
  - `openai-codex/gpt-5.4`
  - `openai-codex/gpt-5.4-mini`
  - `deepseek/deepseek-v4-flash`
  - `deepseek/deepseek-v4-pro`
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
| `agent-status.ts` | Owns the terminal title while loaded, shows idle/working/tool/done/error states with short-dash separators, and rings the terminal bell when an agent turn finishes. | — |
| `answer.ts` | Extracts questions from the last assistant message, opens an interactive Q&A TUI, then sends the compiled answers back into the session. Prefers `openai-codex/gpt-5.3` for extraction when available, then falls back to Claude Haiku or the current model. | `/answer`, `ctrl+.` |
| `codex-quotas.ts` | Fetches ChatGPT/Codex subscription quota from `chatgpt.com/backend-api/wham/usage`, caches it, refreshes it on session/model/turn events, and exposes footer status for Codex models. Reset time, percentage, and command output use the same quota color. Uses `openai-codex` OAuth from pi auth and falls back to `~/.codex/auth.json` for account id. | `/codex:quotas` |
| `compact.ts` | Automatically compacts context before agent start when context usage exceeds `256000` tokens. | — |
| `deepseek-balance.ts` | Shows DeepSeek account balance for DeepSeek models and refreshes it on session/model/turn events. Reads the API key from `~/.pi/agent/auth.json` (`deepseek.key`, `deepseek.apiKey`, or `deepseek.token`). | `/deepseek:balance` |
| `default-reasoning.ts` | Applies model-specific thinking defaults on manual model selection: DeepSeek → `high`, `gpt-5.4-mini` → `medium`, other GPT models → `low`, non-reasoning models → `off`. Skips restored session selections. | — |
| `generation-stats.ts` | Tracks assistant generation speed during an agent run: live tokens/sec, time to first token, final output tokens, and final streaming summary. Keeps the footer/status entry active without showing `done`. | — |
| `handoff.ts` | Writes a compact handoff markdown document for a fresh agent into the OS temp directory (`pi-handoffs/`). Uses the current model, the active session branch, a local suggested-skills allowlist, and best-effort secret redaction before and after summarisation. | `/handoff [focus]` |
| `header.ts` | Replaces the built-in header with a blue gradient 'pi' logo showing the selected model and project name. | `/flow-title`, `/flow-title-builtin` |
| `prompt-audit.ts` | Logs the initial pi prompt breakdown and the serialized provider request payload to `~/.pi/logs/prompt-audit` for prompt/token auditing. Supports one-shot, persistent, environment-enabled, and status modes. | `/prompt-audit [once\|on\|off\|status]`, `PI_PROMPT_AUDIT=1` |
| `custom-footer.ts` | Installs a custom footer with cwd, git branch, session name, token/cost/context stats, model/thinking level, and moves selected extension statuses (`codex-quotas`, `deepseek-balance`, `generation-stats`) to the right side. Plain footer text uses the theme `text` color while warning/error and extension-provided colors are preserved, including when the footer is truncated. | — |
| `shortcuts.ts` | Adds quit aliases, a new-session alias, and a status shortcut that delegates to the Codex quota command. | `/exit`, `/q`, `/e`, `/n`, `/status` |
| `skill-dollar.ts` | Adds inline `$skill-name` skill selection: autocomplete after `$`, resolves selected skills, injects their `SKILL.md` content into the next turn, and warns on unknown/unreadable skills. | `$<skill-name>` inline syntax |
| `zsh.ts` | Runs user bash commands through interactive zsh (`PI_USER_BASH=1 zsh -ic ...`) so local shell setup is available while preserving pi's local bash operations. Honors `PI_USER_BASH_SHELL` before falling back to `$SHELL` or `/bin/zsh`. | — |
