import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";

const REVIEW_SESSION_ROOT = "/home/user/echat/reviews";
const REVIEW_JOBS_ROOT = path.join(REVIEW_SESSION_ROOT, "jobs");
const REVIEW_LOCKS_ROOT = path.join(REVIEW_SESSION_ROOT, ".locks");
const WORKSPACE_ROOT = "/home/user/echat";
const GITLAB_HOST = "https://git.esoft.tech";
const EUTP_ID_RE = /(EUTP-\d+)/i;
const MR_URL_RE = /^https:\/\/git\.esoft\.tech\/tidy\/([^/]+)\/-\/merge_requests\/(\d+)/;
const MR_URL_SCAN_RE = /https:\/\/git\.esoft\.tech\/tidy\/([^/\s]+)\/-\/merge_requests\/(\d+)/g;
const API_BASE = "https://urs.esoft.tech/api/user/youtrack/v1/issues";

type MrRef = { repo: string; iid: string; url: string };
type GitLabMr = { title?: string; description?: string; source_branch?: string; target_branch?: string; web_url?: string };
type TaskData = Record<string, unknown>;
type ReviewScope = "branch" | "working-tree" | "all";
type ReviewParams =
  | { kind: "mr"; refs: MrRef[]; explicitSession?: string; extraInfo: string; relatedTaskIds: string[] }
  | { kind: "local"; repoPaths: string[]; baseRef?: string; scope: ReviewScope; explicitSession?: string; extraInfo: string; relatedTaskIds: string[] };
type PreparedReview = {
  kind: "mr" | "local";
  repo: string;
  repoDir: string;
  taskId: string | null;
  task: TaskData | null;
  baseRef: string;
  headRef: string;
  mergeBase: string;
  sourceBranch: string;
  scope: ReviewScope;
  status: string;
  untrackedFiles: string[];
  mr?: GitLabMr | null;
  mrRef?: MrRef;
};
type ReviewWorktree = { repo: string; sourceRepoDir: string; worktreeDir: string };
type ReviewWorkspace = { root: string; worktrees: ReviewWorktree[] };
type ExecFn = (cmd: string, args: string[], opts?: Record<string, unknown>) => Promise<{ stdout: string; stderr?: string; code: number }>;

export default function (pi: ExtensionAPI) {
  let activeWorkspace: ReviewWorkspace | null = null;

  const handler = async (args: string, ctx: ExtensionCommandContext) => {
    if (!ctx.isIdle()) {
      ctx.ui.notify("Дождись завершения текущего хода агента перед /review.", "warning");
      return;
    }

    const params = args.trim() ? parseArgs(args, ctx.cwd) : await promptReviewParams(ctx);
    if (!params) return;

    if (activeWorkspace) {
      await cleanupReviewWorkspace(pi, activeWorkspace);
      activeWorkspace = null;
    }

    const session = await resolvePoraSession(ctx, params.explicitSession);
    const relatedTasks = await fetchRelatedTasks(params.relatedTaskIds, session);
    const prepared: PreparedReview[] = [];
    const errors: string[] = [];
    const workspace = params.kind === "mr" ? createReviewWorkspace() : null;

    if (params.kind === "mr") {
      for (const ref of params.refs) {
        try {
          const result = await prepareMrReview(pi, ctx, ref, session, workspace!.root);
          prepared.push(result.review);
          workspace!.worktrees.push(result.worktree);
        } catch (error: unknown) {
          errors.push(`${ref.repo} MR !${ref.iid}: ${errorMessage(error)}`);
        }
      }
    } else {
      for (const repoPath of params.repoPaths) {
        try {
          prepared.push(await prepareLocalReview(pi, ctx, repoPath, params.baseRef, params.scope, session));
        } catch (error: unknown) {
          errors.push(`${repoPath}: ${errorMessage(error)}`);
        }
      }
    }

    for (const error of errors) ctx.ui.notify(error, "error");
    if (prepared.length === 0) {
      if (workspace) await cleanupReviewWorkspace(pi, workspace);
      return;
    }

    renameSession(ctx, sessionNameForPreparedReviews(prepared));
    const reviewContext = buildReviewContext(prepared, params.extraInfo, relatedTasks);
    activeWorkspace = workspace;
    try {
      pi.sendUserMessage(`/skill:mr-review\n\n${reviewContext}`);
    } catch (error) {
      if (activeWorkspace) await cleanupReviewWorkspace(pi, activeWorkspace);
      activeWorkspace = null;
      throw error;
    }
  };

  pi.registerCommand("review", {
    description: "Review GitLab MR or local EChat branches with EUTP task context",
    handler,
  });
  pi.registerCommand("mr-review", {
    description: "Compatibility alias for /review; reviews GitLab MR links by default",
    handler,
  });

  pi.on("session_shutdown", async () => {
    if (!activeWorkspace) return;
    const workspace = activeWorkspace;
    activeWorkspace = null;
    await cleanupReviewWorkspace(pi, workspace);
  });
}

