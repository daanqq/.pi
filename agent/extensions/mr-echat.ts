/**
 * mr-echat — commit + push + создание MR через glab.
 * Если MR для текущей ветки уже есть, может дополнить его описание новыми изменениями.
 *
 * Заменяет agent/prompts/mr-echat.md: все механические шаги (git, glab,
 * файловый I/O, цикл подтверждения title) выполняются детерминированно
 * в коде. Commit title генерируется отдельным complete() по diff. MR description
 * генерируется дополнительным turn текущей pi-сессии, чтобы переиспользовать
 * её модель, system prompt, tools и provider cache affinity.
 *
 * Использование:
 *   /mr-echat [task-branch] [--cwd <repo-path>]
 *
 *   task-branch — опционально: название ветки задачи. Если команда запущена
 *   на базовой ветке, перед началом работы будет создана ветка с этим названием.
 *   --cwd — опционально: git-репозиторий, относительно cwd сессии или абсолютный.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { complete, type Message } from "@earendil-works/pi-ai/compat";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EUTP_ID_RE = /EUTP-\d+/i;
const TITLE_MAX_ATTEMPTS = 3;
const MR_DESC_TMP = "/tmp/mr_description.md";
const LOG_FILE = path.join(os.homedir(), ".pi", "logs", "mr-echat.log");
const GENERATION_PROVIDER = "openai-codex";
const GENERATION_MODEL = "gpt-5.4-mini";
const GENERATION_THINKING = "high";
const BASE_BRANCHES = new Set(["main", "master", "develop", "dev", "stage", "staging"]);
const GENERATED_DIFF_EXCLUDES = [
  "**/package-lock.json",
  "**/npm-shrinkwrap.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/bun.lockb",
  "**/bun.lock",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/generated/**",
  "**/__generated__/**",
  "**/*.generated.*",
  "**/*.gen.*",
  "**/*.pb.*",
];

const TITLE_SYSTEM_PROMPT = `You are a commit message generator for an EChat project.
Given a git diff, output exactly one commit title.

Commit title rules:
- English, lowercase, imperative mood: add/fix/make/update/remove
- Briefly describes the essence of changes
- Ends with " #EUTP-NNNNNN"
- Examples from the repo:
  add cross-app text formatting copy-paste #EUTP-145771
  fix chat closing animation on mobile #EUTP-146265
  add invitation links #EUTP-115210
  fix formatting toolbar on Android #EUTP-144804

Output format (strict):
TITLE: <commit title>`;

// ---------------------------------------------------------------------------
// Instructions appended to the current pi session for MR description generation
// ---------------------------------------------------------------------------

const UPDATE_MR_DESC_PROMPT = `Update an existing GitLab MR description for an EChat project.
Use the preceding session as context about the task, its intent, implementation decisions, and verification.
Given the current MR description and a git diff with new changes, output the full updated MR description in Russian.

Rules:
- Keep the existing useful content and structure
- Add only information from the new diff
- Treat the git diff as the source of truth for implemented changes
- Do not include planned, abandoned, or unverified work from the session
- Use session context to explain intent and verification, but do not quote the conversation
- Do not duplicate existing items
- Keep Russian text
- Remove HTML/markdown comments if present
- Do not call tools

Output format (strict):
DESC:
<full updated MR description>`;

const MR_DESC_PROMPT = `Generate an MR description for an EChat project.
Use the preceding session as context about the task, its intent, implementation decisions, and verification.
Given a git diff and an MR template, output exactly the filled MR description in Russian.

MR description rules:
- Take the template and fill in the sections
- Treat the git diff as the source of truth for implemented changes
- Do not include planned, abandoned, or unverified work from the session
- Use session context to explain intent and verification, but do not quote the conversation
- Replace "На что обратить внимание при ревью и тестировании" with two subsections:
  ### Краткое описание изменений — each item: one change/fix/feature, affected files/modules
  ### Что нужно проверить тестировщикам — each item: specific scenario or component to test manually
- Remove any HTML/markdown comments from the template
- Keep Russian text
- If no migrations — keep "Нет."
- Do not call tools

Output format (strict):
DESC:
<filled MR description>`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type LogFn = (event: string, details?: Record<string, unknown>) => void;

type CommandArgs = {
  taskBranch?: string;
  cwd?: string;
};

type SessionGenerationFn = (
  ctx: any,
  prompt: string,
  event: string,
  details: Record<string, unknown>,
  log: LogFn,
) => Promise<string | null>;

function assistantMessageText(message: any): string {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n")
    .trim();
}

