import type { AuthCredential, NormalizedQuota, QuotaResult, QuotaWindow } from "./types";

const FETCH_TIMEOUT_MS = 15_000;
const FETCH_RETRY_DELAYS_MS = [2_000, 5_000];

function parseDateish(value: unknown): Date {
  if (typeof value === "number") return new Date(value > 10 ** 11 ? value : value * 1000);
  if (typeof value === "string") return new Date(value);
  return new Date(0);
}

function percentLeftToUsedPercent(limit: any): number | undefined {
  const remaining = limit?.percent_left ?? limit?.remaining_percent;
  if (remaining != null) {
    const value = Number(remaining);
    return Number.isFinite(value) && value >= 0 && value <= 100 ? 100 - value : undefined;
  }
  if (limit?.used_percent != null) {
    const value = Number(limit.used_percent);
    return Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;
  }
  // An object without a known percentage field is not an unused window.
  // Treating it as used_percent=0 used to produce a fabricated 100% footer.
  return undefined;
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

function parseAvailableResetCount(data: any): number | undefined {
  const value = data?.rate_limit_reset_credits?.available_count;
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? Math.floor(count) : undefined;
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

function quotaWindowLabel(window: any, fallback: QuotaWindow["label"]): QuotaWindow["label"] {
  const seconds = Number(window?.limit_window_seconds ?? 0);
  if (Number.isFinite(seconds) && seconds > 0) {
    if (seconds >= 20 * 24 * 60 * 60) return "30d";
    if (seconds >= 6 * 24 * 60 * 60) return "7d";
    return "5h";
  }

  // Free accounts may expose only a long reset time without
  // limit_window_seconds.  Classify that single window by its reset horizon so
  // it is not mislabeled as a 5h quota.
  const reset = parseDateish(window?.reset_at ?? window?.reset_time_ms).getTime();
  const diffSeconds = (reset - Date.now()) / 1000;
  if (Number.isFinite(diffSeconds) && diffSeconds > 0) {
    if (diffSeconds >= 20 * 24 * 60 * 60) return "30d";
    if (diffSeconds >= 6 * 24 * 60 * 60) return "7d";
  }
  return fallback;
}

export function parseCodexWindows(data: any): QuotaWindow[] {
  const rateLimit = data?.rate_limit ?? data?.rate_limits ?? {};
  const primary = rateLimit.primary_window ?? rateLimit.primary ?? rateLimit.five_hour_limit ?? rateLimit.five_hour;
  const secondary =
    rateLimit.secondary_window ??
    rateLimit.secondary ??
    rateLimit.weekly_limit ??
    rateLimit.weekly ??
    rateLimit.monthly_limit ??
    rateLimit.monthly ??
    rateLimit.thirty_day_limit ??
    rateLimit.thirty_day;
  const windows: QuotaWindow[] = [];

  if (primary) {
    const usedPercent = percentLeftToUsedPercent(primary);
    if (usedPercent != null) {
      const label = quotaWindowLabel(primary, "5h");
      windows.push({
        label,
        usedPercent,
        remainingPercent: clampPercent(100 - usedPercent),
        resetsAt: parseDateish(primary.reset_at ?? primary.reset_time_ms),
        windowSeconds: Number(primary.limit_window_seconds ?? (label === "30d" ? 30 * 24 * 60 * 60 : label === "7d" ? 7 * 24 * 60 * 60 : 5 * 60 * 60)),
      });
    }
  }

  if (secondary) {
    const usedPercent = percentLeftToUsedPercent(secondary);
    if (usedPercent != null) {
      const label = quotaWindowLabel(secondary, "7d");
      windows.push({
        label,
        usedPercent,
        remainingPercent: clampPercent(100 - usedPercent),
        resetsAt: parseDateish(secondary.reset_at ?? secondary.reset_time_ms),
        windowSeconds: Number(secondary.limit_window_seconds ?? (label === "30d" ? 30 : 7) * 24 * 60 * 60),
      });
    }
  }

  return windows;
}

function resetTimestamp(window: QuotaWindow | undefined): number | undefined {
  const value = window?.resetsAt.getTime();
  return value && value > 0 ? value : undefined;
}

export function normalizeQuota(result: QuotaResult): NormalizedQuota | undefined {
  if (!result.success) return undefined;
  const fiveWindow = result.windows.find((window) => window.label === "5h");
  const secondaryWindow = result.windows.find((window) => window.label === "7d" || window.label === "30d");
  const available = [fiveWindow, secondaryWindow].filter((window): window is QuotaWindow => Boolean(window));
  if (available.length === 0) return undefined;
  const fiveHourRemaining = Math.round(clampPercent((fiveWindow ?? secondaryWindow)?.remainingPercent ?? 0));
  const weeklyRemaining = Math.round(clampPercent((secondaryWindow ?? fiveWindow)?.remainingPercent ?? 0));
  const remainingValues = available.map((window) => Math.round(clampPercent(window.remainingPercent)));
  return {
    fetchedAt: result.fetchedAt,
    fiveHourRemaining,
    weeklyRemaining,
    secondaryLabel: secondaryWindow?.label ?? "7d",
    hasFiveHourWindow: Boolean(fiveWindow),
    hasSecondaryWindow: Boolean(secondaryWindow),
    minRemaining: Math.min(...remainingValues),
    fiveHourResetsAt: resetTimestamp(fiveWindow),
    weeklyResetsAt: resetTimestamp(secondaryWindow),
  };
}

export function quotaReason(quota: NormalizedQuota): string {
  if (!quota.hasFiveHourWindow) return `${quota.secondaryLabel ?? "7d"} quota ${quota.weeklyRemaining}%`;
  if (!quota.hasSecondaryWindow) return `5h quota ${quota.fiveHourRemaining}%`;
  return quota.fiveHourRemaining <= quota.weeklyRemaining
    ? `5h quota ${quota.fiveHourRemaining}%`
    : `${quota.secondaryLabel ?? "7d"} quota ${quota.weeklyRemaining}%`;
}

export function formatQuota(quota?: NormalizedQuota): string {
  if (!quota) return "quota unavailable";
  const parts: string[] = [];
  if (quota.hasFiveHourWindow ?? true) parts.push(`5h:${quota.fiveHourRemaining}%`);
  if (quota.hasSecondaryWindow ?? true) parts.push(`${quota.secondaryLabel ?? "7d"}:${quota.weeklyRemaining}%`);
  return parts.length > 0 ? parts.join(" ") : "quota unavailable";
}

export function formatFooterQuota(quota?: NormalizedQuota): string {
  if (!quota) return "quota unavailable";
  const parts: string[] = [];
  if (quota.hasFiveHourWindow ?? true) {
    const reset = quota.fiveHourResetsAt != null ? resetText(new Date(quota.fiveHourResetsAt)) : undefined;
    parts.push(reset ? `${reset}:${quota.fiveHourRemaining}%` : `${quota.fiveHourRemaining}%`);
  }
  if (quota.hasSecondaryWindow ?? true) {
    const reset = quota.weeklyResetsAt != null ? resetText(new Date(quota.weeklyResetsAt)) : undefined;
    parts.push(reset ? `${reset}:${quota.weeklyRemaining}%` : `${quota.weeklyRemaining}%`);
  }
  return parts.length > 0 ? parts.join(" ") : "quota unavailable";
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
  lines.push(`available usage resets: ${result.availableResetCount ?? "unknown"}`);
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
    return {
      success: true,
      windows: parseCodexWindows(data),
      subscriptionMail: parseSubscriptionMail(data),
      availableResetCount: parseAvailableResetCount(data),
      fetchedAt,
    };
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
