import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const REVIEWS_ROOT = "/home/user/echat/reviews";
const GITLAB_HOST = "https://git.esoft.tech";
const EUTP_ID_RE = /(EUTP-\d+)/i;
const MR_URL_RE = /^https:\/\/git\.esoft\.tech\/tidy\/([^/]+)\/-\/merge_requests\/(\d+)/;
const MR_URL_SCAN_RE = /https:\/\/git\.esoft\.tech\/tidy\/([^/\s]+)\/-\/merge_requests\/(\d+)/g;
const API_BASE = "https://urs.esoft.tech/api/user/youtrack/v1/issues";

const THERMO_PROMPT = `Perform a deep code quality audit of the current branch's changes.
Rethink how to structure / implement the changes to meaningfully improve code quality without impacting behavior.
Work to improve abstractions, modularity, reduce Spaghetti code, improve succinctness and legibility.
Be ambitious, if there is a clear path to improving the implementation that involves restructuring some of the codebase, go for it.
Be extremely thorough and rigorous. Measure twice, cut once.

Apply these review rules:
- Be ambitious about structural simplification and code-judo moves.
- Flag files pushed past 1000 lines without a very strong reason.
- Be suspicious of ad-hoc conditionals, feature checks scattered across shared code, casts, any/unknown, unnecessary optionality, wrappers, and bespoke helpers where canonical helpers exist.
- Prefer deletion, direct boring code, correct ownership boundaries, and atomic/simple orchestration.
- Do not approve merely because behavior seems correct.`;

type MrRef = { repo: string; iid: string; url: string };
type GitLabMr = { title?: string; description?: string; source_branch?: string; target_branch?: string; web_url?: string };
type TaskData = Record<string, unknown>;
type ReviewParams = { refs: MrRef[]; explicitSession?: string; extraInfo: string; relatedTaskIds: string[] };
type ExecFn = (cmd: string, args: string[], opts?: Record<string, unknown>) => Promise<{ stdout: string; stderr?: string; code: number }>;

export default function (pi: ExtensionAPI) {
  pi.registerCommand("mr-review", {
    description: "Review GitLab MR in /home/user/echat/reviews with EUTP task context",
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("Дождись завершения текущего хода агента перед /mr-review.", "warning");
        return;
      }

      const params = args.trim() ? parseArgs(args) : await promptReviewParams(ctx);
      if (!params) return;

      const { refs, explicitSession, extraInfo, relatedTaskIds } = params;
      if (refs.length === 0) {
        ctx.ui.notify("Укажи MR URL: /mr-review https://git.esoft.tech/tidy/<repo>/-/merge_requests/<iid> [pora_session]", "error");
        return;
      }

      const session = await resolvePoraSession(ctx, explicitSession);
      const relatedTasks = await fetchRelatedTasks(relatedTaskIds, session);
      const prompts: string[] = [];
      const errors: string[] = [];

      for (const ref of refs) {
        try {
          prompts.push(await prepareOneMrReview(pi, ctx, ref, session, extraInfo, relatedTasks));
        } catch (err: any) {
          const message = `## ${ref.repo} MR !${ref.iid}\n\nОшибка: ${err.message}`;
          errors.push(message);
          ctx.ui.notify(message, "error");
        }
      }

      if (prompts.length > 0) {
        pi.sendUserMessage(prompts.join("\n\n---\n\n"));
      }
      if (errors.length > 0 && !ctx.hasUI) {
        ctx.ui.notify(errors.join("\n\n---\n\n"), "error");
      }
    },
  });
}

