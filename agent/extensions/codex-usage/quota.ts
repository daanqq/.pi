import type { AuthCredential, NormalizedQuota, QuotaResult, QuotaWindow } from "./types";

const FETCH_TIMEOUT_MS = 15_000;
const FETCH_RETRY_DELAYS_MS = [2_000, 5_000];

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

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function parseSubscriptionMail(data: any): string | undefined {
  const email = typeof data?.email === "string" ? data.email.trim() : "";
  return looksLikeEmail(email) ? email : undefined;
}

function isTimeoutReason(reason: unknown): boolean {
  return (
    (reason instanceof DOMException && reason.name === "TimeoutError") ||
    (reason instanceof Error && reason.name === "TimeoutError")
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new DOMException("Retry cancelled", "AbortError"));
      },
      { once: true },
    );
  });
}

function shouldRetryQuotaResult(result: QuotaResult): boolean {
  if (result.success) return false;
  if (result.error.kind === "network" || result.error.kind === "timeout") return true;
  if (result.error.kind !== "http") return false;
  const statusMatch = result.error.message.match(/(?:^|\b)HTTP\s+(\d{3})(?:\b|$)/i);
  const status = statusMatch ? Number(statusMatch[1]) : undefined;
  return status === 429 || (status != null && status >= 500);
}

export function parseCodexWindows(data: any): QuotaWindow[] {
  const rateLimit = data?.rate_limit ?? data?.rate_limits ?? {};
  const primary = rateLimit.primary_window ?? rateLimit.primary ?? rateLimit.five_hour_limit ?? rateLimit.five_hour;
  const secondary = rateLimit.secondary_window ?? rateLimit.secondary ?? rateLimit.weekly_limit ?? rateLimit.weekly;
  const windows: QuotaWindow[] = [];

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

export function normalizeQuota(result: QuotaResult): NormalizedQuota | undefined {
  if (!result.success) return undefined;
  const fiveWindow = result.windows.find((window) => window.label === "5h");
  const weeklyWindow = result.windows.find((window) => window.label === "7d");
  const five = fiveWindow?.remainingPercent;
  const weekly = weeklyWindow?.remainingPercent;
  if (five == null || weekly == null) return undefined;
  const fiveHourRemaining = Math.round(clampPercent(five));
  const weeklyRemaining = Math.round(clampPercent(weekly));
  return {
    fetchedAt: result.fetchedAt,
    fiveHourRemaining,
    weeklyRemaining,
    minRemaining: Math.min(fiveHourRemaining, weeklyRemaining),
    fiveHourResetsAt: fiveWindow?.resetsAt.getTime(),
    weeklyResetsAt: weeklyWindow?.resetsAt.getTime(),
  };
}

export function quotaReason(quota: NormalizedQuota): string {
  return quota.fiveHourRemaining <= quota.weeklyRemaining
    ? `5h quota ${quota.fiveHourRemaining}%`
    : `7d quota ${quota.weeklyRemaining}%`;
}

export function formatQuota(quota?: NormalizedQuota): string {
  if (!quota) return "quota unavailable";
  return `5h:${quota.fiveHourRemaining}% 7d:${quota.weeklyRemaining}%`;
}

export function formatFooterQuota(quota?: NormalizedQuota): string {
  if (!quota) return "quota unavailable";
  const fiveHourReset = quota.fiveHourResetsAt != null ? resetText(new Date(quota.fiveHourResetsAt)) : "5h";
  const weeklyReset = quota.weeklyResetsAt != null ? resetText(new Date(quota.weeklyResetsAt)) : "7d";
  return `${fiveHourReset}:${quota.fiveHourRemaining}% ${weeklyReset}:${quota.weeklyRemaining}%`;
}

export function resetText(date: Date): string {
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

export function formatQuotaCommandOutput(result: QuotaResult): string {
  if (!result.success) return `Codex subscription quota unavailable\n\n${result.error.kind}: ${result.error.message}`;
  if (result.windows.length === 0) return "Codex subscription quota unavailable\n\nNo subscription quota windows found in response.";

  const lines = result.subscriptionMail ? [`subscription mail: ${result.subscriptionMail}`, ""] : [];
  lines.push(...result.windows.flatMap((window) => [
    `${window.label} window`,
    `  remaining: ${Math.round(window.remainingPercent)}%`,
    `  resets: in ${resetText(window.resetsAt)}`,
    "",
  ]));
  return lines.join("\n").trimEnd();
}

function credentialParts(credential: AuthCredential | undefined): { access?: string; accountId?: string } {
  if (!credential) return {};
  if (credential.type === "api_key") return { access: credential.key };
  const anyCredential = credential as any;
  return {
    access: anyCredential.access ?? anyCredential.accessToken ?? anyCredential.access_token,
    accountId: anyCredential.accountId ?? anyCredential.account_id,
  };
}

async function fetchQuotaOnce(credential: AuthCredential | undefined, accountIdOverride?: string, signal?: AbortSignal): Promise<QuotaResult> {
  const fetchedAt = Date.now();
  const { access, accountId } = credentialParts(credential);
  const effectiveAccountId = accountIdOverride ?? accountId;
  if (!access) return { success: false, error: { kind: "config", message: "No Codex access token found" }, fetchedAt };
  if (!effectiveAccountId) return { success: false, error: { kind: "config", message: "No Codex account id found" }, fetchedAt };

  const signals: AbortSignal[] = [AbortSignal.timeout(FETCH_TIMEOUT_MS)];
  if (signal) signals.push(signal);
  const combined = AbortSignal.any(signals);

  try {
    const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      headers: {
        Authorization: `Bearer ${access}`,
        "ChatGPT-Account-Id": effectiveAccountId,
        Accept: "application/json",
        Origin: "https://chatgpt.com",
        Referer: "https://chatgpt.com/",
        "User-Agent": "Mozilla/5.0",
      },
      signal: combined,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const message = body || response.statusText || `HTTP ${response.status}`;
      return {
        success: false,
        error: { kind: "http", message: message.includes(`HTTP ${response.status}`) ? message : `HTTP ${response.status}: ${message}` },
        fetchedAt,
      };
    }

    const data = await response.json();
    return { success: true, windows: parseCodexWindows(data), subscriptionMail: parseSubscriptionMail(data), fetchedAt };
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
    return { success: false, error: { kind: "network", message: error instanceof Error ? error.message : "Unknown network error" }, fetchedAt };
  }
}

export async function fetchQuotaForCredential(
  credential: AuthCredential | undefined,
  accountId?: string,
  signal?: AbortSignal,
): Promise<QuotaResult> {
  let result = await fetchQuotaOnce(credential, accountId, signal);
  for (const delayMs of FETCH_RETRY_DELAYS_MS) {
    if (!shouldRetryQuotaResult(result) || signal?.aborted) break;
    await sleep(delayMs, signal).catch(() => undefined);
    if (signal?.aborted) break;
    result = await fetchQuotaOnce(credential, accountId, signal);
  }
  return result;
}
