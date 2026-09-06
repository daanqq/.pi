![pi-config screenshot](https://iili.io/C2mIO2n.png)

# pi-config

Personal configuration for the `pi` coding agent.

## Setup

- Default model: `cliproxy/sol`, thinking `medium` (Pi's configured default; no per-model reasoning override).
- Theme: `alabaster`
- Packages: `pi-web-access`, `pi-system-prompt`, `@ff-labs/pi-fff`, `@plannotator/pi-extension`, `pi-mcp-adapter`, `pi-openai-server-compaction`

## CLIProxyAPI

Pi always connects to CLIProxyAPI at `http://127.0.0.1:8317`. On a server that
runs CLIProxyAPI, use the local service. On a client machine, disable the local
service and enable the SSH tunnel from `agent/systemd/cliproxy-tunnel.service`.
Do not run both because they use the same port.

The tunnel expects an SSH host alias named `cliproxy-server`. Install it on a
client machine with:

```sh
systemctl --user disable --now cliproxyapi.service
install -Dm644 ~/.pi/agent/systemd/cliproxy-tunnel.service \
  ~/.config/systemd/user/cliproxy-tunnel.service
systemctl --user daemon-reload
systemctl --user enable --now cliproxy-tunnel.service
```

On the server, keep `cliproxy-tunnel.service` disabled and run CLIProxyAPI
itself on `127.0.0.1:8317`.

Store the shared API key in this ignored file on every machine:

```text
~/.pi/agent/secrets/cliproxy-api-key
```

The model config reads it through `~`, so the same repository works for users
with different home directories. The quota extension optionally reads its
Management API URL and plaintext key from:

```text
~/.pi/agent/secrets/cliproxy-management.json
```

Use this shape on both local and remote installations:

```json
{
  "managementUrl": "http://127.0.0.1:8317",
  "managementKey": "plaintext-management-key"
}
```

Keep both secret files at mode `0600`.

## Repository

- `agent/settings.json` — Pi settings.
- `agent/extensions/` — local extensions.
- `agent/skills/` — local skills.
- `agent/themes/` — local themes.
- `agent/systemd/` — optional user services for client machines.
- `agent/zshrc` — shell setup.
- `agent/extensions/package.json` — npm deps for local extensions (currently `undici`, used by `balance.ts` to route balance checks through the env HTTP proxy).

## Agent instructions and skills

`agent/AGENTS.md` owns task permissions, clarification boundaries, verification
stopping rules, response style, and subagent model selection. Skills reference
that policy rather than pinning their own models. Pi subagents inherit the parent
model and reasoning unless the user selects an override.

Read-only work preserves project files and user data while allowing necessary,
isolated temporary artifacts. Cleanup is limited to verified task-owned artifacts.
An explicit no-writes request also excludes temporary files.

`code-review` distinguishes `branch`, `working-tree`, and `all` scopes, including
untracked files where applicable. Missing specifications limit Spec coverage without
blocking the rest of the review. `diagnosing-bugs` uses a short diagnosis path and
loads advanced techniques only for difficult cases. Routine response style stays
in `agent/AGENTS.md`.

## Prompt template

| Template | Description | Command |
| --- | --- | --- |
| `yeet.md` | Splits changes into logical commits and pushes them. | `/yeet [instructions]` |

## Extensions

| Extension | Description | Commands |
| --- | --- | --- |
| `00-ui-editor.ts` | Custom input editor and skill autocomplete. | — |
| `00-ui-footer.ts` | Compact two-line status footer. | — |
| `00-ui-header.ts` | Theme-aware gradient header. | — |
| `agent-pulse.ts` | Agent activity and elapsed-time indicator. | — |
| `apply-patch/` | Adds the Codex-style `apply_patch` tool. | — |
| `auto-session-name/` | Names new sessions in English after the first completed response; uses `New session` if generation fails. | — |
| `balance.ts` | Shows DeepSeek and OpenRouter balances. | `/deepseek:balance`, `/openrouter:balance` |
| `cliproxy-quota/` | Shows combined and per-account Codex quotas through CLIProxyAPI. | `/cliproxy:quota`, `/statuses` |
| `context-limit-warning.ts` | Warns when context exceeds 128k tokens. | — |
| `mr-echat.ts` | Commits, pushes, and creates EChat merge requests. | `/mr-echat` |
| `session-delete.ts` | Deletes the current session safely. | `/delete` |
| `shake.ts` | Removes bulky content from session context. | `/shake` |
| `skill-dollar.ts` | Expands `$skill-name` references. | `$<skill-name>` |
| `subagents/` | Runs background agents. | `/subagents`, `/btw` |
| `zsh.ts` | Runs user shell commands through zsh. | — |

### Performance and lifecycle

- The custom editor, header, footer, and pulse run only in TUI mode. Headless Pi
  children do not alter the parent's shared UI state or start pulse timers.
  The static header is cached until theme invalidation; footer context estimates
  are refreshed after messages, compaction, model changes, and tree navigation,
  not on every animation frame.
- Subagents keep up to two resumable idle backends hot by LRU while retaining up
  to 64 tracked results. Colder backends are closed and reopened from native Pi,
  Claude, or Codex history when continued. A backend without a durable checkpoint
  stays alive rather than losing its only history. The four-running-agent limit
  also includes resumes. Streaming updates do not refresh unchanged footer/wait
  status, and takeover caches completed transcript items by width and theme.
- Automatic naming is cancelled on session shutdown instead of delaying exit,
  reload, or session replacement. Its normal request settings are unchanged.
- GPT/Codex models, including CLIProxy aliases `astra`, `luna`, and `sol`, use
  `apply_patch` instead of `edit`/`write`. Switching to another model restores
  the tools hidden by this policy.
- Patch previews share a 256 KiB text/read budget, a 4,000-line budget, and a
  200,000-comparison hunk-search budget. Oversized previews show an explicit
  omission message; the patch itself still executes normally. Rendering state
  belongs to the tool row, not a process-wide patch history.
- Quota and balance polling is unchanged, including headless polling behavior.

### Focused extension tests

With Node 24 and an installed Pi SDK:

```sh
# Omit PI_TEST_SDK_DIR if the SDK resolves from this repository.
PI_TEST_SDK_DIR="$(npm root -g)/@earendil-works/pi-coding-agent" \
  node --experimental-transform-types --import ./agent/tests/register-sdk.mjs \
  --test agent/tests/*.test.ts agent/extensions/auto-session-name/index.test.ts \
  agent/extensions/apply-patch/*.test.ts \
  agent/extensions/subagents/{performance,native-resume}.test.ts
```

The test loader uses the installed SDK's real UI and mutation implementations
through a reduced entry point, avoiding its unrelated experimental server import.
Tests cover headless isolation, naming cancellation, bounded previews, actual
patch application in task-owned temporary directories, manager lifecycle with
local test backends, and Codex resume through a local test executable. These are
focused checks, not an end-to-end Pi startup or live-provider resume test.

## Local commands

| Command | Purpose |
| --- | --- |
| `agent/bin/runanalyses` | Runs parallel EUTP analyses in separate Pi TUI tabs inside one Herdr Space and skips tasks whose `Что было сделано?` section already contains a GitLab MR. |
| `make dep` | Installs all dependencies for the local extension packages. |
