/**
 * analyze-eutp — первичный анализ задачи EUTP по кодовой базе.
 *
 * Заменяет agent/prompts/analyze-eutp.md: шаги 1–3 (извлечение ID, загрузка
 * данных из YouTrack API, форматирование сводки) выполняются детерминированно
 * в коде. Шаги 4–5 (анализ кодовой базы и план) остаются за LLM, но получают
 * готовые структурированные данные.
 *
 * Использование:
 *   /analyze-eutp <url> [pora_session] [доп. информация]
 *
 *   url              — ссылка на задачу (urs.esoft.tech или youtrack.esoft.tech)
 *   pora_session     — опционально: кука pora-gatekeeper-session
 *                      если '', используется PORA_SESSION из окружения
 *   доп. информация   — опционально: любой текст, учитывается при анализе
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EUTP_ID_RE = /(EUTP-\d+)/i;
const API_BASE = "https://urs.esoft.tech/api/user/youtrack/v1/issues";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Вытащить EUTP-ID из ссылки. Поддерживает оба домена. */
function extractId(url: string): string | null {
  const m = url.match(EUTP_ID_RE);
  return m ? m[1].toUpperCase() : null;
}

/** Разобрать строку аргументов команды. */
function parseArgs(raw: string): {
  url: string;
  explicitSession: string | undefined;
  extra: string;
} {
  const parts = raw.trim().split(/\s+/);
  const url = parts[0] || "";

  let explicitSession: string | undefined;
  let extraStart = 1;

  if (parts.length > 1) {
    if (parts[1] === "''") {
      // Явно пустая сессия — использовать env
      extraStart = 2;
    } else {
      explicitSession = parts[1];
      extraStart = 2;
    }
  }

  const extra = parts.slice(extraStart).join(" ");
  return { url, explicitSession, extra };
}

