![pi-config screenshot](https://iili.io/C2mIO2n.png)

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

## Handoff implementation flow

`/handoff-implement [focus]` automates the old manual handoff-to-new-session workflow:

1. waits for the current agent to become idle;
2. summarizes the active session branch and current git snapshot with the current model;
3. writes two temp artifacts under `pi-handoffs/`: `handoff-*.md` and `plan-*.md`;
4. reads `readiness` from generated metadata;
5. when ready, optionally confirms and starts a fresh session with a kickoff prompt that tells the new agent to read both artifacts before editing.

Flags:

- `--draft` — only generate files and prefill the editor with the kickoff prompt; do not create a new session.
- `--force` — allow starting even when the generated plan says `readiness: blocked`.
- `--no-confirm` — skip the interactive confirmation when the plan is ready.

If artifact splitting fails, raw model output is saved as `handoff-implement-raw-*.md` and no new session is started.

## Local/runtime files intentionally not tracked

- `agent/auth.json` and backups — local provider credentials.
- `agent/sessions/` — local pi session logs.
- `agent/codex-usage-state.json`, `agent/codex-rotation-state.json`, `agent/codex-usage.lock/`, `agent/codex-rotation.lock/` — local Codex usage/rotation runtime state and locks.
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
| `agent-pulse.ts` | Unified agent activity indicator: replaces the built-in working indicator with a two-space-indented, terminal-width-truncated activity pulse colored through the same thinking-level border resolver as the input editor, adds a bold shimmer/pulse over the active message text, owns the terminal title, shows working/tool/done states from one shared spinner clock, keeps the final elapsed-time status visible until the next request, and rings the terminal bell when an agent turn finishes. | — |
| `answer.ts` | Extracts questions from the last assistant message, opens an interactive Q&A TUI, then sends the compiled answers back into the session. Prefers `openai-codex/gpt-5.3` for extraction when available, then falls back to Claude Haiku or the current model. | `/answer`, `ctrl+.` |
| `codex-usage/` | Unified Codex usage extension: owns `/codex:quotas`, compact footer quota status without a leading `codex` label, and Codex OAuth profile rotation. It fetches ChatGPT/Codex 5h/7d quota from `chatgpt.com/backend-api/wham/usage`, refetches the active footer quota every 60 seconds so percentages stay current even when rotation is disabled, rotates `openai-codex` credentials across saved `ca` profiles when quota drops below 5%, scores candidates by the weaker quota window, avoids mid-provider-request switching, marks 429/auth-error cooldowns, persists global state in `~/.pi/agent/codex-usage-state.json` with legacy read fallback from `codex-rotation-state.json`, uses a global lock for multi-process safety, and watches state changes to reload auth in other Pi processes. It does not rotate in `before_agent_start`, so prompt submission is not blocked by quota scans. | `/codex:quotas`, `/codex:rotate status`, `/codex:rotate now`, `/codex:rotate on`, `/codex:rotate off`, `/codex:rotate profile <name>`, `/codex:rotate scan` |
| `codex-review.ts` | Adds a Codex-style `/review` command in one self-contained extension file: selects or accepts the base comparison branch and target changes branch, injects the Codex review prompt, reviews tracked/untracked changes with `git diff <merge-base>..<target-branch>`, and reformats JSON review output into readable cards. When run outside a git repository, discovers immediate child git repositories, lets the user select one or more, asks for branch pairs per repository, and prompts the agent to pass the full Codex review prompt/schema to each subagent before synthesizing a shared result. | `/review [--base branch]` |
| `compact.ts` | Automatically compacts context before agent start when context usage exceeds `256000` tokens. | — |
| `context-limit-warning.ts` | Shows a UI warning after an agent response first crosses `128000` context tokens, then warns again only after usage drops below the threshold and crosses it later. | — |
| `balance.ts` | Shows DeepSeek and OpenRouter account balances for their respective models, immediately reuses each provider's last successful balance when switching back, and refreshes asynchronously on session/model/turn events so model switching is not blocked by balance requests. Reads API keys from `~/.pi/agent/auth.json` (`deepseek.*` and `openrouter.*`: `key`, `apiKey`, or `token`). | `/deepseek:balance`, `/openrouter:balance` |
| `default-reasoning.ts` | Applies model-specific thinking defaults on manual model selection: DeepSeek/Xiaomi/`gpt-5.4-mini` → `high`, other GPT models → `low`, non-reasoning models → `off`. Skips restored session selections. In non-empty sessions, appends `• Context cache will be invalidated` to the native model-switch status line for any model change and to the native thinking-level status line for GPT/OpenAI thinking changes; switching model or thinking back to the runtime's initial value clears/skips the warning, and reload/startup treats the current model/thinking as the new baseline. | — |
| `ui-editor.ts` | Owns the custom input editor behavior: removes the editor's horizontal separator bars and auto-triggers autocomplete for `$skill-name` syntax. Project/model labels now live in the footer. | — |
| `generation-stats.ts` | Tracks assistant generation speed during an agent run: live tokens/sec, time to first token, final output tokens, and final streaming summary. Keeps the footer/status entry active without showing `done`. | — |
| `handoff.ts` | Writes compact handoff artifacts into the OS temp directory (`pi-handoffs/`). `/handoff` creates a summary document for a fresh agent. `/handoff-implement` generates both a handoff and an implementation-plan contract from the current session branch and git snapshot, gates on plan readiness, and can start a fresh implementation session with a kickoff prompt referencing both files. Uses the current model, a local suggested-skills allowlist, and best-effort secret redaction. | `/handoff [focus]`, `/handoff-implement [--draft] [--force] [--no-confirm] [focus]` |
| `ui-header.ts` | Replaces the built-in header with a slightly brighter smooth darker-to-lighter gradient derived from the current theme thinking level color; it rerenders when thinking level changes. | — |
| `prompt-audit.ts` | Logs the initial pi prompt breakdown and the serialized provider request payload to `~/.pi/logs/prompt-audit` for prompt/token auditing. Supports one-shot, persistent, environment-enabled, and status modes. | `/prompt-audit [once\|on\|off\|status]`, `PI_PROMPT_AUDIT=1` |
| `ui-footer.ts` | Installs a two-line custom footer with two-cell horizontal padding: the first line shows project path/git branch on the left and selected model/thinking level on the right; the second line shows token/cost/context stats on the left and extension statuses on the right. Subscription-backed model cost is shown as plain `$0.000` without a `(sub)` suffix. Context usage is shown as absolute current/window tokens (`44k/272k`) instead of a percentage. Footer text uses the active thinking-level theme color; extension-provided ANSI colors are stripped before display. | — |
| `commands-aliases.ts` | Adds short slash-command aliases for quitting, starting a new session, and showing Codex quota status. | `/exit`, `/q`, `/e`, `/n`, `/status` |
| `skill-dollar.ts` | Adds `$skill-name` shorthand for Pi skill commands: provides autocomplete items and rewrites leading `$skill-name [args]` input to built-in `/skill:name [args]`, preserving Pi's native skill expansion/rendering (`[skill] ... ctrl+o to expand`). The `$` autocomplete auto-trigger lives in `ui-editor.ts` because only one extension can own the custom editor. | `$<skill-name> [args]` shorthand |
| `yeet.ts` | Adds a command that asks the agent to add all changes, inspect staged changes, generate a concise commit message, commit, push to the current branch/upstream, set upstream when needed, and print the repository or pull-request URL; `main` and `master` are both treated as default branches. Extra command arguments are appended as additional user instructions. | `/yeet [instructions]` |
| `zsh.ts` | Runs user bash commands through non-interactive zsh (`PI_USER_BASH=1 zsh -fc ...`) while preserving pi's local bash operations. Avoids sourcing `~/.zshrc`; sources `~/.pi/agent/zshrc` instead for safe aliases/functions, including the `ca`/`codexauth` helper with JSON API for Codex rotation, then evals the command so aliases expand. Honors `PI_USER_BASH_SHELL`, `PI_USER_ZSHRC`, then falls back to `$SHELL` or `/bin/zsh`. | — |