async function prepareOneMrReview(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  ref: MrRef,
  poraSession: string | null,
  extraInfo: string,
  relatedTasks: Array<{ id: string; task: TaskData | null }>,
): Promise<string> {
  const repoDir = path.join(REVIEWS_ROOT, ref.repo);
  if (!fs.existsSync(path.join(repoDir, ".git"))) {
    throw new Error(`Не найден локальный репозиторий: ${repoDir}`);
  }

  const exec: ExecFn = (cmd, args, opts) => pi.exec(cmd, args, { ...opts, cwd: repoDir });
  const mr = await fetchGitLabMr(pi, ref);
  const sourceBranch = mr?.source_branch ?? "";
  const targetBranch = `mr-${ref.iid}`;
  const baseBranch = await preferredBaseBranch(pi, repoDir, mr?.target_branch);
  await checkoutBaseBranch(exec, baseBranch);
  await fetchMr(exec, ref.iid, targetBranch);
  const taskId = extractTaskId(sourceBranch)
    ?? extractTaskId(`${mr?.title ?? ""}\n${mr?.description ?? ""}`)
    ?? await extractTaskIdFromCommits(exec, targetBranch, baseBranch);
  if (!taskId) {
    throw new Error(`Не найден EUTP-ID в source_branch/title/description/commits MR: ${sourceBranch || "—"}`);
  }
  renameSession(ctx, `${taskId} ${ref.repo} mr-${ref.iid} review`);
  const mergeBase = await resolveMergeBase(exec, targetBranch, baseBranch);
  const task = poraSession ? await fetchTask(taskId, poraSession) : null;

  ctx.ui.notify(`Подготовил ${ref.repo}!${ref.iid}: ${sourceBranch || targetBranch}, задача ${taskId}`, "info");
  return buildReviewPrompt({ ref, mr, taskId, task, baseBranch, targetBranch, mergeBase, extraInfo, relatedTasks });
}

function parseArgs(raw: string): ReviewParams {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  const refs: MrRef[] = [];
  let explicitSession: string | undefined;

  for (const [index, part] of parts.entries()) {
    const m = part.match(MR_URL_RE);
    if (m) {
      refs.push({ repo: m[1]!, iid: m[2]!, url: part });
    } else if (index === 1 && part !== "''") {
      explicitSession = part;
    }
  }

  return { refs, explicitSession, extraInfo: "", relatedTaskIds: [] };
}

async function promptReviewParams(ctx: ExtensionCommandContext): Promise<ReviewParams | null> {
  if (!ctx.hasUI) {
    ctx.ui.notify("Укажи MR URL: /mr-review <MR-URL> [pora_session]", "error");
    return null;
  }

  const text = await ctx.ui.editor("Параметры MR review", `Ссылка на MR:
Токен PORA:
Дополнительная информация к задаче:
Задачи Youtrack описание которых нужно спарсить и соотнести с задачей:
`);
  return text ? parseStructuredParams(text) : null;
}

function parseStructuredParams(text: string): ReviewParams {
  const fields = readFields(text, [
    "Ссылка на MR",
    "Токен PORA",
    "Дополнительная информация к задаче",
    "Задачи Youtrack описание которых нужно спарсить и соотнести с задачей",
  ]);
  return {
    refs: parseMrRefs(fields["Ссылка на MR"] ?? ""),
    explicitSession: optionalField(fields["Токен PORA"]),
    extraInfo: (fields["Дополнительная информация к задаче"] ?? "").trim(),
    relatedTaskIds: extractTaskIds(fields["Задачи Youtrack описание которых нужно спарсить и соотнести с задачей"] ?? ""),
  };
}

function readFields(text: string, labels: string[]): Record<string, string> {
  const out: Record<string, string[]> = {};
  let current: string | null = null;

  for (const line of text.split(/\r?\n/)) {
    const label = labels.find((x) => line.startsWith(`${x}:`));
    if (label) {
      current = label;
      out[current] = [line.slice(label.length + 1).trim()];
    } else if (current) {
      out[current]!.push(line);
    }
  }

  return Object.fromEntries(Object.entries(out).map(([key, lines]) => [key, lines.join("\n").trim()]));
}

function optionalField(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed !== "''" ? trimmed : undefined;
}

function parseMrRefs(text: string): MrRef[] {
  return [...text.matchAll(MR_URL_SCAN_RE)].map((m) => ({ repo: m[1]!, iid: m[2]!, url: m[0] }));
}

function extractTaskId(text: string): string | null {
  const m = text.match(EUTP_ID_RE);
  return m ? m[1]!.toUpperCase() : null;
}

function extractTaskIds(text: string): string[] {
  return [...new Set([...text.matchAll(new RegExp(EUTP_ID_RE, "gi"))].map((m) => m[1]!.toUpperCase()))];
}

async function fetchGitLabMr(pi: ExtensionAPI, ref: MrRef): Promise<GitLabMr | null> {
  const project = encodeURIComponent(`tidy/${ref.repo}`);
  const url = `${GITLAB_HOST}/api/v4/projects/${project}/merge_requests/${ref.iid}`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (process.env.GITLAB_TOKEN) headers["Private-Token"] = process.env.GITLAB_TOKEN;

  try {
    const res = await fetch(url, { headers });
    if (res.ok) {
      const parsed = parseJsonObject<GitLabMr>(await res.text());
      if (parsed) return parsed;
    }
  } catch {
    // glab fallback below
  }

  const glab = await pi.exec("glab", ["api", `/projects/${project}/merge_requests/${ref.iid}`], { timeout: 15_000 });
  if (glab.code === 0 && glab.stdout.trim()) return parseJsonObject<GitLabMr>(glab.stdout);
  return null;
}