function parseArgs(raw: string, cwd: string): ReviewParams {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  if (parts[0]?.toLowerCase() === "local") return parseLocalArgs(parts.slice(1), cwd);
  if (parts[0]?.toLowerCase() === "mr") parts.shift();

  const refs = parseMrRefs(parts.join(" "));
  const explicitSession = parts.find((part) => !MR_URL_RE.test(part) && part !== "''");
  return { kind: "mr", refs, explicitSession, extraInfo: "", relatedTaskIds: [] };
}

function parseLocalArgs(parts: string[], cwd: string): ReviewParams {
  const repoPaths: string[] = [];
  let baseRef = "master";
  let explicitSession: string | undefined;
  let scope: ReviewScope = "all";

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    if (part === "--base") baseRef = parts[++index];
    else if (part.startsWith("--base=")) baseRef = part.slice("--base=".length);
    else if (part === "--scope") scope = parseScope(parts[++index]);
    else if (part.startsWith("--scope=")) scope = parseScope(part.slice("--scope=".length));
    else if (part === "--pora-session") explicitSession = parts[++index];
    else repoPaths.push(resolveRepoInput(part, cwd));
  }

  if (repoPaths.length === 0) repoPaths.push(resolveRepoInput(".", cwd));
  return { kind: "local", repoPaths, baseRef, scope, explicitSession, extraInfo: "", relatedTaskIds: [] };
}

