# Pi Extensions — Full Examples Catalog

All examples live at `examples/extensions/` in the pi-coding-agent repo. Each is a working `.ts` file or directory.

---

## 1. Security / Event Hooks (`tool_call`, `session_before_*`)

| Example | Key APIs | What it does |
|--------|----------|-------------|
| `permission-gate.ts` | `pi.on("tool_call")`, `ctx.ui.select()` | Confirm before dangerous bash (`rm -rf`, `sudo`, `chmod 777`) |
| `protected-paths.ts` | `pi.on("tool_call")`, `{ block: true }` | Block writes to `.env`, `.git/`, `node_modules/` |
| `confirm-destructive.ts` | `pi.on("session_before_switch")`, `session_before_fork`, `ctx.ui.confirm()` | Confirm before clearing/switching/forking sessions |
| `dirty-repo-guard.ts` | `session_before_switch`, `session_before_fork`, `pi.exec("git")` | Block session switch with uncommitted git changes |
| `auto-commit-on-exit.ts` | `pi.on("session_shutdown")`, `pi.exec()`, `ctx.sessionManager` | Auto-commit on exit using last assistant message as commit message |
| `notify.ts` | `pi.on("agent_end")` | Desktop notifications via OSC 777/99 when agent finishes |
| `sandbox/` | `tool_call`, `@anthropic-ai/sandbox-runtime` | OS-level sandbox with per-project config |

---

## 2. Custom Tools (`pi.registerTool()`)

| Example | Key APIs | What it does |
|--------|----------|-------------|
| `hello.ts` | `pi.registerTool()`, `defineTool()`, `Type.Object()` | Minimal greet tool — the "hello world" |
| `question.ts` | `pi.registerTool()`, `ctx.ui.custom()`, `renderCall()`, `renderResult()` | Interactive question with options list + free text input, custom TUI rendering |
| `questionnaire.ts` | `pi.registerTool()`, `ctx.ui.custom()`, tab navigation | Multi-question form with tabs |
| `todo.ts` | `pi.registerTool()`, `pi.appendEntry()`, `renderCall()`, `session_start` | Todo list tool with session persistence and custom rendering |
| `structured-output.ts` | `pi.registerTool()`, `terminate: true`, `promptSnippet`, `promptGuidelines` | Final tool with `terminate: true` — agent ends turn without extra LLM call |
| `dynamic-tools.ts` | `pi.registerTool()` inside `session_start` and commands, `promptSnippet/Guidelines` | Register tools dynamically after startup |
| `truncated-tool.ts` | `pi.registerTool()`, wraps ripgrep | Tool with proper 50KB/2000-line output truncation |
| `shutdown-command.ts` | `pi.registerTool()`, `ctx.shutdown()` | `finish_and_exit`, `deploy_and_exit` — graceful shutdown from LLM tool call |

---

## 3. Override Built-in Tools (`create*Tool`, `operations`)

| Example | Key APIs | What it does |
|--------|----------|-------------|
| `tool-override.ts` | `pi.registerTool({ name: "read" })`, `getAgentDir()`, `withFileMutationQueue()` | Override `read`: audit log + block secret files. Built-in renderer preserved automatically |
| `ssh.ts` | `createReadTool/WriteTool/EditTool/BashTool()`, `pi.registerFlag()`, `user_bash`, `before_agent_start` | Delegate all file ops to remote machine via SSH; also intercepts `user_bash` `!` commands |
| `interactive-shell.ts` | `pi.on("user_bash")`, `ctx.ui.custom()`, `tui.stop()/start()` | Run interactive commands (vim, htop) with full terminal via `user_bash` hook |

---

## 4. TUI / UI (`ctx.ui.*`)

