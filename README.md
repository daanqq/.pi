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
5. when ready, starts a fresh session by default with a kickoff prompt that tells the new agent to read both artifacts before editing; pass `--confirm` to require an interactive confirmation first.

Flags:

- `--draft` — only generate files and prefill the editor with the kickoff prompt; do not create a new session.
- `--force` — allow starting even when the generated plan says `readiness: blocked`.
- `--confirm` — ask for interactive confirmation before starting the fresh implementation session.

Progress while `/handoff-implement` runs is refreshed every second. `Esc` cancels in-flight handoff generation; `/quit` aborts it before shutdown.

If artifact splitting fails, raw model output is saved as `handoff-implement-raw-*.md` and no new session is started.

## Local/runtime files intentionally not tracked

- `agent/auth.json` and backups — local provider credentials.
- `agent/sessions/` — local pi session logs.
- `agent/codex-usage/` — local Codex usage/rotation runtime state, lock, and plaintext profile credentials.
- `memory/` — local memory database.
- `session-search/` — local session-search index.
- `*.db`, `*.db-shm`, `*.db-wal`, `*.sqlite*` — runtime databases.
- `.env*`, keys, logs, cache and editor directories.

## Custom skills

| Skill | What it does |
| --- | --- |
| `pi-extensions/` | Reference for writing and debugging pi extensions. |

## Custom prompt templates

| Template | What it does | Command |
| --- | --- | --- |
| `yeet.md` | Expands into the add/commit/push workflow: stage all changes, inspect the staged diff, commit with a concise generated message, push with upstream tracking when needed, and print the repository or pull-request URL. Extra arguments are included as additional instructions. | `/yeet [instructions]` |

## Custom extensions