function parseScope(value: string | undefined): ReviewScope {
  if (value === "branch" || value === "working-tree" || value === "all") return value;
  throw new Error(`Неизвестный scope ${value ?? "—"}; допустимы branch, working-tree, all`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveRepoInput(input: string, cwd: string): string {
  if (path.isAbsolute(input)) return input;
  if (input === "." || input.startsWith("./") || input.startsWith("../")) return path.resolve(cwd, input);
  return path.join(WORKSPACE_ROOT, input);
}

async function promptReviewParams(ctx: ExtensionCommandContext): Promise<ReviewParams | null> {
  if (!ctx.hasUI) {
    ctx.ui.notify("Используй /review mr <MR-URL> или /review local <repo> [--base ref] [--scope all].", "error");
    return null;
  }

  const kind = await ctx.ui.select("Что проверяем?", ["GitLab MR", "Локальные изменения"]);
  if (!kind) return null;
  if (kind === "GitLab MR") {
    const text = await ctx.ui.editor("Параметры MR review", `Ссылка на MR:\nТокен PORA:\nДополнительная информация к задаче:\nЗадачи Youtrack описание которых нужно спарсить и соотнести с задачей:\n`);
    return text ? parseStructuredMrParams(text) : null;
  }

  const candidates = discoverLocalRepos();
  const selectedRepos = await promptLocalRepoSelection(ctx, candidates);
  if (!selectedRepos) return null;
  const text = await ctx.ui.editor("Параметры local review", `Репозитории (по одному в строке):\n${selectedRepos.join("\n")}\nБазовая ветка: master\nScope (branch, working-tree, all): all\nТокен PORA:\nДополнительная информация к задаче:\nЗадачи Youtrack описание которых нужно спарсить и соотнести с задачей:\n`);
  return text ? parseStructuredLocalParams(text, ctx.cwd) : null;
}

async function promptLocalRepoSelection(ctx: ExtensionCommandContext, repoPaths: string[]): Promise<string[] | null> {
  if (repoPaths.length === 0) {
    ctx.ui.notify(`Не найдены Git-репозитории в ${WORKSPACE_ROOT}.`, "error");
    return null;
  }
  if (ctx.mode !== "tui") return [repoPaths[0]!];

  const selected = new Set<string>();
  const result = await ctx.ui.custom<string[] | null>((tui, theme, keybindings, done) => {
    const items: SettingItem[] = repoPaths.map((repoPath) => ({
      id: repoPath,
      label: path.basename(repoPath),
      description: repoPath,
      currentValue: "не выбран",
      values: ["выбран", "не выбран"],
    }));

    const container = new Container();
    container.addChild(new Text(theme.fg("accent", theme.bold("Репозитории для локального ревью")), 1, 1));
    const settingsList = new SettingsList(
      items,
      Math.min(items.length + 2, 18),
      getSettingsListTheme(),
      (id, newValue) => {
        if (newValue === "выбран") selected.add(id);
        else selected.delete(id);
      },
      () => done(null),
    );
    container.addChild(settingsList);
    container.addChild(new Text(theme.fg("dim", "Space — переключить · Enter — продолжить · Esc — отмена"), 1, 1));

    return {
      render: (width) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        if (keybindings.matches(data, "tui.select.confirm")) {
          if (selected.size === 0) {
            ctx.ui.notify("Выбери хотя бы один репозиторий.", "warning");
            return;
          }
          done([...selected]);
          return;
        }
        settingsList.handleInput(matchesKey(data, Key.space) ? " " : data);
        tui.requestRender();
      },
    };
  });
  return result ?? null;
}

function parseStructuredMrParams(text: string): ReviewParams {
  const fields = readFields(text, [
    "Ссылка на MR",
    "Токен PORA",
    "Дополнительная информация к задаче",
    "Задачи Youtrack описание которых нужно спарсить и соотнести с задачей",
  ]);
  return {
    kind: "mr",
    refs: parseMrRefs(fields["Ссылка на MR"] ?? ""),
    explicitSession: optionalField(fields["Токен PORA"]),
    extraInfo: (fields["Дополнительная информация к задаче"] ?? "").trim(),
    relatedTaskIds: extractTaskIds(fields["Задачи Youtrack описание которых нужно спарсить и соотнести с задачей"] ?? ""),
  };
}

function parseStructuredLocalParams(text: string, cwd: string): ReviewParams {
  const fields = readFields(text, [
    "Репозитории (по одному в строке)",
    "Базовая ветка",
    "Scope (branch, working-tree, all)",
    "Токен PORA",
    "Дополнительная информация к задаче",
    "Задачи Youtrack описание которых нужно спарсить и соотнести с задачей",
  ]);
  const repoPaths = (fields["Репозитории (по одному в строке)"] ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => resolveRepoInput(value, cwd));
  return {
    kind: "local",
    repoPaths,
    baseRef: optionalField(fields["Базовая ветка"]) ?? "master",
    scope: parseScope(optionalField(fields["Scope (branch, working-tree, all)"]) ?? "all"),
    explicitSession: optionalField(fields["Токен PORA"]),
    extraInfo: (fields["Дополнительная информация к задаче"] ?? "").trim(),
    relatedTaskIds: extractTaskIds(fields["Задачи Youtrack описание которых нужно спарсить и соотнести с задачей"] ?? ""),
  };
}

function discoverLocalRepos(): string[] {
  try {
    return fs.readdirSync(WORKSPACE_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== path.basename(REVIEW_SESSION_ROOT))
      .map((entry) => path.join(WORKSPACE_ROOT, entry.name))
      .filter((repoDir) => fs.existsSync(path.join(repoDir, ".git")));
  } catch {
    return [];
  }
}

function readFields(text: string, labels: string[]): Record<string, string> {
  const out: Record<string, string[]> = {};
  let current: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const label = labels.find((candidate) => line.startsWith(`${candidate}:`));
    if (label) {
      current = label;
      out[current] = [line.slice(label.length + 1).trim()];
    } else if (current) out[current]!.push(line);
  }
  return Object.fromEntries(Object.entries(out).map(([key, lines]) => [key, lines.join("\n").trim()]));
}

