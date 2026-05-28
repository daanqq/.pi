---
name: pi-extensions
description: Reference for writing pi-coding-agent extensions. Covers all available APIs, event hooks, and patterns with real examples. Use when building, modifying, or debugging pi extensions, or when the user asks what can be extended in pi agent.
---

# Pi Extensions Reference

Comprehensive catalog of pi extension APIs and patterns. Use together with the [official docs](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/extensions.md) and the examples at `examples/extensions/`.

## API Categories — What Can Be Extended

| Category | Key Methods | Purpose |
|----------|-------------|---------|
| **Lifecycle events** | `session_start/shutdown`, `before_agent_start`, `agent_start/end`, `turn_start/end` | Hook into every phase of the agent loop |
| **Tools** | `tool_call`, `tool_result`, `tool_execution_*`, `pi.registerTool()` | Intercept/modify tool calls; create custom tools |
| **Override built-in tools** | `createReadTool/WriteTool/EditTool/BashTool()`, `operations` | Replace file operations (SSH, sandbox, audit) |
| **System prompt** | `before_agent_start`, `event.systemPrompt`, `systemPromptOptions` | Dynamically modify the system prompt |
| **User input** | `pi.on("input")`, `{ action: "transform"/"handled"/"continue" }` | Intercept, transform, or handle user input before agent |
| **Commands** | `pi.registerCommand()`, `pi.registerShortcut()` | Custom `/commands` and keyboard shortcuts |
| **TUI** | `ctx.ui.setFooter/Header/Status/Widget/Title/EditorComponent/WorkingIndicator/HiddenThinkingLabel` | Full TUI interface control |
| **Interactive dialogs** | `ctx.ui.select/confirm/input/editor()`, `ctx.ui.custom()` | Prompt user (works in RPC mode too) |
| **Messages** | `pi.sendMessage()`, `pi.sendUserMessage()`, `pi.registerMessageRenderer()` | Inject messages into conversation; custom rendering |
| **Sessions** | `ctx.newSession()`, `ctx.fork()`, `ctx.switchSession()`, `ctx.navigateTree()`, `session_before_*` | Session management, forking, branching |
| **Compaction** | `session_before_compact`, `ctx.compact()` | Custom context compaction algorithms |
| **Providers** | `pi.registerProvider()`, `before_provider_request`, `after_provider_response` | Add custom LLM providers |
| **State persistence** | `pi.appendEntry()`, `details` in tool results | Survive restarts and `/reload` |
| **CLI flags** | `pi.registerFlag()`, `pi.getFlag()` | Custom CLI flags |
| **External commands** | `pi.exec()` | Run shell commands |
| **Event bus** | `pi.events.emit()`, `pi.events.on()` | Inter-extension communication |
| **Models** | `model_select`, `thinking_level_select`, `ctx.modelRegistry` | React to model/thinking level changes |
| **Resources** | `resources_discover` | Add skills, prompts, themes |
| **Autocomplete** | `ctx.ui.addAutocompleteProvider()` | Custom autocomplete in the editor |

## Quick Patterns

### Custom tool
```ts
import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerTool(defineTool({
    name: "my_tool",
    label: "My Tool",
    description: "What it does",
    parameters: Type.Object({ input: Type.String() }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      return { content: [{ type: "text", text: `Result: ${params.input}` }], details: {} };
    },
  }));
}
```

### Block dangerous tool calls
```ts
pi.on("tool_call", async (event, ctx) => {
  if (event.toolName === "bash" && event.input.command?.includes("rm -rf")) {
    const ok = await ctx.ui.confirm("Dangerous!", "Allow rm -rf?");
    if (!ok) return { block: true, reason: "Blocked" };
  }
});
```

### Modify system prompt
```ts
pi.on("before_agent_start", async (event) => {
  return { systemPrompt: event.systemPrompt + "\n\nCustom instructions here." };
});
```

### Transform user input
```ts
pi.on("input", async (event) => {
  if (event.text.startsWith("?quick "))
    return { action: "transform", text: `Respond briefly: ${event.text.slice(7)}` };
  return { action: "continue" };
});
```

## Full Examples Catalog

See [REFERENCE.md](REFERENCE.md) for the complete list of 50+ examples organized by API category, with descriptions of what each one does.
