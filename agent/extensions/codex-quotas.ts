import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

type CodexWindow = {
  label: "5h" | "7d";
  usedPercent: number;
  remainingPercent: number;
  resetsAt: Date;
  windowSeconds: number;
};

type CodexQuotaResult =
  | { success: true; windows: CodexWindow[]; fetchedAt: number }
  | { success: false; error: { kind: "config" | "http" | "timeout" | "cancelled" | "network"; message: string }; fetchedAt: number };

const EXTENSION_ID = "codex-quotas";
const REFRESH_INTERVAL_MS = 60_000;
const FETCH_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 60_000;
const CODEX_PROVIDER = "openai-codex";

let cache: { result?: CodexQuotaResult; fetchedAt?: number; inFlight?: Promise<CodexQuotaResult> } = {};

function isCodexContext(ctx: ExtensionContext | ExtensionCommandContext): boolean {
  return ctx.model?.provider === CODEX_PROVIDER;
}

async function getCodexAccessToken(ctx: ExtensionContext | ExtensionCommandContext): Promise<string | undefined> {
  return ctx.modelRegistry.authStorage.getApiKey(CODEX_PROVIDER);
}

function getCodexAccountId(ctx: ExtensionContext | ExtensionCommandContext): string | undefined {
  const credential = ctx.modelRegistry.authStorage.get(CODEX_PROVIDER) as any;
  if (typeof credential?.accountId === "string" && credential.accountId.length > 0) return credential.accountId;

  try {
    const authPath = join(homedir(), ".codex", "auth.json");
    const data = JSON.parse(readFileSync(authPath, "utf8")) as any;
    return data?.tokens?.account_id ?? data?.tokens?.accountId;
  } catch {
    return undefined;
  }
}

function isTimeoutReason(reason: unknown): boolean {
  return (
    (reason instanceof DOMException && reason.name === "TimeoutError") ||
    (reason instanceof Error && reason.name === "TimeoutError")
  );
}

function parseDateish(value: unknown): Date {
  if (typeof value === "number") return new Date(value > 10 ** 11 ? value : value * 1000);
  if (typeof value === "string") return new Date(value);
  return new Date(0);
}

function percentLeftToUsedPercent(limit: any): number {
  if (limit?.percent_left != null) return Math.max(0, 100 - Number(limit.percent_left));
  if (limit?.remaining_percent != null) return Math.max(0, 100 - Number(limit.remaining_percent));
  if (limit?.used_percent != null) return Number(limit.used_percent);
  return 0;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function parseCodexWindows(data: any): CodexWindow[] {
  const rateLimit = data?.rate_limit ?? data?.rate_limits ?? {};
  const primary = rateLimit.primary_window ?? rateLimit.primary ?? rateLimit.five_hour_limit ?? rateLimit.five_hour;
  const secondary = rateLimit.secondary_window ?? rateLimit.secondary ?? rateLimit.weekly_limit ?? rateLimit.weekly;
  const windows: CodexWindow[] = [];

  if (primary) {
    const usedPercent = clampPercent(percentLeftToUsedPercent(primary));
    windows.push({
      label: "5h",
      usedPercent,
      remainingPercent: clampPercent(100 - usedPercent),
      resetsAt: parseDateish(primary.reset_at ?? primary.reset_time_ms),
      windowSeconds: Number(primary.limit_window_seconds ?? 5 * 60 * 60),
    });
  }

  if (secondary) {
    const usedPercent = clampPercent(percentLeftToUsedPercent(secondary));
    windows.push({
      label: "7d",
      usedPercent,
      remainingPercent: clampPercent(100 - usedPercent),
      resetsAt: parseDateish(secondary.reset_at ?? secondary.reset_time_ms),
      windowSeconds: Number(secondary.limit_window_seconds ?? 7 * 24 * 60 * 60),
    });
  }

  return windows;
}

async function fetchCodexQuotaRaw(
  accessToken: string | undefined,
  accountId: string | undefined,
  signal?: AbortSignal,
): Promise<CodexQuotaResult> {
  const fetchedAt = Date.now();
  if (!accessToken) return { success: false, error: { kind: "config", message: "No Codex access token found" }, fetchedAt };
  if (!accountId) return { success: false, error: { kind: "config", message: "No Codex account id found" }, fetchedAt };

  const signals: AbortSignal[] = [AbortSignal.timeout(FETCH_TIMEOUT_MS)];
  if (signal) signals.push(signal);
  const combined = AbortSignal.any(signals);

  try {
    const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "ChatGPT-Account-Id": accountId,
        Accept: "application/json",
        Origin: "https://chatgpt.com",
        Referer: "https://chatgpt.com/",
        "User-Agent": "Mozilla/5.0",
      },
      signal: combined,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return {
        success: false,
        error: { kind: "http", message: body || response.statusText || `HTTP ${response.status}` },
        fetchedAt,
      };
    }

    const data = await response.json();
    return { success: true, windows: parseCodexWindows(data), fetchedAt };
  } catch (error) {
    const isAbort = combined.aborted || (error instanceof DOMException && error.name === "AbortError");
    if (isAbort) {
      return {
        success: false,
        error: {
          kind: isTimeoutReason(combined.reason) ? "timeout" : "cancelled",
          message: isTimeoutReason(combined.reason) ? "Request timed out" : "Request cancelled",
        },
        fetchedAt,
      };
    }
    return {
      success: false,
      error: { kind: "network", message: error instanceof Error ? error.message : "Unknown network error" },
      fetchedAt,
    };
  }
}

