import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { complete, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SKILLS = [
  ["diagnose", "Disciplined diagnosis loop for hard bugs and performance regressions."],
  ["frontend-design", "Production-grade frontend UI and styling work."],
  ["grill-me", "Relentless decision-tree questioning until a plan/design converges."],
  ["improve-codebase-architecture", "Architecture review and refactoring opportunities."],
  ["tdd", "Test-driven red-green-refactor implementation."],
  ["to-prd", "Turn conversation context into a PRD."],
  ["write-a-skill", "Create a new agent skill."],
  ["librarian", "Evidence-backed open-source library research with source links."],
  ["session-history", "Search and read past pi coding sessions."],
] as const;

const SYSTEM_PROMPT = `You write compact handoff documents for coding agents.

Rules:
- Summarise only what is needed for a fresh agent to continue.
- Do not duplicate content already captured in artifacts, PRDs, plans, ADRs, issues, commits, or diffs. Reference paths/URLs instead.
- Redact sensitive information. Never include API keys, passwords, bearer tokens, cookies, or private personal data.
- If focus is provided, tailor the handoff to that next-session focus.
- Suggested skills must be selected only from the provided allowlist.
- Output markdown body sections only; do not include the top metadata block.
- Keep it concise and operational.

Required sections exactly:
## Suggested skills

## Existing artifacts to read first

## Conversation summary

## Current state

## Next steps

## Open questions`;

function timestampForFile(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function redact(text: string): string {
  return text
    .replace(/\b(sk-ant-[A-Za-z0-9_-]{20,})\b/g, "[REDACTED]")
    .replace(/\b(sk-[A-Za-z0-9_-]{20,})\b/g, "[REDACTED]")
    .replace(/\b(ghp_[A-Za-z0-9_]{20,})\b/g, "[REDACTED]")
    .replace(/\b(github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{20,}/gi, "$1[REDACTED]")
    .replace(/\b(Authorization\s*:\s*)[^\n\r]+/gi, "$1[REDACTED]")
    .replace(/\b(apiKey|api_key|token|password|secret)(\s*[:=]\s*)(["'])?[^\s"'`,}]+\3?/gi, "$1$2[REDACTED]")
    .replace(/\b[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]");
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const p = part as Record<string, unknown>;
      if (p.type === "text" && typeof p.text === "string") return p.text;
      if (p.type === "toolCall") return `[tool call: ${String(p.name ?? "unknown")}] ${JSON.stringify(p.arguments ?? {})}`;
      if (p.type === "toolResult") return `[tool result: ${String(p.toolName ?? "unknown")}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function conversationFromBranch(branch: unknown[]): string {
  const lines: string[] = [];
  for (const entry of branch) {
    const e = entry as Record<string, unknown>;
    const message = e.message as Record<string, unknown> | undefined;
    if (!message || typeof message.role !== "string") continue;
    const text = textFromContent(message.content);
    if (!text.trim()) continue;
    lines.push(`### ${message.role}\n${text.trim()}`);
  }
  return lines.join("\n\n---\n\n");
}

function buildPrompt(conversation: string, focus: string, cwd: string, sessionFile: string): string {
  const skills = SKILLS.map(([name, description]) => `- ${name}: ${description}`).join("\n");
  return `Focus for next session: ${focus || "not specified"}
CWD: ${cwd}
Session file: ${sessionFile}

Suggested skills allowlist:
${skills}

Current conversation branch, redacted before summarisation:
${conversation}`;
}

function ensureRequiredSections(markdown: string): string {
  const required = [
    "## Suggested skills",
    "## Existing artifacts to read first",
    "## Conversation summary",
    "## Current state",
    "## Next steps",
    "## Open questions",
  ];
  let result = markdown.trim();
  for (const section of required) {
    if (!result.includes(section)) result += `\n\n${section}\n\n- None identified.`;
  }
  return result;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("handoff", {
    description: "Write a handoff document to the OS temp directory",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();

      const focus = args.trim();
      const sessionFile = ctx.sessionManager.getSessionFile() ?? "ephemeral";
      const branch = ctx.sessionManager.getBranch() as unknown[];
      const conversation = redact(conversationFromBranch(branch));

      if (!conversation.trim()) {
        ctx.ui.notify("No conversation branch found for handoff", "error");
        return;
      }

      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
      if (auth.ok === false) {
        ctx.ui.notify(`Cannot create handoff: ${auth.error}`, "error");
        return;
      }

      ctx.ui.notify(`Creating handoff with ${ctx.model.id}...`, "info");

      const userMessage: UserMessage = {
        role: "user",
        content: [{ type: "text", text: buildPrompt(conversation, focus, ctx.cwd, sessionFile) }],
        timestamp: Date.now(),
      };

      const response = await complete(
        ctx.model,
        { systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
        { apiKey: auth.apiKey, headers: auth.headers },
      );

      if (response.stopReason === "aborted") {
        ctx.ui.notify("Handoff creation cancelled", "info");
        return;
      }

      const body = response.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim();

      const generated = new Date().toISOString();
      const markdown = redact(`# Handoff

Generated: ${generated}
CWD: ${ctx.cwd}
Session: ${sessionFile}
Focus: ${focus || "not specified"}

${ensureRequiredSections(body)}

## Continuation notes

- Do not duplicate existing artifacts; read referenced paths/URLs first.
- Treat this handoff as a compact index, not the source of truth.

## Sensitive information handling

Sensitive values were redacted where detected.
`);

      const dir = path.join(tmpdir(), "pi-handoffs");
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, `handoff-${timestampForFile()}.md`);
      await writeFile(file, markdown, "utf8");

      ctx.ui.notify(`Handoff saved: ${file}`, "info");
    },
  });
}
