import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { complete, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

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

const IMPLEMENT_SYSTEM_PROMPT = `You create implementation handoff artifacts for coding agents.

You will receive a redacted conversation branch, current cwd/session metadata, a git snapshot, and an optional focus.
Your job is to produce exactly three tagged blocks, in this order:

<META_JSON>
{"readiness":"ready|blocked","reason":"short reason"}
</META_JSON>

<HANDOFF_MD>
# Handoff
...
</HANDOFF_MD>

<PLAN_MD>
# Implementation Plan
...
</PLAN_MD>

Rules:
- Output only the three tagged blocks. No prose outside tags.
- Do not include YAML frontmatter; the extension will add metadata.
- Redact sensitive information. Never include API keys, passwords, bearer tokens, cookies, or private personal data.
- Keep artifacts concise but operational.
- Suggested skills in the handoff must be selected only from the provided allowlist.
- Handoff explains what happened in the previous session and what artifacts/state matter.
- Plan is the source-of-truth execution contract for the fresh implementation agent.
- Set readiness to "ready" only when implementation can start without critical missing decisions.
- Set readiness to "blocked" when there are unresolved decisions, missing requirements, or contradictions that make implementation unsafe.

HANDOFF_MD required sections:
## Suggested skills

## Existing artifacts to read first

## Conversation summary

## Current state

## Next steps

## Open questions

PLAN_MD required sections:
## Goal

## Non-goals

## Files/areas likely involved

## Preconditions / artifacts to read

## Existing work / partial implementation

## Step-by-step implementation plan

## Acceptance criteria

## Verification commands

## Stop rules

## Residual risks`;

type HandoffImplementFlags = {
  draft: boolean;
  force: boolean;
  confirm: boolean;
  focus: string;
};

type HandoffImplementArtifacts = {
  readiness: "ready" | "blocked";
  reason: string;
  handoffBody: string;
  planBody: string;
};

type GitSnapshot = {
  available: boolean;
  branch?: string;
  status?: string;
  diffStat?: string;
  changedFiles?: string;
  error?: string;
};

type ProgressStatus = {
  set: (message: string) => void;
  clear: () => void;
};

function timestampForFile(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  return `${minutes}m${rest}s`;
}

function createProgressStatus(ctx: ExtensionCommandContext): ProgressStatus {
  let current = "";
  let phaseStarted = Date.now();
  let timer: ReturnType<typeof setInterval> | undefined;

  const notify = (message: string) => ctx.ui.notify(`handoff: ${message}`, "info");

  return {
    set(message: string) {
      current = message;
      phaseStarted = Date.now();
      notify(message);

      if (timer) clearInterval(timer);
      timer = setInterval(() => {
        if (!current) return;
        notify(`${current} (${formatElapsed(Date.now() - phaseStarted)})`);
      }, 15_000);
    },
    clear() {
      current = "";
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
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

function parseHandoffImplementArgs(args: string): HandoffImplementFlags {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const focusTokens: string[] = [];
  const flags: HandoffImplementFlags = {
    draft: false,
    force: false,
    confirm: false,
    focus: "",
  };

  for (const token of tokens) {
    if (token === "--draft") flags.draft = true;
    else if (token === "--force") flags.force = true;
    else if (token === "--confirm") flags.confirm = true;
    else if (token === "--no-confirm") flags.confirm = false;
    else focusTokens.push(token);
  }

  flags.focus = focusTokens.join(" ").trim();
  return flags;
}

async function writeTempMarkdown(prefix: string, markdown: string, timestamp = timestampForFile()): Promise<string> {
  const dir = path.join(tmpdir(), "pi-handoffs");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${prefix}-${timestamp}.md`);
  await writeFile(file, markdown, "utf8");
  return file;
}

function extractTaggedBlock(text: string, tag: string): string | undefined {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`<${escaped}>\\s*([\\s\\S]*?)\\s*</${escaped}>`, "i"));
  return match?.[1]?.trim();
}

function parseHandoffImplementResponse(raw: string): HandoffImplementArtifacts | undefined {
  const metaText = extractTaggedBlock(raw, "META_JSON");
  const handoffBody = extractTaggedBlock(raw, "HANDOFF_MD");
  const planBody = extractTaggedBlock(raw, "PLAN_MD");
  if (!metaText || !handoffBody || !planBody) return undefined;

  let meta: unknown;
  try {
    meta = JSON.parse(metaText);
  } catch {
    return undefined;
  }

  if (!meta || typeof meta !== "object") return undefined;
  const record = meta as Record<string, unknown>;
  const readiness = record.readiness;
  if (readiness !== "ready" && readiness !== "blocked") return undefined;

  const reason = typeof record.reason === "string" && record.reason.trim() ? record.reason.trim() : "No reason provided.";
  return { readiness, reason, handoffBody, planBody };
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function stripYamlFrontmatter(markdown: string): string {
  return markdown.trim().replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "").trim();
}

function addFrontmatter(body: string, metadata: Record<string, string>): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(metadata)) {
    lines.push(`${key}: ${yamlString(value)}`);
  }
  lines.push("---", "", stripYamlFrontmatter(body), "");
  return redact(lines.join("\n"));
}

function formatGitSnapshot(snapshot: GitSnapshot): string {
  if (!snapshot.available) return `Git snapshot: unavailable${snapshot.error ? ` (${snapshot.error})` : ""}`;
  return `Git snapshot:
- Branch: ${snapshot.branch || "unknown"}

Status --short:
${snapshot.status?.trim() || "(clean)"}

Diff --stat:
${snapshot.diffStat?.trim() || "(no diff)"}

Changed files:
${snapshot.changedFiles?.trim() || "(none)"}`;
}

async function collectGitSnapshot(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<GitSnapshot> {
  const runGit = async (args: string[]) => pi.exec("git", args, { cwd: ctx.cwd, timeout: 5_000 }).catch((error: unknown) => ({
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
    code: 1,
    killed: false,
  }));

  const inside = await runGit(["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    return { available: false, error: inside.stderr.trim() || "not a git repository" };
  }

  const [branch, status, diffStat, changedFiles] = await Promise.all([
    runGit(["branch", "--show-current"]),
    runGit(["status", "--short"]),
    runGit(["diff", "--stat"]),
    runGit(["diff", "--name-only"]),
  ]);

  return {
    available: true,
    branch: branch.stdout.trim(),
    status: status.stdout,
    diffStat: diffStat.stdout,
    changedFiles: changedFiles.stdout,
  };
}

function buildImplementationPrompt(conversation: string, focus: string, cwd: string, sessionFile: string, gitSnapshot: GitSnapshot): string {
  const skills = SKILLS.map(([name, description]) => `- ${name}: ${description}`).join("\n");
  return `Focus for implementation session: ${focus || "not specified"}
CWD: ${cwd}
Session file: ${sessionFile}

Suggested skills allowlist:
${skills}

${formatGitSnapshot(gitSnapshot)}

Current conversation branch, redacted before summarisation:
${conversation}`;
}

function buildKickoffPrompt(handoffFile: string, planFile: string): string {
  return `We are continuing from a previous planning/clarification session.

First, read both files before making edits:
- Handoff: @${handoffFile}
- Implementation plan: @${planFile}

Then implement the plan.

Rules:
- Do not edit files before reading both artifacts.
- Treat the implementation plan as the source of truth.
- Continue from existing work; do not overwrite partial implementation blindly.
- Before making edits, inspect git status and changed files mentioned in the plan.
- Do not re-plan unless there are contradictions or missing critical details.
- Run the listed verification commands.
- Final response must include changed files, commands run, validation output, and residual risks.`;
}

function buildRawFailurePrompt(rawFile: string): string {
  return `The handoff implementation artifact generation failed to split cleanly.
Review the raw output manually: @${rawFile}`;
}

async function generateHandoffImplementArtifacts(
  conversation: string,
  focus: string,
  cwd: string,
  sessionFile: string,
  gitSnapshot: GitSnapshot,
  ctx: ExtensionCommandContext,
  progress?: ProgressStatus,
): Promise<string | undefined> {
  progress?.set("checking model credentials");
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (auth.ok === false) {
    ctx.ui.notify(`Cannot create implementation handoff: ${auth.error}`, "error");
    return undefined;
  }

  progress?.set("building model prompt");
  const userMessage: UserMessage = {
    role: "user",
    content: [{ type: "text", text: redact(buildImplementationPrompt(conversation, focus, cwd, sessionFile, gitSnapshot)) }],
    timestamp: Date.now(),
  };

  progress?.set(`waiting for ${ctx.model.id} response`);
  const response = await complete(
    ctx.model,
    { systemPrompt: IMPLEMENT_SYSTEM_PROMPT, messages: [userMessage] },
    { apiKey: auth.apiKey, headers: auth.headers },
  );

  if (response.stopReason === "aborted") {
    ctx.ui.notify("Implementation handoff creation cancelled", "info");
    return undefined;
  }

  return response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
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

      const file = await writeTempMarkdown("handoff", markdown);

      ctx.ui.notify(`Handoff saved: ${file}`, "info");
    },
  });

  pi.registerCommand("handoff-implement", {
    description: "Create handoff + implementation plan artifacts, then start a fresh implementation session",
    handler: async (args, ctx) => {
      const progress = createProgressStatus(ctx);
      let progressActive = true;

      try {
        progress.set("waiting for current turn");
        await ctx.waitForIdle();

        progress.set("collecting session context");
        const flags = parseHandoffImplementArgs(args);
        const parentSession = ctx.sessionManager.getSessionFile();
        const sessionFile = parentSession ?? "ephemeral";
        const branch = ctx.sessionManager.getBranch() as unknown[];
        const conversation = redact(conversationFromBranch(branch));

        if (!conversation.trim()) {
          ctx.ui.notify("No conversation branch found for implementation handoff", "error");
          return;
        }

        progress.set("collecting git snapshot");
        const gitSnapshot = await collectGitSnapshot(pi, ctx);
        const raw = await generateHandoffImplementArtifacts(conversation, flags.focus, ctx.cwd, sessionFile, gitSnapshot, ctx, progress);
        if (!raw) return;

        progress.set("parsing model output");
        const parsed = parseHandoffImplementResponse(redact(raw));
        const generated = new Date().toISOString();
        const timestamp = timestampForFile(new Date(generated));

        if (!parsed) {
          progress.set("writing raw fallback");
          const rawFile = await writeTempMarkdown("handoff-implement-raw", redact(raw), timestamp);
          ctx.ui.notify(`Could not split generated artifacts. Raw output saved: ${rawFile}`, "warning");
          if (flags.draft && ctx.hasUI) ctx.ui.setEditorText(buildRawFailurePrompt(rawFile));
          return;
        }

        const sharedMetadata = {
          generated,
          cwd: ctx.cwd,
          session: sessionFile,
          focus: flags.focus || "not specified",
        };

        progress.set("building markdown artifacts");
        const handoffMarkdown = addFrontmatter(parsed.handoffBody, sharedMetadata);
        const planMarkdown = addFrontmatter(parsed.planBody, {
          ...sharedMetadata,
          readiness: parsed.readiness,
          reason: parsed.reason,
        });

        progress.set("writing temp files");
        const [handoffFile, planFile] = await Promise.all([
          writeTempMarkdown("handoff", handoffMarkdown, timestamp),
          writeTempMarkdown("plan", planMarkdown, timestamp),
        ]);

        const kickoff = buildKickoffPrompt(handoffFile, planFile);

        if (flags.draft) {
          if (ctx.hasUI) ctx.ui.setEditorText(kickoff);
          ctx.ui.notify(`Draft implementation handoff saved: ${handoffFile} and ${planFile}`, "info");
          return;
        }

        if (parsed.readiness === "blocked" && !flags.force) {
          ctx.ui.notify(`Implementation handoff blocked: ${parsed.reason}. Saved: ${handoffFile} and ${planFile}`, "warning");
          return;
        }

        if (flags.confirm && ctx.hasUI) {
          progress.set("waiting for confirmation");
          const shouldStart = await ctx.ui.confirm(
            "Start fresh implementation session?",
            `Created:\n- ${handoffFile}\n- ${planFile}\n\nReadiness: ${parsed.readiness}\nReason: ${parsed.reason}\n\nSend kickoff prompt to a new session now?`,
          );

          if (!shouldStart) {
            ctx.ui.notify(`Implementation handoff saved: ${handoffFile} and ${planFile}`, "info");
            return;
          }
        }

        progress.set("starting fresh session");
        progress.clear();
        progressActive = false;

        const result = await ctx.newSession({
          parentSession,
          setup: async (sessionManager) => {
            sessionManager.appendSessionInfo(`Implement: ${flags.focus || "handoff"}`);
          },
          withSession: async (newCtx) => {
            await newCtx.sendUserMessage(kickoff);
          },
        });

        if (result.cancelled) {
          ctx.ui.notify(`New session cancelled. Implementation handoff saved: ${handoffFile} and ${planFile}`, "warning");
        }
      } finally {
        if (progressActive) progress.clear();
      }
    },
  });
}