| Example | Key APIs | What it does |
|--------|----------|-------------|
| `custom-footer.ts` | `ctx.ui.setFooter()`, `footerData.getGitBranch()`, `footerData.onBranchChange()` | Custom footer with git branch + token stats |
| `custom-header.ts` | `ctx.ui.setHeader()` | Custom header |
| `status-line.ts` | `ctx.ui.setStatus()`, `theme.fg()` | Turn progress in footer with spinner/checkmark colors |
| `model-status.ts` | `pi.on("model_select")`, `ctx.ui.setStatus()` | Show current model in status bar |
| `border-status-editor.ts` | `ctx.ui.setEditorComponent()`, `CustomEditor`, `setWorkingVisible()` | Full editor replacement: model, context%, cwd, git-branch in border frames |
| `rainbow-editor.ts` | `ctx.ui.setEditorComponent()` | Animated rainbow text effect editor |
| `modal-editor.ts` | `ctx.ui.setEditorComponent()` | Vim-like modal editor |
| `hidden-thinking-label.ts` | `ctx.ui.setHiddenThinkingLabel()` | Custom collapsed-thinking label |
| `working-indicator.ts` | `ctx.ui.setWorkingIndicator()` | Custom streaming indicator: dot/pulse/spinner/hidden |
| `widget-placement.ts` | `ctx.ui.setWidget()` with placement | Widgets above and below the editor |
| `titlebar-spinner.ts` | `ctx.ui.setTitle()`, `agent_start/end` | Braille spinner in terminal title while agent works |
| `working-message-test.ts` | `ctx.ui.setWorkingMessage()` | Test for working message component |
| `notify.ts` | `agent_end` | Desktop notifications via terminal escape sequences |

---

## 5. Games & Complex TUI (`ctx.ui.custom()`)

| Example | Key APIs | What it does |
|--------|----------|-------------|
| `snake.ts` | `pi.registerCommand()`, `ctx.ui.custom()`, `pi.appendEntry()`, `setInterval` | Snake game with session persistence |
| `tic-tac-toe.ts` | `pi.registerTool()`, `executionMode: "sequential"`, `ctx.ui.custom()` | Tic-tac-toe vs agent (sequential tools prevent race conditions) |
| `space-invaders.ts` | `ctx.ui.custom()`, `setInterval`, `matchesKey()` | Space Invaders arcade game |
| `doom-overlay/` | Overlays at 35 FPS | DOOM running as an overlay — real-time game rendering demo |

---

## 6. Input & Commands (`input`, `registerCommand`, `registerShortcut`)

| Example | Key APIs | What it does |
|--------|----------|-------------|
| `input-transform.ts` | `pi.on("input")`, `{ action: "transform"/"handled"/"continue" }` | `?quick` → brief mode, `ping` → instant "pong", `time` → clock |
| `inline-bash.ts` | `pi.on("input")`, `pi.exec()`, `{ action: "transform" }` | Expands `!{command}` patterns inline in prompts |
| `commands.ts` | `pi.registerCommand()` | Command registration examples |
| `tools.ts` | `pi.registerCommand()`, `ctx.ui.custom()`, `SettingsList`, `pi.setActiveTools()`, `pi.appendEntry()` | `/tools` — interactive enable/disable tools with persistence |
| `bookmark.ts` | `pi.registerCommand()`, `pi.setLabel()`, `ctx.sessionManager.getLabel()` | `/bookmark` — bookmark entries for `/tree` navigation |
| `summarize.ts` | `pi.registerCommand()`, `complete()`, `ctx.ui.custom()`, `Markdown`, `DynamicBorder` | `/summarize` — summarize conversation with GPT-5.2, render in Markdown UI |
| `session-name.ts` | `pi.setSessionName()`, `pi.getSessionName()` | Name sessions for the session selector |
| `handoff.ts` | `pi.registerCommand()`, `ctx.newSession()`, `complete()`, `ctx.ui.editor()` | `/handoff <goal>` — transfer context to new session with AI-generated prompt |
| `reload-runtime.ts` | `pi.registerCommand()`, `ctx.reload()` | `/reload-runtime` — hot-reload extensions |
| `send-user-message.ts` | `pi.sendUserMessage()`, `deliverAs: "steer"/"followUp"/"nextTurn"` | Send user messages from extensions (steer mid-stream, follow-up, next-turn) |
| `qna.ts` | `ctx.ui.setEditorText()` | Extract questions from response into editor |
| `preset.ts` | `pi.registerFlag()`, `pi.registerCommand()`, `pi.setActiveTools()`, `pi.setThinkingLevel()` | Named presets for model/thinking/tools via `--preset` flag and `/preset` command |

---

## 7. System Prompt & Context (`before_agent_start`, `context`)

| Example | Key APIs | What it does |
|--------|----------|-------------|
| `pirate.ts` | `pi.on("before_agent_start")`, `event.systemPrompt` | Toggle pirate mode: dynamically append to system prompt |
| `claude-rules.ts` | `before_agent_start`, `session_start` | Scans `.claude/rules/` folder and lists rules in system prompt |
| `system-prompt-header.ts` | `before_agent_start` | Add header to system prompt |
| `prompt-customizer.ts` | `before_agent_start`, `systemPromptOptions` | Deep system prompt customization via structured options |