function parseJsonObject<T extends object>(text: string): T | null {
  try {
    const data = JSON.parse(text) as unknown;
    return data && typeof data === "object" && !Array.isArray(data) ? data as T : null;
  } catch {
    // ponytail: GitLab sometimes returns an HTML login page; treat it as unavailable metadata.
    return null;
  }
}

async function checkoutBaseBranch(exec: ExecFn, baseBranch: string): Promise<void> {
  const current = (await exec("git", ["branch", "--show-current"], { timeout: 5_000 })).stdout.trim();
  const localBase = baseBranch.startsWith("origin/") ? baseBranch.slice("origin/".length) : baseBranch;
  if (current === baseBranch || current === localBase) return;

  const args = baseBranch.startsWith("origin/") ? ["switch", "--detach", baseBranch] : ["switch", baseBranch];
  const result = await exec("git", args, { timeout: 15_000 });
  if (result.code !== 0) throw new Error(`Не удалось переключиться на ${baseBranch}: ${result.stderr || result.stdout}`);
}

async function fetchMr(exec: ExecFn, iid: string, branch: string): Promise<void> {
  const result = await exec("git", ["fetch", "origin", `merge-requests/${iid}/head:refs/heads/${branch}`], { timeout: 60_000 });
  if (result.code !== 0) throw new Error(`git fetch MR failed: ${result.stderr || result.stdout}`);
}

async function extractTaskIdFromCommits(exec: ExecFn, branch: string, baseBranch: string): Promise<string | null> {
  const result = await exec("git", ["log", branch, "--not", baseBranch, "--format=%B"], { timeout: 10_000 });
  return result.code === 0 ? extractTaskId(result.stdout) : null;
}

async function preferredBaseBranch(pi: ExtensionAPI, cwd: string, target?: string): Promise<string> {
  const candidates = [
    target && `origin/${target}`,
    target,
    "origin/HEAD",
    "origin/master",
    "origin/main",
    "origin/stage",
    "origin/develop",
    "master",
    "main",
    "stage",
    "develop",
  ].filter(Boolean) as string[];
  for (const branch of candidates) {
    const result = await pi.exec("git", ["rev-parse", "--verify", `${branch}^{commit}`], { cwd, timeout: 5_000 });
    if (result.code === 0) return branch;
  }
  throw new Error("Не найдена базовая ветка: target/master/main/stage/develop");
}

async function resolveMergeBase(exec: ExecFn, targetBranch: string, baseBranch: string): Promise<string> {
  const result = await exec("git", ["merge-base", targetBranch, baseBranch], { timeout: 5_000 });
  if (result.code !== 0 || !result.stdout.trim()) throw new Error(`Не найден merge-base для ${targetBranch} и ${baseBranch}`);
  return result.stdout.trim();
}

async function resolvePoraSession(ctx: ExtensionCommandContext, explicitSession?: string): Promise<string | null> {
  if (explicitSession !== undefined) {
    process.env.PORA_SESSION = explicitSession;
    updateZshrc(explicitSession);
    return explicitSession;
  }

  if (process.env.PORA_SESSION) return process.env.PORA_SESSION;
  if (!ctx.hasUI) return null;

  const input = await ctx.ui.input("PORA_SESSION не задан. Вставь pora-gatekeeper-session или Esc чтобы продолжить без задачи:");
  if (!input) return null;
  process.env.PORA_SESSION = input;
  updateZshrc(input);
  return input;
}

function updateZshrc(session: string): void {
  const zshrc = path.join(os.homedir(), ".zshrc");
  const line = `export PORA_SESSION='${session.replace(/'/g, "'\\''")}'`;
  let text = "";
  try { text = fs.readFileSync(zshrc, "utf-8"); } catch {}
  text = /^export PORA_SESSION=.*$/m.test(text)
    ? text.replace(/^export PORA_SESSION=.*$/m, line)
    : text.trimEnd() + (text ? "\n" : "") + line + "\n";
  fs.writeFileSync(zshrc, text, "utf-8");
}