/** Разобрать позиционную ветку и опциональную рабочую директорию. */
function parseCommandArgs(raw: string): CommandArgs {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  let taskBranch: string | undefined;
  let cwd: string | undefined;

  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (part === "--cwd") {
      cwd = parts[++index];
      if (!cwd) throw new Error("После --cwd нужно указать путь к репозиторию");
    } else if (part.startsWith("--cwd=")) {
      cwd = part.slice("--cwd=".length);
      if (!cwd) throw new Error("После --cwd= нужно указать путь к репозиторию");
    } else if (part.startsWith("-")) {
      throw new Error(`Неизвестный аргумент: ${part}`);
    } else if (!taskBranch) {
      taskBranch = part;
    } else {
      throw new Error(`Лишний аргумент: ${part}`);
    }
  }

  return { taskBranch, cwd };
}

/** Создать best-effort логгер одного запуска, не влияющий на основной workflow. */
function createRunLogger(): LogFn {
  const runId = `${new Date().toISOString()}-${process.pid}`;
  const startedAt = Date.now();

  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  } catch {
    // Диагностическое логирование не должно ломать создание MR.
  }

  return (event, details = {}) => {
    try {
      fs.appendFileSync(LOG_FILE, `${JSON.stringify({
        timestamp: new Date().toISOString(),
        runId,
        elapsedMs: Date.now() - startedAt,
        event,
        ...details,
      })}\n`, "utf-8");
    } catch {
      // Диагностическое логирование не должно ломать создание MR.
    }
  };
}

/** Не писать содержимое MR в лог вместе с аргументами glab. */
function sanitizeExecArgs(args: string[]): string[] {
  const sanitized = [...args];
  const descriptionIndex = sanitized.indexOf("--description");
  if (descriptionIndex >= 0 && descriptionIndex + 1 < sanitized.length) {
    sanitized[descriptionIndex + 1] = `<redacted:${sanitized[descriptionIndex + 1].length} chars>`;
  }
  return sanitized;
}

async function withTiming<T>(
  log: LogFn,
  event: string,
  details: Record<string, unknown>,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  log(`${event}:start`, details);
  try {
    const result = await operation();
    log(`${event}:end`, { durationMs: Date.now() - startedAt });
    return result;
  } catch (error: any) {
    log(`${event}:error`, { durationMs: Date.now() - startedAt, error: error?.message ?? String(error) });
    throw error;
  }
}

/** Вытащить EUTP-ID из названия ветки. */
function extractTaskId(branch: string): string | null {
  const m = branch.match(EUTP_ID_RE);
  return m ? m[0] : null;
}

/** Найти последнее сообщение коммита по этой задаче в текущей ветке. */
async function getPreviousCommitTitle(exec: ExecFn, taskId: string): Promise<string | null> {
  const result = await exec("git", ["log", "-n", "1", "--no-merges", "--format=%s", "--fixed-strings", `--grep=${taskId}`]);
  const title = result.stdout.trim();
  return result.code === 0 && title ? title : null;
}

/** Получить MR-шаблон с подставленной ссылкой. */
function readTemplate(cwd: string, taskId: string): string {
  const tmplPath = `${cwd}/.gitlab/merge_request_templates/Default.md`;
  let text = fs.readFileSync(tmplPath, "utf-8");
  // Замена http → https и плейсхолдера на реальный номер
  text = text.replace(
    /http:\/\/youtrack\.esoft\.tech\/issue\/EUTP-[…\.]+/g,
    `https://youtrack.esoft.tech/issue/${taskId}`,
  );
  return text;
}

/** Аргументы git diff с исключением generated-файлов из текста для LLM. */
function diffArgs(...args: string[]): string[] {
  return ["diff", ...args, "--", ".", ...GENERATED_DIFF_EXCLUDES.map((p) => `:(exclude,glob)${p}`)];
}

/** Определить, какой diff использовать, и получить его. */
async function getDiff(exec: ExecFn): Promise<string> {
  const cached = await exec("git", diffArgs("--cached", "--name-only"));
  const unstaged = await exec("git", diffArgs("--name-only"));

  const hasCached = cached.stdout.trim().length > 0;
  const hasUnstaged = unstaged.stdout.trim().length > 0;

  if (hasCached) {
    const diff = await exec("git", diffArgs("--cached"));
    return diff.stdout;
  }
  // staged пуст — анализируем всё unstaged
  const diff = await exec("git", diffArgs());
  return diff.stdout;
}

type ExistingMr = { ref: string; url: string; targetBranch: string | null };

type ParentBranchCandidate = { branch: string; distance: number };