---

## 8. Compaction (`session_before_compact`, `ctx.compact()`)

| Example | Key APIs | What it does |
|--------|----------|-------------|
| `custom-compaction.ts` | `pi.on("session_before_compact")`, `complete()`, different model | Full compaction replacement: summarize via Gemini Flash instead of default |
| `trigger-compact.ts` | `ctx.getContextUsage()`, `ctx.compact()`, `pi.on("turn_end")` | Auto-compact when context exceeds 100K tokens + manual `/trigger-compact` |

---

## 9. Communication (`sendMessage`, `events`, `registerMessageRenderer`)

| Example | Key APIs | What it does |
|--------|----------|-------------|
| `message-renderer.ts` | `pi.registerMessageRenderer()`, `Box`, `Text` | Custom message rendering with colors and expandable details |
| `event-bus.ts` | `pi.events.on()`, `pi.events.emit()` | Inter-extension communication via event bus |
| `file-trigger.ts` | `pi.sendMessage()`, `triggerTurn: true`, `fs.watch()` | Watch a file and inject its contents into conversation |
| `rpc-demo.ts` | `ctx.ui.select/confirm/input/editor/notify/setStatus/setWidget/setTitle/setEditorText` | Demo all UI methods available in RPC mode |

---

## 10. Providers & Models (`registerProvider`, `model_select`)

| Example | Key APIs | What it does |
|--------|----------|-------------|
| `provider-payload.ts` | `pi.on("before_provider_request")`, `after_provider_response` | Log provider payload and HTTP status |
| `custom-provider-anthropic/` | `pi.registerProvider()`, custom streaming, OAuth | Custom Anthropic provider |
| `custom-provider-gitlab-duo/` | `pi.registerProvider()`, pi-ai streaming via proxy | GitLab Duo provider |
| `model-status.ts` | `pi.on("model_select")` | Track model changes |
| `hidden-thinking-label.ts` | `pi.on("thinking_level_select")` | Track thinking level changes |

---

## 11. External Integrations & Git

| Example | Key APIs | What it does |
|--------|----------|-------------|
| `git-checkpoint.ts` | `pi.on("turn_start")`, `pi.exec("git stash")`, `session_before_fork` | Git stash checkpoints at each turn, restore on fork |
| `github-issue-autocomplete.ts` | `ctx.ui.addAutocompleteProvider()`, `pi.exec("gh")` | Autocomplete `#1234` GitHub issues in the editor |
| `mac-system-theme.ts` | `ctx.ui.setTheme()`, `setInterval` | Sync theme with macOS dark/light mode |
| `bash-spawn-hook.ts` | `tool_call` | Hook into bash spawn events |

---

## 12. Resources & Packages (`resources_discover`, npm deps)

| Example | Key APIs | What it does |
|--------|----------|-------------|
| `dynamic-resources/` | `pi.on("resources_discover")`, `skillPaths`, `promptPaths`, `themePaths` | Dynamically load skills, prompts, themes |
| `with-deps/` | `package.json` with dependencies | Extension with external npm packages (demonstrates jiti resolution) |

---

## 13. Sub-agents & Plan Mode

| Example | Key APIs | What it does |
|--------|----------|-------------|
| `subagent/` | `pi.exec()` for child pi processes, `ctx.ui.custom()`, streaming | Delegate tasks to isolated sub-agents (scout, planner, reviewer, worker) |
| `plan-mode/` | `pi.registerCommand()`, `pi.registerFlag()`, `pi.setActiveTools()`, `ctx.ui.setWidget()`, bash allowlist | Read-only exploration mode + plan execution with `[DONE:n]` markers |

---

## 14. Tests & Overlays

| Example | Key APIs | What it does |
|--------|----------|-------------|
| `overlay-test.ts` | Overlays | Overlay compositing tests |
| `overlay-qa-tests.ts` | Overlays | Full overlay QA: anchors, margins, stacking, overflow, animation |
| `timed-confirm.ts` | `ctx.ui.confirm()`, `AbortSignal` | Auto-dismissing dialogs via timeout |

---

## 15. Minimal / Toggle Modes

| Example | Key APIs | What it does |
|--------|----------|-------------|
| `minimal-mode.ts` | Override built-in tool rendering | Minimal display: only tool calls, no output in collapsed mode |
| `built-in-tool-renderer.ts` | Custom compact rendering | Custom compact rendering for read, bash, edit, write while keeping original behavior |