| Extension | What it does | Commands / shortcuts |
| --- | --- | --- |
| `agent-pulse.ts` | Unified agent activity indicator: replaces the built-in working indicator with a two-space-indented, terminal-width-truncated activity pulse rendered inside the custom input editor via `ui-editor.ts`, freezes the initial thinking-level border color through the active and final elapsed-time states, adds a bold shimmer/pulse over the active message text, owns the terminal title, shows working/tool/done states from one shared spinner clock, keeps the final elapsed-time status visible until the next request, and rings the terminal bell when an agent turn finishes. | — |
| `analyze-eutp.ts` | Loads EUTP task data, sends a structured codebase-analysis prompt, and renames the current session to `EUTP-ID: task title` when task data/title is available. | `/analyze-eutp <url> [session] [info]` |
| `codex-usage/` | Unified Codex usage extension: owns `/codex:quotas`, `/codex:profile`, compact footer quota status without a leading `codex` label, and Codex OAuth profile rotation. It stores native plaintext profiles in `~/.pi/agent/codex-usage/profiles/`, fetches ChatGPT/Codex 5h/7d quota from `chatgpt.com/backend-api/wham/usage`, refetches the active footer quota every 60 seconds so percentages stay current even when rotation is disabled, rotates `openai-codex` credentials across saved native profiles when quota drops below 5%, scores candidates by the weaker quota window, avoids mid-provider-request switching, marks 429/auth-error cooldowns, persists global state in `~/.pi/agent/codex-usage/state.json`, uses a global lock for multi-process safety, and watches state changes to reload auth in other Pi processes. It does not rotate in `before_agent_start`, so prompt submission is not blocked by quota scans. | `/codex:quotas`, `/codex:profile status`, `/codex:profile list`, `/codex:profile save <name>`, `/codex:profile use <name>`, `/codex:profile delete <name>`, `/codex:rotate status`, `/codex:rotate now`, `/codex:rotate on`, `/codex:rotate off`, `/codex:rotate profile <name>`, `/codex:rotate scan` |
| `codex-review.ts` | Adds a Codex-style `/review` command in one self-contained extension file: selects or accepts the base comparison branch and target changes branch, runs the review in a separate `pi -p --no-session` process so current chat context is not included, reviews tracked/untracked changes with `git diff <merge-base>..<target-branch>`, and pre-fills the current editor with readable review cards. When run outside a git repository, discovers immediate child git repositories and lets the user select one. | `/review [--base branch]` |
| `context-limit-warning.ts` | Shows a UI warning after an agent response first crosses `128000` context tokens, then warns again only after usage drops below the threshold and crosses it later. | — |
| `delete-current-session.ts` | Adds `/delete`: asks for confirmation, starts a fresh session, then removes the previous current session file from history. | `/delete` |
| `balance.ts` | Shows DeepSeek and OpenRouter account balances for their respective models, immediately reuses each provider's last successful balance when switching back, and refreshes asynchronously on session/model/turn events so model switching is not blocked by balance requests. Reads API keys from `~/.pi/agent/auth.json` (`deepseek.*` and `openrouter.*`: `key`, `apiKey`, or `token`). | `/deepseek:balance`, `/openrouter:balance` |
| `default-reasoning.ts` | Applies model-specific thinking defaults on manual model selection: DeepSeek/Xiaomi/`gpt-5.4-mini` → `high`, other GPT models → `low`, non-reasoning models → `off`. Skips restored session selections. In non-empty sessions, appends `• Context cache will be invalidated` to the native model-switch status line for any model change and to the native thinking-level status line for GPT/OpenAI thinking changes; switching model or thinking back to the runtime's initial value clears/skips the warning, and reload/startup treats the current model/thinking as the new baseline. | — |
| `ui-editor.ts` | Owns the custom input editor behavior: removes the editor's horizontal separator bars, renders the `agent-pulse.ts` line inside the editor when present without inheriting `!`/`!!` bash-mode coloring, and auto-triggers autocomplete for `$skill-name` syntax. Project/model labels now live in the footer. | — |
| `handoff.ts` | Writes compact handoff artifacts into the OS temp directory (`pi-handoffs/`). `/handoff` creates a summary document for a fresh agent. `/handoff-implement` generates both a handoff and an implementation-plan contract from the current session branch and git snapshot, gates on plan readiness, and starts a fresh implementation session with a kickoff prompt referencing both files by default. Uses the current model, a local suggested-skills allowlist, and best-effort secret redaction. | `/handoff [focus]`, `/handoff-implement [--draft] [--force] [--confirm] [focus]` |
| `mr-echat.ts` | Automates EChat commit + push with upstream tracking and GitLab MR creation through `glab` without enabling source-branch deletion on merge; if the current EUTP branch was branched from another EUTP branch instead of main/master/develop, creates the MR into that parent branch. Generates commit/MR text with `openai-codex/gpt-5.4-mini` at high reasoning and excludes generated diff noise (lockfiles, build/coverage/generated outputs) before sending changes to the model. If an MR already exists, asks whether to update its description from the current description plus new diff; if a previous task commit title is found, first offers to reuse it without calling the model, and generation starts only on request. | `/mr-echat [commit-title]` |
| `mr-review.ts` | Replaces the old MR review prompt with `/mr-review`: parses GitLab MR URLs, and with no args opens an editor form for MR link, PORA token, extra context, and related EUTP tasks/links; reads source branch from GitLab when available, falls back to commit messages for `EUTP-*`, fetches task details from `urs.esoft.tech` with explicit session or `PORA_SESSION`, switches the review repo to target/master/main/stage/develop, fetches MR into `mr-<iid>` under `/home/user/echat/reviews/<repo>`, then sends the current agent a Russian thermo-nuclear review prompt with task-compliance check. | `/mr-review [<MR-URL> [pora_session]]` |
| `ui-header.ts` | Replaces the built-in header with a slightly brighter smooth darker-to-lighter gradient derived from the current theme thinking level color; it rerenders when thinking level changes. | — |
| `prompt-audit.ts` | Logs the initial pi prompt breakdown and the serialized provider request payload to `~/.pi/logs/prompt-audit` for prompt/token auditing. Supports one-shot, persistent, environment-enabled, and status modes. | `/prompt-audit [once\|on\|off\|status]`, `PI_PROMPT_AUDIT=1` |
| `shake.ts` | Adds an OMP-style `/shake` command: `elide` replaces tool-result messages and giant fenced/XML blocks with short placeholders and saves originals next to the session; `images` removes image blocks. Shows a notification after rewriting context without reloading the session. | `/shake [elide\|images]` |
| `ui-footer.ts` | Installs a two-line custom footer with two-cell horizontal padding: the first line shows project path/git branch on the left and selected model/thinking level on the right; the second line shows token/cost/context stats on the left and extension statuses on the right. Shows latest prompt cache-hit rate as `CH82.9%` when cache tokens are present, keeps subscription-backed model cost as plain `$0.000`, and hides the noisy `ponytail` extension status. Context usage is shown as absolute current/window tokens (`44k/272k`) instead of a percentage. Footer text uses the active thinking-level theme color; extension-provided ANSI colors are stripped before display. Uses `pi-tui` width helpers so emoji/wide glyph statuses are truncated safely. | — |
| `commands-aliases.ts` | Adds short slash-command aliases for quitting, starting a new session, and showing Codex quota status. | `/exit`, `/q`, `/e`, `/n`, `/status` |
| `skill-dollar.ts` | Adds `$skill-name` shorthand for Pi skill commands: provides autocomplete items and rewrites leading `$skill-name [args]` input to built-in `/skill:name [args]`, preserving Pi's native skill expansion/rendering (`[skill] ... ctrl+o to expand`). The `$` autocomplete auto-trigger lives in `ui-editor.ts` because only one extension can own the custom editor. | `$<skill-name> [args]` shorthand |
| `zsh.ts` | Runs user bash commands through non-interactive zsh (`PI_USER_BASH=1 zsh -fc ...`) while preserving pi's local bash operations. Self-disables on Windows or when no executable zsh is available. Avoids sourcing `~/.zshrc`; sources `~/.pi/agent/zshrc` instead for safe aliases/functions, then evals the command so aliases expand. Honors `PI_USER_BASH_SHELL`, `PI_USER_ZSHRC`, then falls back to `$SHELL` or `/bin/zsh`. | — |