function optionalField(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed !== "''" ? trimmed : undefined;
}

function parseMrRefs(text: string): MrRef[] {
  return [...text.matchAll(MR_URL_SCAN_RE)].map((match) => ({ repo: match[1]!, iid: match[2]!, url: match[0] }));
}

async function prepareMrReview(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  ref: MrRef,
  poraSession: string | null,
  workspaceRoot: string,
): Promise<{ review: PreparedReview; worktree: ReviewWorktree }> {
  assertSafeRepoName(ref.repo);
  const sourceRepoDir = path.join(REVIEW_SESSION_ROOT, ref.repo);
  assertGitRepo(sourceRepoDir);
  const sourceExec: ExecFn = (cmd, args, opts) => pi.exec(cmd, args, { ...opts, cwd: sourceRepoDir });
  const mr = await fetchGitLabMr(pi, ref);
  const headRef = `refs/mr-review/${ref.repo}/${ref.iid}`;
  const baseRef = await preferredBaseBranch(pi, sourceRepoDir, mr?.target_branch);
  const worktreeDir = path.join(workspaceRoot, `${ref.repo}--mr-${ref.iid}`);
  const worktree = { repo: ref.repo, sourceRepoDir, worktreeDir };
  let worktreeAdded = false;

  try {
    await withRepoLock(ref.repo, async () => {
      await fetchMr(sourceExec, ref.iid, headRef);
      await addWorktree(sourceExec, worktreeDir, headRef);
      worktreeAdded = true;
    });

    const exec: ExecFn = (cmd, args, opts) => pi.exec(cmd, args, { ...opts, cwd: worktreeDir });
    const sourceBranch = mr?.source_branch ?? headRef;
    const mergeBase = await resolveMergeBase(exec, "HEAD", baseRef);
    const taskId = extractTaskId(sourceBranch)
      ?? extractTaskId(`${mr?.title ?? ""}\n${mr?.description ?? ""}`)
      ?? await extractTaskIdFromCommits(exec, "HEAD", baseRef);
    const task = taskId && poraSession ? await fetchTask(taskId, poraSession) : null;
    ctx.ui.notify(`Подготовил ${ref.repo}!${ref.iid}: ${sourceBranch}${taskId ? `, задача ${taskId}` : ""}`, "info");
    return {
      review: {
        kind: "mr", repo: ref.repo, repoDir: worktreeDir, taskId, task, baseRef, headRef: "HEAD", mergeBase, sourceBranch,
        scope: "branch", status: "", untrackedFiles: [], mr, mrRef: ref,
      },
      worktree,
    };
  } catch (error) {
    if (worktreeAdded || fs.existsSync(worktreeDir)) await removeWorktree(pi, worktree);
    throw error;
  }
}

async function prepareLocalReview(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  inputPath: string,
  requestedBase: string | undefined,
  scope: ReviewScope,
  poraSession: string | null,
): Promise<PreparedReview> {
  const repoDir = fs.realpathSync(inputPath);
  assertGitRepo(repoDir);
  const repo = path.basename(repoDir);
  const exec: ExecFn = (cmd, args, opts) => pi.exec(cmd, args, { ...opts, cwd: repoDir });
  const sourceBranch = (await checkedExec(exec, "git", ["branch", "--show-current"])).trim() || "DETACHED";
  const baseRef = requestedBase ?? await preferredBaseBranch(pi, repoDir);
  const headRef = "HEAD";
  const mergeBase = await resolveMergeBase(exec, headRef, baseRef);
  const taskId = extractTaskId(sourceBranch) ?? await extractTaskIdFromCommits(exec, headRef, baseRef);
  const task = taskId && poraSession ? await fetchTask(taskId, poraSession) : null;
  const status = (await checkedExec(exec, "git", ["status", "--short"])).trim();
  const untrackedFiles = scope === "branch"
    ? []
    : (await checkedExec(exec, "git", ["ls-files", "--others", "--exclude-standard"])).split(/\r?\n/).filter(Boolean);
  ctx.ui.notify(`Подготовил local ${repo}: ${sourceBranch} относительно ${baseRef}${taskId ? `, задача ${taskId}` : ""}`, "info");
  return {
    kind: "local", repo, repoDir, taskId, task, baseRef, headRef, mergeBase, sourceBranch,
    scope, status, untrackedFiles,
  };
}

