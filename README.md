![pi-config screenshot](https://iili.io/C2mIO2n.png)

# pi-config

Personal configuration for the `pi` coding agent.

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
| `fullscreen-scroll-speed.ts` | Makes fullscreen wheel scrolling five times faster; Alt keeps Pi's additional five-times multiplier. | — |
| `mr-echat.ts` | Commits, pushes, and creates EChat merge requests; `--name=<ветка>` selects an existing branch or creates one from `master`. | `/mr-echat [--name=<ветка>]` |
| `session-delete.ts` | Deletes the current session safely. | `/delete` |
| `shake.ts` | Removes bulky content from session context. | `/shake` |
| `skill-dollar.ts` | Expands `$skill-name` references. | `$<skill-name>` |
| `subagents/` | Runs background agents. | `/subagents`, `/btw` |
| `zsh.ts` | Runs user shell commands through zsh. | — |

## Local commands

| Command | Purpose |
| --- | --- |
| `make dep` | Installs all dependencies for the local extension packages. |
