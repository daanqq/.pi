![pi-config screenshot](https://iili.io/C2mIO2n.png)

# pi-config

Personal configuration for the `pi` coding agent.

## Setup

- Default model: `cliproxy/gpt-5.6-sol`, thinking `high`
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
| `analyze-eutp.ts` | Analyzes an EUTP task and names the session. | `/analyze-eutp` |
| `apply-patch/` | Adds the Codex-style `apply_patch` tool. | — |
| `auto-session-name/` | Names new sessions after the first completed response. | — |
| `balance.ts` | Shows DeepSeek and OpenRouter balances. | `/deepseek:balance`, `/openrouter:balance` |
| `codex-usage/` | Shows quota and rotates Codex profiles. | `/status`, `/codex:profile`, `/codex:rotate` |
| `commands-aliases.ts` | Adds common command aliases. | `/exit`, `/q`, `/e`, `/n` |
| `context-limit-warning.ts` | Warns when context exceeds 128k tokens. | — |
| `default-reasoning.ts` | Applies model-specific reasoning defaults. | — |
| `mr-echat.ts` | Commits, pushes, and creates EChat merge requests. | `/mr-echat` |
| `mr-review/` | Reviews GitLab merge requests and local changes. | `/review`, `/mr-review` |
| `session-delete.ts` | Deletes the current session safely. | `/delete` |
| `shake.ts` | Removes bulky content from session context. | `/shake` |
| `skill-dollar.ts` | Expands `$skill-name` references. | `$<skill-name>` |
| `subagents/` | Runs background agents. | `/subagents`, `/btw` |
| `zsh.ts` | Runs user shell commands through zsh. | — |

## Local commands

| Command | Purpose |
| --- | --- |
| `agent/bin/runreviews` | Runs parallel MR reviews for URS tasks. |
| `agent/bin/runanalyses` | Runs parallel EUTP analyses in separate Pi TUI tabs inside one Herdr Space and skips tasks whose `Что было сделано?` section already contains a GitLab MR. |