async function fetchTask(taskId: string, session: string): Promise<TaskData | null> {
  const res = await fetch(`${API_BASE}/${taskId}`, {
    headers: {
      Cookie: `pora-gatekeeper-session=${session}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) return null;
  return await res.json() as TaskData;
}

async function fetchRelatedTasks(taskIds: string[], session: string | null): Promise<Array<{ id: string; task: TaskData | null }>> {
  return Promise.all(taskIds.map(async (id) => {
    try {
      return { id, task: session ? await fetchTask(id, session) : null };
    } catch {
      return { id, task: null };
    }
  }));
}

function taskSummary(taskId: string, task: TaskData | null): string {
  if (!task) return `- **ID**: ${taskId}\n- **Данные**: не загружены; сверяй минимум по заголовку MR/задачи.`;
  const assignee = task.assignee as Record<string, unknown> | undefined;
  const sprints = task.sprints as Array<Record<string, unknown>> | undefined;
  const links = task.links as Record<string, unknown> | undefined;
  return [
    `- **ID**: ${fmt(task.id)}`,
    `- **Заголовок**: ${fmt(task.title ?? task.summary)}`,
    `- **Статус**: ${fmt(task.state)}`,
    `- **Приоритет**: ${fmt(task.priority)}`,
    `- **Исполнитель**: ${fmt(assignee?.fullName)}`,
    `- **Спринт**: ${fmt(sprints?.[0]?.name)}`,
    `- **Parent**: ${fmt(links?.parent)}`,
    "",
    "### Описание задачи",
    String(task.textMd ?? task.description ?? "(описание отсутствует)").slice(0, 12_000),
  ].join("\n");
}

function fmt(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function renameSession(ctx: ExtensionCommandContext, name: string): void {
  const sessionManager = ctx.sessionManager as { appendSessionInfo?: (name: string) => void };
  sessionManager.appendSessionInfo?.(name.replace(/\s+/g, " ").trim());
}

function buildReviewPrompt(input: {
  ref: MrRef;
  mr: GitLabMr | null;
  taskId: string;
  task: TaskData | null;
  baseBranch: string;
  targetBranch: string;
  mergeBase: string;
  extraInfo: string;
  relatedTasks: Array<{ id: string; task: TaskData | null }>;
}): string {
  const { ref, mr, taskId, task, baseBranch, targetBranch, mergeBase, extraInfo, relatedTasks } = input;
  return `Проведи ревью GitLab MR на русском.

Проверяй в текущем репозитории: ${path.join(REVIEWS_ROOT, ref.repo)}
MR: ${ref.url}
Source branch: ${mr?.source_branch ?? "—"}
Base branch: ${baseBranch}
Target branch: ${targetBranch}
Merge base: ${mergeBase}

## Задача
${taskSummary(taskId, task)}
${extraInfo ? `
## Дополнительная информация
${extraInfo}` : ""}
${relatedTasks.length > 0 ? `
## Связанные задачи для соотнесения
${relatedTasks.map(({ id, task }) => `### ${id}\n${taskSummary(id, task)}`).join("\n\n")}` : ""}

## Стандарт ревью
${THERMO_PROMPT}

## Что сделать
1. Выполни \`git diff ${mergeBase}..${targetBranch}\` и прочитай изменённые файлы и их потребителей. Для протокольных/API изменений проверь обе стороны.
2. Найди реальные blocker/major/minor проблемы. Не пиши косметические ниты.
3. Отдельно сверяй реализацию с описанием задачи выше; если описание не загружено — сверяй по заголовку задачи/MR.
4. Если есть связанные задачи, проверь не конфликтует ли MR с их требованиями и не упускает ли нужную связку.
5. Ответ строго в формате ниже. Не оборачивай ответ в markdown/code fences.

Проверял в \`${REVIEWS_ROOT}\`.

## Задача
- **ID**: ${taskId}
- **Суть**: 2–3 предложения

## ${ref.repo} MR !${ref.iid}

### Blocker / Major / Minor: <краткий заголовок>

- **Файл**: \`<path>:<line>\`
- **Проблема**: ...
- **Влияние**: ...
- **Предложение**: ...

## Сверка с задачей

| Пункт задачи | Статус | Комментарий |
|-------------|--------|-------------|
| ... | ✅ / ❌ / ⚠️ | ... |

Примечания: тесты не запускались / задача не скачана / etc.

Если находок нет — явно напиши, что критичных замечаний нет, но всё равно заполни сверку с задачей.`;
}
