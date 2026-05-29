![pi-config header](https://iili.io/C2G25PV.png)

# pi-config

Personal configuration repository for the `pi` coding agent.

## Current setup

- Default provider/model: `openai-codex/gpt-5.5`
- Default thinking level: `low`
- Enabled models:
  - `openai-codex/gpt-5.5`
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
- `agent/skills/` — local agent skills.
- `agent/zshrc` — lightweight zsh startup sourced only for pi user bash commands.
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

## Custom skills

| Skill | What it does |
| --- | --- |
| `pi-extensions/` | Reference for writing and debugging pi extensions. |

## Custom extensions

| Extension | What it does | Commands / shortcuts |
| --- | --- | --- |
| `agent-pulse/` | Unified agent activity indicator: replaces the built-in working indicator with a two-space-indented activity pulse colored through the same thinking-level border resolver as the input editor, adds a bold shimmer/pulse over the active message text, owns the terminal title, shows working/tool/done states from one shared spinner clock, keeps the final elapsed-time status visible until the next request, and rings the terminal bell when an agent turn finishes. | — |
| `answer.ts` | Extracts questions from the last assistant message, opens an interactive Q&A TUI, then sends the compiled answers back into the session. Prefers `openai-codex/gpt-5.3` for extraction when available, then falls back to Claude Haiku or the current model. | `/answer`, `ctrl+.` |
| `codex-quotas.ts` | Fetches ChatGPT/Codex subscription quota from `chatgpt.com/backend-api/wham/usage`, retries transient failures after 2s and 5s, caches it, refreshes it on session/model/turn events, and exposes footer status for Codex models. Footer reset time and percentage use ANSI black by default, then warning/error theme colors as quota gets low; command output is dim/gray. Uses `openai-codex` OAuth from pi auth and falls back to `~/.codex/auth.json` for account id. | `/codex:quotas` |
| `compact.ts` | Automatically compacts context before agent start when context usage exceeds `256000` tokens. | — |
| `context-limit-warning.ts` | Shows a UI warning after an agent response first crosses `128000` context tokens, then warns again only after usage drops below the threshold and crosses it later. | — |
| `deepseek-balance.ts` | Shows DeepSeek account balance for DeepSeek models, immediately reuses the last successful balance when switching back, and refreshes it asynchronously on session/model/turn events so model switching is not blocked by the balance request. Reads the API key from `~/.pi/agent/auth.json` (`deepseek.key`, `deepseek.apiKey`, or `deepseek.token`). | `/deepseek:balance` |
| `default-reasoning.ts` | Applies model-specific thinking defaults on manual model selection: DeepSeek → `high`, `gpt-5.4-mini` → `medium`, other GPT models → `low`, non-reasoning models → `off`. Skips restored session selections. | — |
| `ui-editor.ts` | Owns the custom input editor behavior: removes the editor's horizontal separator bars and auto-triggers autocomplete for `$skill-name` syntax. Project/model labels now live in the footer. | — |
| `generation-stats.ts` | Tracks assistant generation speed during an agent run: live tokens/sec, time to first token, final output tokens, and final streaming summary. Keeps the footer/status entry active without showing `done`. | — |
| `handoff.ts` | Writes a compact handoff markdown document for a fresh agent into the OS temp directory (`pi-handoffs/`). Uses the current model, the active session branch, a local suggested-skills allowlist, and best-effort secret redaction before and after summarisation. Streams model thinking notices when the provider exposes them, otherwise streams an in-conversation preview of the generated handoff text. Writes metadata-only debug events to `~/.pi/logs/handoff-debug.log`. | `/handoff [focus]` |
| `openrouter-balance.ts` | Shows OpenRouter account balance for OpenRouter models, immediately reuses the last successful balance when switching back, and refreshes it asynchronously on session/model/turn events so model switching is not blocked by the balance request. Reads the API key from `~/.pi/agent/auth.json` (`openrouter.key`, `openrouter.apiKey`, or `openrouter.token`). | `/openrouter:balance` |
| `header.ts` | Replaces the built-in header with a slightly brighter smooth darker-to-lighter gradient derived from the current theme thinking level color, showing the selected model and project name; it rerenders when thinking level changes. | — |
| `prompt-audit.ts` | Logs the initial pi prompt breakdown and the serialized provider request payload to `~/.pi/logs/prompt-audit` for prompt/token auditing. Supports one-shot, persistent, environment-enabled, and status modes. | `/prompt-audit [once\|on\|off\|status]`, `PI_PROMPT_AUDIT=1` |
| `ui-footer.ts` | Installs a two-line custom footer with two-cell horizontal padding: the first line shows project path/git branch on the left and selected model/thinking level on the right; the second line shows token/cost/context stats on the left and extension statuses on the right. Context usage is shown as absolute current/window tokens (`44k/272k`) instead of a percentage. Footer text uses the active thinking-level theme color; extension-provided ANSI colors are stripped before display. | — |
| `commands-aliases.ts` | Adds short slash-command aliases for quitting, starting a new session, and showing Codex quota status. | `/exit`, `/q`, `/e`, `/n`, `/status` |
| `skill-dollar.ts` | Adds `$skill-name` shorthand for Pi skill commands: provides autocomplete items and rewrites leading `$skill-name [args]` input to built-in `/skill:name [args]`, preserving Pi's native skill expansion/rendering (`[skill] ... ctrl+o to expand`). The `$` autocomplete auto-trigger lives in `ui-editor.ts` because only one extension can own the custom editor. | `$<skill-name> [args]` shorthand |
| `yeet.ts` | Adds a command that asks the agent to add all changes, inspect staged changes, generate a concise commit message, commit, push to the current branch/upstream, set upstream when needed, and print the repository or pull-request URL; `main` and `master` are both treated as default branches. Extra command arguments are appended as additional user instructions. | `/yeet [instructions]` |
| `zsh.ts` | Runs user bash commands through non-interactive zsh (`PI_USER_BASH=1 zsh -fc ...`) while preserving pi's local bash operations. Avoids sourcing `~/.zshrc`; sources `~/.pi/agent/zshrc` instead for safe aliases/functions, then evals the command so aliases expand. Honors `PI_USER_BASH_SHELL`, `PI_USER_ZSHRC`, then falls back to `$SHELL` or `/bin/zsh`. | — |