async function fetchCodexQuota(
  ctx: ExtensionContext | ExtensionCommandContext,
  options?: { force?: boolean; signal?: AbortSignal },
): Promise<CodexQuotaResult> {
  const now = Date.now();
  if (!options?.force && cache.result && cache.fetchedAt && now - cache.fetchedAt < CACHE_TTL_MS) return cache.result;
  if (!options?.force && cache.inFlight) return cache.inFlight;

  const promise = fetchCodexQuotaRaw(await getCodexAccessToken(ctx), getCodexAccountId(ctx), options?.signal)
    .then((result) => {
      cache = { result, fetchedAt: Date.now() };
      return result;
    })
    .finally(() => {
      delete cache.inFlight;
    });

  cache = { ...cache, inFlight: promise };
  return promise;
}

function resetText(date: Date): string {
  const diffMs = date.getTime() - Date.now();
  if (!Number.isFinite(diffMs) || date.getTime() <= 0) return "unknown";
  if (diffMs <= 0) return "now";
  const minutes = Math.ceil(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes > 0 ? `${hours}h${restMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours > 0 ? `${days}d${restHours}h` : `${days}d`;
}

function quotaColor(remainingPercent: number): "dim" | "success" | "warning" | "error" {
  if (remainingPercent < 15) return "error";
  if (remainingPercent < 40) return "warning";
  return "success";
}

function formatFooterStatus(ctx: Pick<ExtensionContext, "ui">, result: CodexQuotaResult): string {
  const theme = ctx.ui.theme;
  if (!result.success) return theme.fg("warning", "codex quota unavailable");
  if (result.windows.length === 0) return theme.fg("warning", "codex quota unavailable");

  const windows = result.windows.map((window) => {
    const color = quotaColor(window.remainingPercent);
    const left = theme.fg(color, `${resetText(window.resetsAt)}:`);
    const value = theme.fg(color, `${Math.round(window.remainingPercent)}%`);
    return `${left}${value}`;
  });

  return windows.join(" ");
}

function formatCommandOutput(result: CodexQuotaResult): string {
  if (!result.success) return `Codex subscription quota unavailable\n\n${result.error.kind}: ${result.error.message}`;
  if (result.windows.length === 0) return "Codex subscription quota unavailable\n\nNo subscription quota windows found in response.";

  return [
    "Codex subscription quota",
    "",
    ...result.windows.flatMap((window) => [
      `${window.label} window`,
      `  remaining: ${Math.round(window.remainingPercent)}%`,
      `  used: ${Math.round(window.usedPercent)}%`,
      `  resets: in ${resetText(window.resetsAt)}`,
      "",
    ]),
  ].join("\n").trimEnd();
}

function createRefresher() {
  let timer: ReturnType<typeof setInterval> | undefined;
  let activeContext: ExtensionContext | undefined;
  let inFlight = false;
  let queued = false;

  async function update(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI) return;
    if (!isCodexContext(ctx)) {
      ctx.ui.setStatus(EXTENSION_ID, undefined);
      return;
    }
    if (inFlight) {
      queued = true;
      return;
    }

    inFlight = true;
    try {
      const result = await fetchCodexQuota(ctx);
      ctx.ui.setStatus(EXTENSION_ID, formatFooterStatus(ctx, result));
    } catch {
      ctx.ui.setStatus(EXTENSION_ID, ctx.ui.theme.fg("warning", "codex quota unavailable"));
    } finally {
      inFlight = false;
      if (queued) {
        queued = false;
        void update(ctx);
      }
    }
  }

  return {
    start(ctx: ExtensionContext): void {
      activeContext = ctx;
      if (timer) clearInterval(timer);
      timer = setInterval(() => {
        if (activeContext) void update(activeContext);
      }, REFRESH_INTERVAL_MS);
      timer.unref?.();
      void update(ctx);
    },
    refresh(ctx: ExtensionContext): void {
      activeContext = ctx;
      void update(ctx);
    },
    stop(ctx?: ExtensionContext): void {
      if (timer) clearInterval(timer);
      timer = undefined;
      activeContext = undefined;
      ctx?.ui.setStatus(EXTENSION_ID, undefined);
    },
  };
}

export default function (pi: ExtensionAPI) {
  const refresher = createRefresher();

  pi.registerCommand("codex:quotas", {
    description: "Show Codex subscription quota",
    handler: async (_args, ctx) => {
      const result = await fetchCodexQuota(ctx, { force: true });
      ctx.ui.notify(ctx.ui.theme.fg("text", formatCommandOutput(result)), result.success ? "info" : "warning");
      if (ctx.hasUI && isCodexContext(ctx)) ctx.ui.setStatus(EXTENSION_ID, formatFooterStatus(ctx, result));
    },
  });

  pi.on("session_start", (_event, ctx) => {
    refresher.start(ctx);
  });

  pi.on("turn_end", (_event, ctx) => {
    refresher.refresh(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    refresher.refresh(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    refresher.stop(ctx);
  });
}