/** Сохранить/обновить PORA_SESSION в ~/.zshrc. */
function updateZshrc(session: string): void {
  const zshrc = path.join(os.homedir(), ".zshrc");
  const escaped = session.replace(/'/g, "'\\''");
  const line = `export PORA_SESSION='${escaped}'`;

  let text = "";
  try {
    text = fs.readFileSync(zshrc, "utf-8");
  } catch {
    // файла нет — создадим
  }

  const re = /^export PORA_SESSION=.*$/m;
  if (re.test(text)) {
    text = text.replace(re, line);
  } else {
    text = text.trimEnd() + (text ? "\n" : "") + line + "\n";
  }

  fs.writeFileSync(zshrc, text, "utf-8");
}

/** Получить сессию: аргумент → env → интерактивный ввод. */
async function resolveSession(
  explicitSession: string | undefined,
  ctx: any,
): Promise<string | null> {
  if (explicitSession !== undefined) {
    process.env.PORA_SESSION = explicitSession;
    updateZshrc(explicitSession);
    return explicitSession;
  }

  if (process.env.PORA_SESSION) {
    return process.env.PORA_SESSION;
  }

  // ponytail: ctx.hasUI — проверка что интерактивный режим доступен
  if (!ctx.hasUI) {
    return null;
  }

  const input = await ctx.ui.input("Вставь куку pora-gatekeeper-session:");
  if (input) {
    process.env.PORA_SESSION = input;
    updateZshrc(input);
    return input;
  }

  return null;
}

/** Привести значение к строке для таблицы. */
function fmt(val: unknown): string {
  if (val === null || val === undefined || val === "") return "—";
  if (typeof val === "object") return JSON.stringify(val);
  return String(val);
}

/** Построить сводную таблицу из данных API. */
function buildSummary(data: Record<string, unknown>): string {
  const assignee = (data.assignee as Record<string, unknown>) ?? {};
  const sprints = (data.sprints as Array<Record<string, unknown>>) ?? [];
  const teams = (data.teams as Array<Record<string, unknown>>) ?? [];
  const links = (data.links as Record<string, unknown>) ?? {};

  const rows: [string, string][] = [
    ["ID", fmt(data.id)],
    ["Заголовок", fmt(data.title ?? data.summary)],
    ["Статус", fmt(data.state)],
    ["Исполнитель", fmt(assignee.fullName)],
    ["Приоритет", fmt(data.priority)],
    ["Слой / Класс", [data.layer, data.class].filter(Boolean).join(" / ") || "—"],
    ["Спринт", fmt(sprints[0]?.name)],
    ["Оценка / Затрачено", [data.estimation, data.spentTimeMinutes].filter(Boolean).join(" / ") || "—"],
    ["Команда", fmt(teams[0]?.name)],
    ["Тип", fmt(data.type)],
  ];

  // Ссылки — компактно
  for (const key of ["parent", "childrens", "related", "epics", "works", "stages"] as const) {
    const val = links[key];
    if (val !== undefined && val !== null && val !== "" && !(Array.isArray(val) && val.length === 0)) {
      rows.push([`links.${key}`, fmt(val)]);
    }
  }

  const maxKey = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `| ${k.padEnd(maxKey)} | ${v} |`).join("\n");
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.registerCommand("analyze-eutp", {
    description: "Анализ задачи EUTP по кодовой базе",
    handler: async (args, ctx) => {
      try {
      // 1. Разбор аргументов
      const { url, explicitSession, extra } = parseArgs(args);

      if (!url) {
        ctx.ui.notify("Укажи ссылку на задачу: /analyze-eutp <url> [session] [info]", "error");
        return;
      }

      const id = extractId(url);
      if (!id) {
        ctx.ui.notify("Не удалось извлечь EUTP-ID из ссылки. Ожидается .../issue/EUTP-XXXXX", "error");
        return;
      }

      // 2. Сессия
      const session = await resolveSession(explicitSession, ctx);

      // 3. Загрузка данных через Hub API
      let apiData: Record<string, unknown> | null = null;
      const tmpPath = `/tmp/eutp-${id}.json`;

      if (session) {
        const apiUrl = `${API_BASE}/${id}`;
        // ponytail: curl через bash -c, замена на fetch — если понадобится потоковая обработка
        const escapedSession = session.replace(/'/g, "'\\''");
        const cmd = `curl -s --compressed -H 'Cookie: pora-gatekeeper-session=${escapedSession}' -H 'Accept: application/json' '${apiUrl}'`;

        try {
          const result = await pi.exec("bash", ["-c", cmd], { timeout: 15_000 });
          if (result.code === 0 && result.stdout?.trim()) {
            fs.writeFileSync(tmpPath, result.stdout, "utf-8");
            try {
              apiData = JSON.parse(result.stdout);
            } catch {
              ctx.ui.notify("API вернул не-JSON. Результат сохранён в " + tmpPath, "warning");
            }
          } else {
            ctx.ui.notify(
              `API недоступен (code=${result.code}).${result.stderr ? " stderr: " + result.stderr.slice(0, 200) : ""}`,
              "warning",
            );
          }
        } catch (err: any) {
          ctx.ui.notify(`Ошибка curl: ${err.message}`, "warning");
        }
      } else {
        ctx.ui.notify("Нет PORA_SESSION — данные задачи не загружены. Анализ только по заголовку и доп. информации.", "warning");
      }

      // 4. Формирование сообщения для LLM
      const description = apiData?.textMd
        ? String(apiData.textMd)
        : apiData?.description
          ? String(apiData.description)
          : null;

      const summaryTable = apiData ? buildSummary(apiData) : null;

      // Собираем части сообщения
      const parts: string[] = [];

      // Заголовок
      const title = apiData?.title ? String(apiData.title) : id;
      parts.push(`## Задача ${id}: ${title}`);

      // Сводка
      if (summaryTable) {
        parts.push("", "### Сводка", "", summaryTable);
      } else {
        parts.push("", "### Сводка", "", `Данные API не получены. Ссылка: ${url}`);
      }

      // Описание
      if (description) {
        parts.push("", "### Описание", "", description);
      } else if (!apiData) {
        parts.push("", "### Описание", "", "(не удалось загрузить — нет PORA_SESSION)");
      } else {
        parts.push("", "### Описание", "", "(описание отсутствует)");
      }

      // Дополнительная информация
      if (extra) {
        parts.push("", "### Дополнительная информация пользователя", "", extra);
      }

      // Инструкция для LLM
      parts.push(
        "",
        "---",
        "",
        "### Инструкция",
        "",
        "Выполни **первичный анализ** задачи по кодовой базе. Это НЕ реализация — только сбор информации и план.",
        "",
        "**Шаг 4 — Проанализируй кодовую базу:**",
        "1. Выдели ключевые термины из описания (русские и английские): названия фич, типов сообщений, форматов, API-методов, компонентов.",
        "2. Найди файлы через `grep`/`ffgrep` по этим терминам. **Минимум 3 поисковых запроса** разными словами.",
        "3. Прочитай 3–5 наиболее релевантных файлов (заголовки экспортов, сигнатуры, ключевую логику).",
        "4. Найди аналогичные реализации — если задача похожа на уже существующую фичу, покажи где и как сделано.",
        "",
        "**Шаг 5 — Выдай результат строго по шаблону:**",
        "",
        "```md",
        "## Понимание задачи",
        "(2–3 предложения своими словами, с учётом доп. информации если она есть)",
        "",
        "## Затронутые файлы",
        "- `path/to/file.ts` — почему затронут",
        "- ...",
        "",
        "## Похожие реализации",
        "- `path/to/similar.ts` — что можно переиспользовать",
        "",
        "## Предварительный план изменений",
        "1. ...",
        "2. ...",
        "",
        "## Риски и вопросы",
        "- ...",
        "```",
        "",
        "**Не пиши код. Не вноси изменения. Только анализ и план.**",
      );

      const message = parts.join("\n");

      // 5. Отправка
      if (!ctx.isIdle()) {
        ctx.ui.notify("Агент занят, дождись завершения текущего хода", "warning");
        return;
      }

      pi.sendUserMessage(message);
      } catch (err: any) {
        ctx.ui.notify(`Ошибка analyze-eutp: ${err.message}`, "error");
      }
    },
  });
}
