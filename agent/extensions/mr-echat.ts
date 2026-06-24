/**
 * mr-echat — commit + push + создание MR через glab.
 *
 * Заменяет agent/prompts/mr-echat.md: все механические шаги (git, glab,
 * файловый I/O, цикл подтверждения title) выполняются детерминированно
 * в коде. LLM (через complete()) используется только для генерации
 * MR description и commit title по диффу.
 *
 * Использование:
 *   /mr-echat [commit-title]
 *
 *   commit-title — опционально: готовый заголовок коммита (без #EUTP-XXX)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { complete, type Message } from "@earendil-works/pi-ai";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EUTP_ID_RE = /EUTP-\d+/i;
const TITLE_MAX_ATTEMPTS = 3;
const MR_DESC_TMP = "/tmp/mr_description.md";

// ---------------------------------------------------------------------------
// System prompt for complete() — generates both title and description
// ---------------------------------------------------------------------------

const LLM_SYSTEM_PROMPT = `You are a commit message and MR description generator for an EChat project.
Given a git diff and an MR template, output exactly:

1. A commit title (English, lowercase, imperative mood: add/fix/make/update/remove)
2. The filled MR description (Russian)

Commit title rules:
- English, lowercase, imperative (add/fix/make/update/remove)
- Briefly describes the essence of changes
- Ends with " #EUTP-NNNNNN"
- Examples from the repo:
  add cross-app text formatting copy-paste #EUTP-145771
  fix chat closing animation on mobile #EUTP-146265
  add invitation links #EUTP-115210
  fix formatting toolbar on Android #EUTP-144804

MR description rules:
- Take the template and fill in the sections
- Replace "На что обратить внимание при ревью и тестировании" with two subsections:
  ### Краткое описание изменений — each item: one change/fix/feature, affected files/modules
  ### Что нужно проверить тестировщикам — each item: specific scenario or component to test manually
- Remove any HTML/markdown comments from the template
- Keep Russian text
- If no migrations — keep "Нет."

Output format (strict):
TITLE: <commit title>
DESC:
<filled MR description>`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/** Определить, какой diff использовать, и получить его. */
async function getDiff(exec: ExecFn): Promise<string> {
  const cached = await exec("git", ["diff", "--cached", "--name-only"]);
  const unstaged = await exec("git", ["diff", "--name-only"]);

  const hasCached = cached.stdout.trim().length > 0;
  const hasUnstaged = unstaged.stdout.trim().length > 0;

  if (hasCached) {
    const diff = await exec("git", ["diff", "--cached"]);
    return diff.stdout;
  }
  // staged пуст — анализируем всё unstaged
  const diff = await exec("git", ["diff"]);
  return diff.stdout;
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

/** Тип для exec-обёртки с фиксированным cwd. */
type ExecFn = (cmd: string, args: string[], opts?: Record<string, unknown>) => Promise<{ stdout: string; stderr?: string; code: number }>;

/** Проверить, что мы в git-репозитории. Если нет — найти дочерние и дать выбрать. */
async function ensureGitRepo(
  pi: ExtensionAPI,
  ctx: any,
): Promise<string | null> {
  const cwd = ctx.cwd || process.cwd();

  // Проверяем, является ли текущая папка git-репозиторием
  const check = await pi.exec("git", ["rev-parse", "--git-dir"], { cwd });
  if (check.code === 0) {
    return cwd;
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

/** Вызвать LLM для генерации title + description. */
async function generateText(
  ctx: any,
  taskId: string,
  diff: string,
  template: string,
): Promise<{ title: string; description: string } | null> {
  if (!ctx.model) {
    ctx.ui.notify("Нет активной модели", "error");
    return null;
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth.ok || !auth.apiKey) {
    ctx.ui.notify(`Нет API-ключа для ${ctx.model.provider}`, "error");
    return null;
  }

  let diffBlock = diff;
  // ponytail: diff без ограничения, проблема — если модель не влезает в контекст
  if (diffBlock.length > 80_000) {
    ctx.ui.notify(`Diff большой (${diffBlock.length} символов). Модель может не справиться.`, "warning");
  }

  const prompt = [
    `Task: ${taskId}`,
    `Template:`,
    template,
    `Git diff:`,
    diffBlock,
  ].join("\n\n");

  const userMessage: Message = {
    role: "user",
    content: [{ type: "text", text: prompt }],
    timestamp: Date.now(),
  };

  ctx.ui.notify("Генерирую описание MR и заголовок коммита...", "info");

  const response = await complete(
    ctx.model,
    { systemPrompt: LLM_SYSTEM_PROMPT, messages: [userMessage] },
    { apiKey: auth.apiKey, headers: auth.headers },
  );

  const text = response.content
    .filter((c: any): c is { type: "text"; text: string } => c.type === "text")
    .map((c: any) => c.text)
    .join("\n");

  // Разбор ответа
  const titleMatch = text.match(/^TITLE:\s*(.+?)$/m);
  const descMatch = text.match(/^DESC:\s*([\s\S]*)$/m);

  if (!titleMatch || !descMatch) {
    ctx.ui.notify("LLM вернул ответ не по формату. TITLE:/DESC: не найдены.", "error");
    return null;
  }

  return {
    title: titleMatch[1].trim(),
    description: descMatch[1].trim(),
  };
}

/** Цикл подтверждения commit title.
 *  Принимает уже сгенерированный первый вариант, чтобы избежать лишнего вызова complete(). */
async function confirmTitle(
  ctx: any,
  taskId: string,
  diff: string,
  template: string,
  firstTitle: string,
  previousTitle: string | null,
): Promise<string | null> {
  let title = firstTitle;
  let attempts = 1;

  while (true) {
    if (previousTitle) {
      const action = await ctx.ui.select("Заголовок коммита", [
        `Использовать предложенный: ${title}`,
        `Использовать предыдущее сообщение: ${previousTitle}`,
        "Сгенерировать другой вариант",
        "Ввести вручную",
      ]);
      if (!action) return null;
      if (action.startsWith("Использовать предложенный")) return title;
      if (action.startsWith("Использовать предыдущее")) return previousTitle;
      if (action === "Ввести вручную") {
        const manual = await ctx.ui.input("Введи название коммита (без #EUTP-XXX):");
        if (manual) return `${manual.trim()} #${taskId}`;
        return null;
      }
    } else {
      const ok = await ctx.ui.confirm("Заголовок коммита", `${title}\n\nПодходит?`);
      if (ok) return title;
    }

    if (attempts >= TITLE_MAX_ATTEMPTS) {
      const manual = await ctx.ui.input("Введи название коммита (без #EUTP-XXX):");
      if (manual) return `${manual.trim()} #${taskId}`;
      return null;
    }

    ctx.ui.notify("Генерирую другой вариант...", "info");
    const result = await generateText(ctx, taskId, diff, template);
    if (!result) return null;
    title = result.title;
    attempts++;
  }
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.registerCommand("mr-echat", {
    description: "Commit + push + создать MR через glab",
    handler: async (args, ctx) => {
      try {
        const userTitle = args.trim() || undefined;

        // 0. Определить рабочую директорию (git-репозиторий)
        const repoDir = await ensureGitRepo(pi, ctx);
        if (!repoDir) return;

        // Обёртка pi.exec с фиксированным cwd
        const exec: ExecFn = (cmd, args, opts) => pi.exec(cmd, args, { ...opts, cwd: repoDir });

        // 1. Извлечь EUTP-ID из ветки
        const branchResult = await exec("git", ["branch", "--show-current"]);
        if (branchResult.code !== 0 || !branchResult.stdout.trim()) {
          ctx.ui.notify("Не удалось определить текущую ветку", "error");
          return;
        }
        const branch = branchResult.stdout.trim();
        const taskId = extractTaskId(branch);
        if (!taskId) {
          ctx.ui.notify(`Не найден EUTP-ID в названии ветки: ${branch}`, "error");
          return;
        }

        // 2. Прочитать и подготовить MR-шаблон
        let template: string;
        try {
          template = readTemplate(repoDir, taskId);
        } catch {
          ctx.ui.notify("Не найден .gitlab/merge_request_templates/Default.md", "error");
          return;
        }

        // 3. Получить diff
        const diff = await getDiff(exec);
        if (!diff.trim()) {
          ctx.ui.notify("Нет изменений для коммита", "error");
          return;
        }

        // 4. Сгенерировать описание и title
        const result = await generateText(ctx, taskId, diff, template);
        if (!result) return;

        // Сохраняем описание в любом случае
        fs.writeFileSync(MR_DESC_TMP, result.description, "utf-8");

        // 5. Определить commit title
        let commitTitle: string;
        if (userTitle) {
          commitTitle = `${userTitle} #${taskId}`;
        } else {
          const previousTitle = await getPreviousCommitTitle(exec, taskId);
          const confirmed = await confirmTitle(ctx, taskId, diff, template, result.title, previousTitle);
          if (!confirmed) {
            ctx.ui.notify("Заголовок коммита не задан — отмена", "warning");
            return;
          }
          commitTitle = confirmed;
        }

        // 6. Commit + push
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

        const pushResult = await exec("git", ["push", "origin", "HEAD"]);
        if (pushResult.code !== 0) {
          ctx.ui.notify(`Ошибка git push: ${pushResult.stderr}`, "error");
          return;
        }
        ctx.ui.notify("Запушено ✓", "info");

        // 7. Проверить существующий MR
        const mrListResult = await exec("glab", [
          "mr", "list",
          "--source-branch", branch,
          "--output", "json",
        ]);

        if (mrListResult.code === 0 && mrListResult.stdout.trim() && mrListResult.stdout.trim() !== "[]") {
          try {
            const mrs = JSON.parse(mrListResult.stdout);
            if (Array.isArray(mrs) && mrs.length > 0 && mrs[0].web_url) {
              ctx.ui.notify(`MR уже существует: ${mrs[0].web_url}`, "info");
              return;
            }
          } catch {
            // не смогли разобрать JSON — продолжаем
          }
        }

        // 8. Создать MR
        const username = await getGlabUser(exec);
        const descContent = fs.readFileSync(MR_DESC_TMP, "utf-8");

        const mrArgs = [
          "mr", "create",
          "--title", commitTitle,
          "--description", descContent,
          "--yes",
        ];
        if (username) {
          mrArgs.push("--assignee", username);
        }

        ctx.ui.notify("Создаю MR...", "info");
        const createResult = await exec("glab", mrArgs);

        if (createResult.code !== 0) {
          ctx.ui.notify(`Ошибка glab mr create: ${createResult.stderr}`, "error");
          return;
        }

        // 9. Вывести результат
        const webUrlMatch = createResult.stdout.match(/https:\/\/gitlab\.[^\s]+/);
        if (webUrlMatch) {
          ctx.ui.notify(`MR создан: ${webUrlMatch[0]}`, "info");
        } else {
          ctx.ui.notify(`MR создан. Вывод:\n${createResult.stdout.slice(0, 500)}`, "info");
        }
      } catch (err: any) {
        ctx.ui.notify(`Ошибка mr-echat: ${err.message}`, "error");
      }
    },
  });
}
