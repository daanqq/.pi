![pi-config screenshot](https://iili.io/C2mIO2n.png)

# pi-config

Personal configuration for the `pi` coding agent.

## Setup

- Default model: `cliproxy/gpt-5.6-sol`, thinking `high`
- Theme: `alabaster`
- Packages: `pi-web-access`, `pi-system-prompt`, `@ff-labs/pi-fff`, `@plannotator/pi-extension`, `pi-mcp-adapter`, `pi-openai-server-compaction`

## Repository

- `agent/settings.json` — Pi settings.
- `agent/extensions/` — local extensions.
- `agent/skills/` — local skills.
- `agent/themes/` — local themes.
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
