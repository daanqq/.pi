import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part) {
        const text = (part as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function getLastAssistantText(ctx: ExtensionContext): string | undefined {
  const branch = ctx.sessionManager.getBranch();

  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== "message") continue;
    if (entry.message.role !== "assistant") continue;

    const text = contentToText(entry.message.content).trimEnd();
    if (text) return text;
  }

  return undefined;
}

export default function openLastAgentResponseExtension(pi: ExtensionAPI) {
  pi.registerShortcut("ctrl+g", {
    description: "Open last agent response in $VISUAL/$EDITOR",
    handler: async (ctx) => {
      const text = getLastAssistantText(ctx);
      if (!text) {
        ctx.ui.notify("No agent response to open yet", "warning");
        return;
      }

      const filePath = join(tmpdir(), "pi-last-agent-response.md");
      await writeFile(filePath, `${text}\n`, "utf8");

      const editor = process.env.VISUAL || process.env.EDITOR || "code";
      const result = await pi.exec("sh", ["-lc", `${editor} ${shellQuote(filePath)}`]);

      if (result.code !== 0) {
        ctx.ui.notify(result.stderr || `Editor exited with code ${result.code}`, "error");
        return;
      }

      ctx.ui.notify(`Opened last agent response: ${filePath}`, "info");
    },
  });
}