function assertGitRepo(repoDir: string) {
  if (!fs.existsSync(path.join(repoDir, ".git"))) throw new Error(`Не найден Git-репозиторий: ${repoDir}`);
}

function assertSafeRepoName(repo: string) {
  if (!/^[a-zA-Z0-9._-]+$/.test(repo) || repo === "." || repo === "..") {
    throw new Error(`Недопустимое имя репозитория: ${repo}`);
  }
}

async function checkedExec(exec: ExecFn, cmd: string, args: string[]) {
  const result = await exec(cmd, args, { timeout: 10_000 });
  if (result.code !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function extractTaskId(text: string): string | null {
  const match = text.match(EUTP_ID_RE);
  return match ? match[1]!.toUpperCase() : null;
}

function extractTaskIds(text: string): string[] {
  return [...new Set([...text.matchAll(new RegExp(EUTP_ID_RE, "gi"))].map((match) => match[1]!.toUpperCase()))];
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
  } catch {}
  const glab = await pi.exec("glab", ["api", `/projects/${project}/merge_requests/${ref.iid}`], { timeout: 15_000 });
  return glab.code === 0 && glab.stdout.trim() ? parseJsonObject<GitLabMr>(glab.stdout) : null;
}

function parseJsonObject<T extends object>(text: string): T | null {
  try {
    const data = JSON.parse(text) as unknown;
    return data && typeof data === "object" && !Array.isArray(data) ? data as T : null;
  } catch {
    return null;
  }
}

async function fetchMr(exec: ExecFn, iid: string, ref: string) {
  const result = await exec("git", ["fetch", "origin", `+merge-requests/${iid}/head:${ref}`], { timeout: 60_000 });
  if (result.code !== 0) throw new Error(`git fetch MR failed: ${result.stderr || result.stdout}`);
}

async function addWorktree(exec: ExecFn, worktreeDir: string, ref: string) {
  const result = await exec("git", ["worktree", "add", "--detach", worktreeDir, ref], { timeout: 30_000 });
  if (result.code !== 0) throw new Error(`git worktree add failed: ${result.stderr || result.stdout}`);
}

function createReviewWorkspace(): ReviewWorkspace {
  fs.mkdirSync(REVIEW_JOBS_ROOT, { recursive: true });
  return { root: fs.mkdtempSync(path.join(REVIEW_JOBS_ROOT, "review-")), worktrees: [] };
}

async function cleanupReviewWorkspace(pi: ExtensionAPI, workspace: ReviewWorkspace) {
  let cleanupError: unknown;
  for (const worktree of [...workspace.worktrees].reverse()) {
    try {
      await removeWorktree(pi, worktree);
    } catch (error) {
      cleanupError ??= error;
    }
  }
  fs.rmSync(workspace.root, { recursive: true, force: true });
  if (cleanupError) throw cleanupError;
}

async function removeWorktree(pi: ExtensionAPI, worktree: ReviewWorktree) {
  try {
    await withRepoLock(worktree.repo, async () => {
      const result = await pi.exec("git", ["worktree", "remove", "--force", worktree.worktreeDir], {
        cwd: worktree.sourceRepoDir,
        timeout: 30_000,
      });
      if (result.code !== 0) fs.rmSync(worktree.worktreeDir, { recursive: true, force: true });
      await pi.exec("git", ["worktree", "prune"], { cwd: worktree.sourceRepoDir, timeout: 10_000 });
    });
  } finally {
    fs.rmSync(worktree.worktreeDir, { recursive: true, force: true });
  }
}

async function withRepoLock<T>(repo: string, operation: () => Promise<T>): Promise<T> {
  fs.mkdirSync(REVIEW_LOCKS_ROOT, { recursive: true });
  const lockDir = path.join(REVIEW_LOCKS_ROOT, `${repo}.lock`);
  const owner = `${process.pid}:${Date.now()}:${Math.random()}`;
  const deadline = Date.now() + 120_000;

  while (true) {
    try {
      fs.mkdirSync(lockDir);
      try {
        fs.writeFileSync(path.join(lockDir, "owner"), owner, "utf8");
      } catch (error) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(lockDir).mtimeMs > 60_000) fs.rmSync(lockDir, { recursive: true, force: true });
      } catch {}
      if (Date.now() >= deadline) throw new Error(`Не удалось получить Git lock для ${repo}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  const heartbeat = setInterval(() => {
    try {
      const now = new Date();
      fs.utimesSync(lockDir, now, now);
    } catch {}
  }, 10_000);

  try {
    return await operation();
  } finally {
    clearInterval(heartbeat);
    try {
      if (fs.readFileSync(path.join(lockDir, "owner"), "utf8") === owner) fs.rmSync(lockDir, { recursive: true, force: true });
    } catch {}
  }
}

async function extractTaskIdFromCommits(exec: ExecFn, headRef: string, baseRef: string): Promise<string | null> {
  const result = await exec("git", ["log", headRef, "--not", baseRef, "--format=%B"], { timeout: 10_000 });
  return result.code === 0 ? extractTaskId(result.stdout) : null;
}

async function preferredBaseBranch(pi: ExtensionAPI, cwd: string, target?: string): Promise<string> {
  const candidates = [target && `origin/${target}`, target, "origin/HEAD", "origin/master", "origin/main", "origin/stage", "origin/develop", "master", "main", "stage", "develop"].filter(Boolean) as string[];
  for (const branch of candidates) {
    const result = await pi.exec("git", ["rev-parse", "--verify", `${branch}^{commit}`], { cwd, timeout: 5_000 });
    if (result.code === 0) return branch;
  }
  throw new Error("Не найдена базовая ветка: target/master/main/stage/develop");
}

async function resolveMergeBase(exec: ExecFn, headRef: string, baseRef: string): Promise<string> {
  const result = await exec("git", ["merge-base", headRef, baseRef], { timeout: 5_000 });
  if (result.code !== 0 || !result.stdout.trim()) throw new Error(`Не найден merge-base для ${headRef} и ${baseRef}`);
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

function updateZshrc(session: string) {
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
  const res = await fetch(`${API_BASE}/${taskId}`, { headers: { Cookie: `pora-gatekeeper-session=${session}`, Accept: "application/json" } });
  return res.ok ? await res.json() as TaskData : null;
}

async function fetchRelatedTasks(taskIds: string[], session: string | null): Promise<Array<{ id: string; task: TaskData | null }>> {
  return Promise.all(taskIds.map(async (id) => {
    try { return { id, task: session ? await fetchTask(id, session) : null }; }
    catch { return { id, task: null }; }
  }));
}

function taskSummary(taskId: string | null, task: TaskData | null): string {
  if (!taskId) return "- **ID**: не найден в ветке или коммитах\n- **Данные**: ревью выполняется без сверки с YouTrack.";
  if (!task) return `- **ID**: ${taskId}\n- **Данные**: не загружены.`;
  const assignee = task.assignee as Record<string, unknown> | undefined;
  const sprints = task.sprints as Array<Record<string, unknown>> | undefined;
  const links = task.links as Record<string, unknown> | undefined;
  return [
    `- **ID**: ${fmt(task.id ?? taskId)}`, `- **Заголовок**: ${fmt(task.title ?? task.summary)}`,
    `- **Статус**: ${fmt(task.state)}`, `- **Приоритет**: ${fmt(task.priority)}`,
    `- **Исполнитель**: ${fmt(assignee?.fullName)}`, `- **Спринт**: ${fmt(sprints?.[0]?.name)}`,
    `- **Parent**: ${fmt(links?.parent)}`, "", "### Описание задачи",
    String(task.textMd ?? task.description ?? "(описание отсутствует)").slice(0, 12_000),
  ].join("\n");
}

function fmt(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function renameSession(ctx: ExtensionCommandContext, name: string) {
  const sessionManager = ctx.sessionManager as { appendSessionInfo?: (name: string) => unknown };
  sessionManager.appendSessionInfo?.(name.replace(/\s+/g, " ").trim());
}

function sessionNameForPreparedReviews(reviews: PreparedReview[]): string {
  const primary = reviews[0]!;
  const title = taskTitle(primary.task);
  const repos = reviews.map((review) => review.repo).join("+");
  const baseName = `${primary.taskId ?? primary.sourceBranch} ${repos} review`;
  return title ? `${baseName}: ${title}` : baseName;
}

function taskTitle(task: TaskData | null): string | null {
  const title = task?.title ?? task?.summary;
  return typeof title === "string" && title.trim() ? title.trim() : null;
}

function buildReviewContext(reviews: PreparedReview[], extraInfo: string, relatedTasks: Array<{ id: string; task: TaskData | null }>): string {
  const primary = reviews[0]!;
  return `# Review context

## Targets
${reviewTable(reviews)}

## Primary task
${taskSummary(primary.taskId, primary.task)}
${detectedTasksSection(reviews, primary.taskId)}${extraInfo ? `\n## Additional information\n${extraInfo}\n` : ""}${relatedTasks.length ? `\n## Related tasks\n${relatedTasks.map(({ id, task }) => `### ${id}\n${taskSummary(id, task)}`).join("\n\n")}\n` : ""}
## Repository state
${reviews.map(repositoryState).join("\n\n")}

## Diff commands
${reviews.flatMap(diffCommands).map((command) => `- \`${command}\``).join("\n")}
`;
}

function repositoryState(review: PreparedReview): string {
  const lines = [`### ${review.repo}`, `- Kind: ${review.kind}`, `- Path: \`${review.repoDir}\``, `- Branch: \`${review.sourceBranch}\``, `- Scope: ${review.scope}`];
  if (review.status) lines.push("", "```text", review.status, "```");
  if (review.untrackedFiles.length) lines.push("", "Untracked files:", ...review.untrackedFiles.map((file) => `- \`${file}\``));
  return lines.join("\n");
}

function diffCommands(review: PreparedReview): string[] {
  const prefix = `git -C ${shellQuote(review.repoDir)}`;
  const commands: string[] = [];
  if (review.scope === "branch" || review.scope === "all") commands.push(`${prefix} diff ${review.mergeBase}..${review.headRef}`);
  if (review.scope === "working-tree" || review.scope === "all") {
    commands.push(`${prefix} diff --cached`, `${prefix} diff`);
    for (const file of review.untrackedFiles) commands.push(`read ${path.join(review.repoDir, file)}`);
  }
  return commands;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function detectedTasksSection(reviews: PreparedReview[], primaryTaskId: string | null): string {
  const unique = new Map<string, TaskData | null>();
  for (const review of reviews) {
    if (review.taskId && review.taskId !== primaryTaskId && !unique.has(review.taskId)) {
      unique.set(review.taskId, review.task);
    }
  }
  if (unique.size === 0) return "";
  const summaries = [...unique.entries()].map(([taskId, task]) => `### ${taskId}\n${taskSummary(taskId, task)}`).join("\n\n");
  return `\n## Additional tasks detected from targets\n${summaries}\n`;
}

function reviewTable(reviews: PreparedReview[]): string {
  return [
    "| Kind | Repo | Path | MR | Source branch | Base | Head | Merge base | Scope |",
    "|------|------|------|----|---------------|------|------|------------|-------|",
    ...reviews.map((review) => `| ${review.kind} | ${review.repo} | \`${review.repoDir}\` | ${review.mrRef?.url ?? "—"} | ${review.sourceBranch} | ${review.baseRef} | ${review.headRef} | \`${review.mergeBase}\` | ${review.scope} |`),
  ].join("\n");
}