function normalizeRemoteBranch(ref: string): string {
  return ref.replace(/^origin\//, "");
}

/** Найти родительскую EUTP-ветку, если текущая ветка ответвлена от неё, а не от main/master. */
async function getParentTaskBranch(exec: ExecFn, branch: string, log: LogFn): Promise<string | null> {
  const refsResult = await exec("git", ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"]);
  if (refsResult.code !== 0) return null;

  const currentHead = (await exec("git", ["rev-parse", "HEAD"])).stdout.trim();
  const refs = [...new Set(refsResult.stdout.trim().split("\n").filter(Boolean))];
  const candidates = refs.filter((ref) => {
    const normalized = normalizeRemoteBranch(ref);
    return ref !== "origin/HEAD" && normalized !== branch && EUTP_ID_RE.test(normalized);
  });
  log("parent-branch:candidates", { totalRemoteRefs: refs.length, candidateCount: candidates.length });
  if (candidates.length === 0) return null;

  const originHead = (await exec("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])).stdout.trim();
  const defaultRefs = [originHead, "origin/main", "origin/master", "origin/develop", "origin/dev", "origin/stage", "origin/staging", "main", "master", "develop", "dev", "stage", "staging"].filter(Boolean);
  let defaultMergeBase: string | null = null;
  for (const ref of defaultRefs) {
    const exists = await exec("git", ["rev-parse", "--verify", "--quiet", ref]);
    if (exists.code !== 0) continue;
    const base = await exec("git", ["merge-base", "HEAD", ref]);
    if (base.code === 0 && base.stdout.trim()) {
      defaultMergeBase = base.stdout.trim();
      break;
    }
  }

  const matches: ParentBranchCandidate[] = [];
  for (const ref of candidates) {
    const base = await exec("git", ["merge-base", "HEAD", ref]);
    const mergeBase = base.stdout.trim();
    if (base.code !== 0 || !mergeBase || mergeBase === currentHead || mergeBase === defaultMergeBase) continue;

    if (defaultMergeBase) {
      const isAfterDefault = await exec("git", ["merge-base", "--is-ancestor", defaultMergeBase, mergeBase]);
      if (isAfterDefault.code !== 0) continue;
    }

    const distanceResult = await exec("git", ["rev-list", "--count", `${mergeBase}..HEAD`]);
    const distance = Number(distanceResult.stdout.trim());
    if (distanceResult.code !== 0 || !Number.isFinite(distance)) continue;
    matches.push({ branch: normalizeRemoteBranch(ref), distance });
  }

  matches.sort((a, b) => a.distance - b.distance || a.branch.localeCompare(b.branch));
  const selected = matches[0]?.branch ?? null;
  log("parent-branch:selected", { selected, matchCount: matches.length });
  return selected;
}

/** Найти MR для текущей ветки. */
async function getExistingMr(exec: ExecFn, branch: string): Promise<ExistingMr | null> {
  const result = await exec("glab", ["mr", "list", "--source-branch", branch, "--output", "json"]);
  if (result.code !== 0 || !result.stdout.trim() || result.stdout.trim() === "[]") return null;

  try {
    const mrs = JSON.parse(result.stdout);
    if (!Array.isArray(mrs) || mrs.length === 0) return null;
    const mr = mrs[0];
    const url = mr.web_url || mr.webUrl || mr.url;
    const ref = String(mr.iid || mr.id || url || "");
    const targetBranch = typeof mr.target_branch === "string" ? mr.target_branch : null;
    return url && ref ? { ref, url, targetBranch } : null;
  } catch {
    return null;
  }
}

/** Получить текущее описание MR. */
async function getMrDescription(exec: ExecFn, mrRef: string): Promise<string | null> {
  const result = await exec("glab", ["mr", "view", mrRef, "--output", "json", "--jq", ".description"]);
  if (result.code !== 0) return null;

  return result.stdout.trim();
}

/** Получить diff всех изменений ветки относительно target branch существующего MR. */
async function getBranchDiff(exec: ExecFn, targetBranch: string | null): Promise<string> {
  if (!targetBranch) return "";

  await exec("git", ["fetch", "--quiet", "origin", targetBranch]);
  const remoteTarget = `origin/${targetBranch}`;
  const remoteDiff = await exec("git", diffArgs(`${remoteTarget}...HEAD`));
  if (remoteDiff.code === 0) return remoteDiff.stdout;

  const localDiff = await exec("git", diffArgs(`${targetBranch}...HEAD`));
  return localDiff.code === 0 ? localDiff.stdout : "";
}

/** Получить username текущего glab-пользователя. */
async function getGlabUser(exec: ExecFn): Promise<string | null> {
  try {
    const result = await exec("glab", ["api", "user"]);
    if (result.code === 0) {
      const user = JSON.parse(result.stdout);
      return user.username || null;
    }
  } catch {
    // glab не настроен или ошибка
  }
  return null;
}

/**
 * Обновить origin/<branch> и проверить, есть ли в удалённой ветке коммиты,
 * которых нет в локальном HEAD. Обновлённый ref также служит безопасной
 * точкой ожидания для последующего --force-with-lease.
 */
async function remoteHasCommitsMissingLocally(exec: ExecFn, branch: string): Promise<boolean> {
  const remoteRef = `refs/remotes/origin/${branch}`;
  const fetchResult = await exec("git", [
    "fetch",
    "--quiet",
    "origin",
    `+refs/heads/${branch}:${remoteRef}`,
  ]);
  if (fetchResult.code !== 0) return false;

  const missingResult = await exec("git", ["rev-list", "--count", `HEAD..${remoteRef}`]);
  const missingCount = Number(missingResult.stdout.trim());
  return missingResult.code === 0 && Number.isFinite(missingCount) && missingCount > 0;
}

/** Тип для exec-обёртки с фиксированным cwd. */
type ExecFn = (cmd: string, args: string[], opts?: Record<string, unknown>) => Promise<{ stdout: string; stderr?: string; code: number }>;

/** Последний текстовый ответ агента из текущей ветки сессии. */
function getLastAgentResponse(ctx: any): string | null {
  const entries = ctx.sessionManager?.getBranch?.() ?? [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
    const content = entry.message.content;
    const text = (Array.isArray(content) ? content : [content])
      .map((part: any) => typeof part === "string" ? part : part?.type === "text" ? part.text : "")
      .filter(Boolean)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return null;
}

/** Проверить выбранную директорию. Без явного пути при необходимости найти дочерний репозиторий. */
async function ensureGitRepo(
  pi: ExtensionAPI,
  ctx: any,
  requestedCwd?: string,
): Promise<string | null> {
  const sessionCwd = ctx.cwd || process.cwd();
  const cwd = requestedCwd ? path.resolve(sessionCwd, requestedCwd) : sessionCwd;

  if (requestedCwd) {
    try {
      if (!fs.statSync(cwd).isDirectory()) throw new Error("not a directory");
    } catch {
      ctx.ui.notify(`Директория не найдена: ${cwd}`, "error");
      return null;
    }
  }

  // Проверяем, является ли текущая папка git-репозиторием
  const check = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd });
  if (check.code === 0) {
    return check.stdout.trim() || cwd;
  }

  if (requestedCwd) {
    ctx.ui.notify(`Не git-репозиторий: ${cwd}`, "error");
    return null;
  }

  // Не репозиторий — ищем дочерние папки с .git
  ctx.ui.notify("Текущая папка не git-репозиторий. Ищу дочерние...", "info");

  const lsResult = await pi.exec("bash", ["-c", 'for d in */; do [ -d "$d/.git" ] && echo "${d%/}"; done'], { cwd });
  const dirs = lsResult.stdout.trim().split("\n").filter(Boolean);

  if (dirs.length === 0) {
    ctx.ui.notify("Не найдено git-репозиториев в дочерних папках", "error");
    return null;
  }

  if (dirs.length === 1) {
    // Один репозиторий — используем без вопроса
    const selected = path.resolve(cwd, dirs[0]);
    ctx.ui.notify(`Автовыбор: ${dirs[0]}`, "info");
    return selected;
  }

  // Несколько — даём выбрать
  const selected = await ctx.ui.select("Выбери git-репозиторий", dirs);
  if (!selected) {
    return null; // пользователь отменил
  }

  return path.resolve(cwd, selected);
}

/** Вызвать LLM для генерации commit title. */
async function generateTitle(ctx: any, taskId: string, diff: string, lastAgentResponse: string | null, log: LogFn): Promise<string | null> {
  const model = ctx.modelRegistry.find(GENERATION_PROVIDER, GENERATION_MODEL);
  if (!model) {
    ctx.ui.notify(`Модель не найдена: ${GENERATION_PROVIDER}/${GENERATION_MODEL}`, "error");
    return null;
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    ctx.ui.notify(`Нет API-ключа для ${GENERATION_PROVIDER}`, "error");
    return null;
  }

  const diffBlock = diff;
  // ponytail: diff без ограничения, проблема — если модель не влезает в контекст
  if (diffBlock.length > 80_000) {
    ctx.ui.notify(`Diff большой (${diffBlock.length} символов). Модель может не справиться.`, "warning");
  }

  const userMessage: Message = {
    role: "user",
    content: [{ type: "text", text: [`Task: ${taskId}`, lastAgentResponse && `Last agent response:\n${lastAgentResponse}`, `Git diff:`, diffBlock].filter(Boolean).join("\n\n") }],
    timestamp: Date.now(),
  };

  ctx.ui.notify("Генерирую заголовок коммита...", "info");

  const response = await withTiming(log, "llm:title", { diffChars: diff.length }, () =>
    complete(
      model,
      { systemPrompt: TITLE_SYSTEM_PROMPT, messages: [userMessage] },
      { apiKey: auth.apiKey, headers: auth.headers, reasoningEffort: GENERATION_THINKING },
    ),
  );

  const text = response.content
    .filter((c: any): c is { type: "text"; text: string } => c.type === "text")
    .map((c: any) => c.text)
    .join("\n");

  const titleMatch = text.match(/^TITLE:\s*(.+?)$/m);
  if (!titleMatch) {
    ctx.ui.notify("LLM вернул ответ не по формату. TITLE: не найден.", "error");
    return null;
  }

  return titleMatch[1].trim();
}

/** Вызвать LLM для генерации MR description после выбора commit title. */
async function generateDescription(
  ctx: any,
  taskId: string,
  diff: string,
  template: string,
  log: LogFn,
  generateInSession: SessionGenerationFn,
): Promise<string | null> {
  if (diff.length > 80_000) {
    ctx.ui.notify(`Diff большой (${diff.length} символов). Модель может не справиться.`, "warning");
  }

  const prompt = [MR_DESC_PROMPT, `Task: ${taskId}`, "Template:", template, "Git diff:", diff].join("\n\n");

  ctx.ui.notify("Генерирую описание MR...", "info");
  const text = await generateInSession(
    ctx,
    prompt,
    "llm:description",
    { diffChars: diff.length, templateChars: template.length },
    log,
  );
  if (!text) return null;

  const descMatch = text.match(/^DESC:\s*([\s\S]*)$/m);
  if (!descMatch) {
    ctx.ui.notify("LLM вернул ответ не по формату. DESC: не найден.", "error");
    return null;
  }
  return descMatch[1].trim();
}

/** Составить новое описание существующего MR из текущего описания и новых изменений. */
async function generateUpdatedDescription(
  ctx: any,
  taskId: string,
  currentDescription: string,
  diff: string,
  log: LogFn,
  generateInSession: SessionGenerationFn,
): Promise<string | null> {
  const prompt = [
    UPDATE_MR_DESC_PROMPT,
    `Task: ${taskId}`,
    "Current MR description:",
    currentDescription,
    "New git diff:",
    diff,
  ].join("\n\n");

  ctx.ui.notify("Обновляю описание существующего MR...", "info");
  const text = await generateInSession(
    ctx,
    prompt,
    "llm:description-update",
    { diffChars: diff.length, currentDescriptionChars: currentDescription.length },
    log,
  );
  if (!text) return null;

  const descMatch = text.match(/^DESC:\s*([\s\S]*)$/m);
  if (!descMatch) {
    ctx.ui.notify("LLM вернул ответ не по формату. DESC: не найден.", "error");
    return null;
  }
  return descMatch[1].trim();
}

/** Цикл подтверждения commit title.
 *  Принимает уже сгенерированный первый вариант, чтобы избежать лишнего вызова complete(). */
async function confirmTitle(
  ctx: any,
  taskId: string,
  firstTitle: string,
  previousTitle: string | null,
  generateAnother: () => Promise<string | null>,
): Promise<string | null> {
  let title = firstTitle;
  let attempts = 1;

  while (true) {
    if (previousTitle) {
      const action = await ctx.ui.select("Заголовок коммита", [
        `Использовать сгенерированный: ${title}`,
        `Использовать существующий: ${previousTitle}`,
        "Сгенерировать другой вариант",
        "Ввести вручную",
      ]);
      if (!action) return null;
      if (action.startsWith("Использовать сгенерированный")) return title;
      if (action.startsWith("Использовать существующий")) return previousTitle;
      if (action === "Ввести вручную") {
        const manual = await ctx.ui.input("Введи название коммита (без #EUTP-XXX):");
        if (manual) return `${manual.trim()} #${taskId}`;
        return null;
      }
    } else {
      const action = await ctx.ui.select("Заголовок коммита", [
        `Использовать сгенерированный: ${title}`,
        "Сгенерировать другой вариант",
        "Ввести вручную",
      ]);
      if (!action) return null;
      if (action.startsWith("Использовать сгенерированный")) return title;
      if (action === "Ввести вручную") {
        const manual = await ctx.ui.input("Введи название коммита (без #EUTP-XXX):");
        if (manual) return `${manual.trim()} #${taskId}`;
        return null;
      }
    }

    if (attempts >= TITLE_MAX_ATTEMPTS) {
      const manual = await ctx.ui.input("Введи название коммита (без #EUTP-XXX):");
      if (manual) return `${manual.trim()} #${taskId}`;
      return null;
    }

    ctx.ui.notify("Генерирую другой вариант...", "info");
    const nextTitle = await generateAnother();
    if (!nextTitle) return null;
    title = nextTitle;
    attempts++;
  }
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  let sessionGenerationActive = false;

  pi.on("tool_call", () => {
    if (!sessionGenerationActive) return;
    return { block: true, reason: "MR description generation must not call tools" };
  });

  pi.on("input", (_event, ctx) => {
    if (!sessionGenerationActive) return;
    ctx.ui.notify("Дождись завершения генерации описания MR", "warning");
    return { action: "handled" };
  });

  const generateInSession: SessionGenerationFn = async (ctx, prompt, event, details, log) => {
    if (sessionGenerationActive) {
      ctx.ui.notify("Генерация описания MR уже выполняется", "error");
      return null;
    }
    if (!ctx.model) {
      ctx.ui.notify("В текущей сессии не выбрана модель", "error");
      return null;
    }

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
    if (!auth.ok) {
      ctx.ui.notify(`Нет авторизации для ${ctx.model.provider}/${ctx.model.id}`, "error");
      return null;
    }

    const previousLeafId = ctx.sessionManager.getLeafId();
    const startedAt = Date.now();
    try {
      sessionGenerationActive = true;
      log(`${event}:start`, {
        ...details,
        model: `${ctx.model.provider}/${ctx.model.id}`,
        thinking: pi.getThinkingLevel(),
      });
      pi.sendMessage({
        customType: "mr-echat-generation",
        content: prompt,
        display: false,
        details: { purpose: "mr-description" },
      }, { triggerTurn: true });
      await ctx.waitForIdle();

      const branch = ctx.sessionManager.getBranch();
      const previousLeafIndex = previousLeafId ? branch.findIndex((entry: any) => entry.id === previousLeafId) : -1;
      const generatedEntries = branch.slice(previousLeafIndex + 1);
      const response = [...generatedEntries]
        .reverse()
        .map((entry: any) => entry.type === "message" ? entry.message : null)
        .find((message: any) => assistantMessageText(message));
      const text = assistantMessageText(response);

      log(`${event}:end`, {
        ...details,
        durationMs: Date.now() - startedAt,
        usage: response?.usage,
        responseChars: text.length,
      });
      if (!text) ctx.ui.notify("Модель не вернула текст описания MR", "error");
      return text || null;
    } catch (error: any) {
      log(`${event}:error`, {
        ...details,
        durationMs: Date.now() - startedAt,
        error: error?.message ?? String(error),
      });
      throw error;
    } finally {
      sessionGenerationActive = false;
    }
  };

  pi.registerCommand("mr-echat", {
    description: "Commit + push + создать MR через glab; [ветка] [--cwd путь]",
    handler: async (args, ctx) => {
      const log = createRunLogger();
      log("run:start", { cwd: ctx.cwd || process.cwd(), args: args.trim() });
      try {
        if (sessionGenerationActive) {
          ctx.ui.notify("Предыдущая генерация описания MR ещё выполняется", "warning");
          return;
        }
        await ctx.waitForIdle();

        const { taskBranch, cwd: requestedCwd } = parseCommandArgs(args);
        const lastAgentResponse = getLastAgentResponse(ctx);

        // 0. Определить рабочую директорию (git-репозиторий)
        const repoDir = await ensureGitRepo(pi, ctx, requestedCwd);
        if (!repoDir) return;
        log("repo:selected", { repoDir, explicit: Boolean(requestedCwd) });

        // Обёртка pi.exec с фиксированным cwd
        const exec: ExecFn = async (cmd, args, opts) => {
          const commandStartedAt = Date.now();
          const safeArgs = sanitizeExecArgs(args);
          log("exec:start", { cmd, args: safeArgs });
          try {
            const result = await pi.exec(cmd, args, { ...opts, cwd: repoDir });
            log("exec:end", {
              cmd,
              args: safeArgs,
              durationMs: Date.now() - commandStartedAt,
              code: result.code,
              stdoutChars: result.stdout.length,
              stderrChars: result.stderr?.length ?? 0,
            });
            return result;
          } catch (error: any) {
            log("exec:error", {
              cmd,
              args: safeArgs,
              durationMs: Date.now() - commandStartedAt,
              error: error?.message ?? String(error),
            });
            throw error;
          }
        };

        // 1. На базовой ветке создать переданную ветку задачи
        let branchResult = await exec("git", ["branch", "--show-current"]);
        if (branchResult.code !== 0 || !branchResult.stdout.trim()) {
          ctx.ui.notify("Не удалось определить текущую ветку", "error");
          return;
        }
        let branch = branchResult.stdout.trim();
        if (taskBranch && BASE_BRANCHES.has(branch)) {
          const validBranch = await exec("git", ["check-ref-format", "--branch", taskBranch]);
          if (validBranch.code !== 0) {
            ctx.ui.notify(`Некорректное название ветки: ${taskBranch}`, "error");
            return;
          }

          const switchResult = await exec("git", ["switch", "-c", taskBranch]);
          if (switchResult.code !== 0) {
            ctx.ui.notify(`Не удалось создать ветку ${taskBranch}: ${switchResult.stderr}`, "error");
            return;
          }
          branch = taskBranch;
          ctx.ui.notify(`Создана ветка ${branch}`, "info");
        }

        // 2. Извлечь EUTP-ID из ветки
        const taskId = extractTaskId(branch);
        if (!taskId) {
          ctx.ui.notify(`Не найден EUTP-ID в названии ветки: ${branch}`, "error");
          return;
        }

        // 3. Проверить существующий MR до генерации описания
        const existingMr = await getExistingMr(exec, branch);

        // 4. Получить diff
        const diff = await getDiff(exec);
        if (!diff.trim()) {
          if (!existingMr) {
            ctx.ui.notify("Нет изменений для коммита", "error");
            return;
          }

          const currentDescription = await getMrDescription(exec, existingMr.ref);
          if (currentDescription === null) {
            ctx.ui.notify("Не удалось прочитать текущее описание MR", "error");
            return;
          }

          const branchDiff = await getBranchDiff(exec, existingMr.targetBranch);
          if (!branchDiff.trim()) {
            ctx.ui.notify("Нет локальных изменений и не удалось получить diff ветки MR", "error");
            return;
          }

          const updatedDescription = await generateUpdatedDescription(ctx, taskId, currentDescription, branchDiff, log, generateInSession);
          if (!updatedDescription) return;
          const updateResult = await exec("glab", ["mr", "update", existingMr.ref, "--description", updatedDescription]);
          if (updateResult.code !== 0) {
            ctx.ui.notify(`Ошибка glab mr update: ${updateResult.stderr}`, "error");
            return;
          }
          ctx.ui.notify(`Описание MR обновлено по изменениям ветки: ${existingMr.url}`, "info");
          return;
        }

        // 5. Подготовить MR-шаблон, но описание генерировать только после выбора title
        let description: string | null = null;
        let template: string | null = null;
        let updateExistingMrDescription = false;
        const previousTitle = await getPreviousCommitTitle(exec, taskId);

        if (!existingMr) {
          try {
            template = readTemplate(repoDir, taskId);
          } catch {
            ctx.ui.notify("Не найден .gitlab/merge_request_templates/Default.md", "error");
            return;
          }
        }

        // 6. Определить commit title
        let commitTitle: string;
        const titleChoices = previousTitle
          ? [`Использовать существующее сообщение: ${previousTitle}`, "Сгенерировать название коммита", "Ввести своё"]
          : ["Сгенерировать название коммита", "Ввести своё"];
        const titleAction = await ctx.ui.select("Заголовок коммита", titleChoices);
        if (!titleAction) return;

        if (titleAction.startsWith("Использовать существующее")) {
          commitTitle = previousTitle!;
        } else if (titleAction === "Ввести своё") {
          const manual = await ctx.ui.input("Введи название коммита (без #EUTP-XXX):");
          if (!manual) {
            ctx.ui.notify("Заголовок коммита не задан — отмена", "warning");
            return;
          }
          commitTitle = `${manual.trim()} #${taskId}`;
        } else {
          const firstTitle = await generateTitle(ctx, taskId, diff, lastAgentResponse, log);
          if (!firstTitle) return;
          const confirmed = await confirmTitle(ctx, taskId, firstTitle, previousTitle, async () => generateTitle(ctx, taskId, diff, lastAgentResponse, log));
          if (!confirmed) {
            ctx.ui.notify("Заголовок коммита не задан — отмена", "warning");
            return;
          }
          commitTitle = confirmed;
        }

        if (existingMr) {
          updateExistingMrDescription = await ctx.ui.confirm("MR уже существует", "Дополнить описание MR новыми изменениями?");
        } else {
          description = await generateDescription(ctx, taskId, diff, template!, log, generateInSession);
          if (!description) return;
          fs.writeFileSync(MR_DESC_TMP, description, "utf-8");
        }

        // 7. Commit + push
        const cachedCheck = await exec("git", ["diff", "--cached", "--name-only"]);
        const hasCached = cachedCheck.stdout.trim().length > 0;
        const unstagedCheck = await exec("git", ["diff", "--name-only"]);
        const hasUnstaged = unstagedCheck.stdout.trim().length > 0;

        if (hasCached) {
          // Коммитим только staged
          ctx.ui.notify("Коммичу staged изменения...", "info");
        } else if (hasUnstaged) {
          // Добавляем всё unstaged
          ctx.ui.notify("Добавляю все изменения...", "info");
          const addResult = await exec("git", ["add", "-A"]);
          if (addResult.code !== 0) {
            ctx.ui.notify(`Ошибка git add: ${addResult.stderr}`, "error");
            return;
          }
        } else {
          ctx.ui.notify("Нет изменений для коммита", "error");
          return;
        }

        const commitResult = await exec("git", ["commit", "-m", commitTitle]);
        if (commitResult.code !== 0) {
          ctx.ui.notify(`Ошибка git commit: ${commitResult.stderr}`, "error");
          return;
        }

        let pushResult = await exec("git", ["push", "-u", "origin", "HEAD"]);
        if (pushResult.code !== 0 && await remoteHasCommitsMissingLocally(exec, branch)) {
          const forceAction = await ctx.ui.select(
            "Удалённая ветка содержит коммиты, которых нет локально. Выполнить push with lease?",
            ["Нет", "Да — push --force-with-lease"],
          );
          if (forceAction !== "Да — push --force-with-lease") {
            ctx.ui.notify("Push отменён: удалённая ветка не перезаписана", "warning");
            return;
          }

          pushResult = await exec("git", ["push", "--force-with-lease", "-u", "origin", "HEAD"]);
        }
        if (pushResult.code !== 0) {
          ctx.ui.notify(`Ошибка git push: ${pushResult.stderr || pushResult.stdout}`, "error");
          return;
        }
        ctx.ui.notify("Запушено ✓", "info");
        if (!existingMr) {
          ctx.ui.notify(description ? "Готовлю создание MR..." : "Генерирую описание MR...", "info");
          log("mr-creation:prepare:start");
        }

        // 8. Если MR уже был — при необходимости обновить описание и выйти
        if (existingMr) {
          if (updateExistingMrDescription) {
            const currentDescription = await getMrDescription(exec, existingMr.ref);
            if (currentDescription === null) {
              ctx.ui.notify("Не удалось прочитать текущее описание MR", "error");
              return;
            }
            const updatedDescription = await generateUpdatedDescription(ctx, taskId, currentDescription, diff, log, generateInSession);
            if (!updatedDescription) return;
            const updateResult = await exec("glab", ["mr", "update", existingMr.ref, "--description", updatedDescription]);
            if (updateResult.code !== 0) {
              ctx.ui.notify(`Ошибка glab mr update: ${updateResult.stderr}`, "error");
              return;
            }
            ctx.ui.notify("Описание MR обновлено ✓", "info");
          }
          ctx.ui.notify(`MR уже существует: ${existingMr.url}`, "info");
          return;
        }

        // 9. Создать MR
        log("mr-creation:user:start");
        const username = await getGlabUser(exec);
        log("mr-creation:user:end", { usernameFound: Boolean(username) });
        const descContent = description ?? fs.readFileSync(MR_DESC_TMP, "utf-8");
        log("mr-creation:parent-branch:start");
        const targetBranch = await getParentTaskBranch(exec, branch, log);
        log("mr-creation:parent-branch:end", { targetBranch });

        const mrArgs = [
          "mr", "create",
          "--title", commitTitle,
          "--description", descContent,
          "--yes",
        ];
        if (username) {
          mrArgs.push("--assignee", username);
        }
        if (targetBranch) {
          mrArgs.push("--target-branch", targetBranch);
        }

        ctx.ui.notify(targetBranch ? `Создаю MR в ${targetBranch}...` : "Создаю MR...", "info");
        log("mr-creation:glab-create:start", { targetBranch, hasAssignee: Boolean(username) });
        const createResult = await exec("glab", mrArgs);
        log("mr-creation:glab-create:end", { code: createResult.code });

        if (createResult.code !== 0) {
          ctx.ui.notify(`Ошибка glab mr create: ${createResult.stderr}`, "error");
          return;
        }

        // 10. Вывести результат
        const webUrlMatch = createResult.stdout.match(/https:\/\/gitlab\.[^\s]+/);
        if (webUrlMatch) {
          ctx.ui.notify(`MR создан: ${webUrlMatch[0]}`, "info");
        } else {
          ctx.ui.notify(`MR создан. Вывод:\n${createResult.stdout.slice(0, 500)}`, "info");
        }
      } catch (err: any) {
        log("run:error", { error: err?.message ?? String(err) });
        ctx.ui.notify(`Ошибка mr-echat: ${err.message}`, "error");
      } finally {
        log("run:end");
      }
    },
  });
}
