import { randomUUID } from "node:crypto";
import type { AuthCredential, ConsumeResetOutcome, RateLimitResetCredit, RateLimitResetCredits } from "./types";

const BASE_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const FETCH_TIMEOUT_MS = 15_000;

function credentialParts(credential: AuthCredential | undefined): { access?: string; accountId?: string } {
  if (!credential || credential.type === "api_key") return {};
  const value = credential as any;
  return {
    access: value.access ?? value.accessToken ?? value.access_token,
    accountId: value.accountId ?? value.account_id,
  };
}

function headers(credential: AuthCredential | undefined, accountIdOverride?: string): HeadersInit {
  const { access, accountId } = credentialParts(credential);
  const effectiveAccountId = accountIdOverride ?? accountId;
  if (!access) throw new Error("Codex OAuth access token not found");
  if (!effectiveAccountId) throw new Error("Codex account id not found");
  return {
    Authorization: `Bearer ${access}`,
    "ChatGPT-Account-Id": effectiveAccountId,
    Accept: "application/json",
    Origin: "https://chatgpt.com",
    Referer: "https://chatgpt.com/",
    "User-Agent": "Mozilla/5.0",
  };
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  return AbortSignal.any(signal ? [signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)] : [AbortSignal.timeout(FETCH_TIMEOUT_MS)]);
}

async function checkedJson(response: Response): Promise<any> {
  if (response.ok) return response.json();
  const body = await response.text().catch(() => "");
  throw new Error(`HTTP ${response.status}: ${body || response.statusText}`);
}

function parseCredit(value: any): RateLimitResetCredit | undefined {
  if (!value || typeof value.id !== "string") return undefined;
  return {
    id: value.id,
    resetType: String(value.reset_type ?? "unknown"),
    status: String(value.status ?? "unknown"),
    grantedAt: typeof value.granted_at === "string" ? value.granted_at : undefined,
    expiresAt: typeof value.expires_at === "string" ? value.expires_at : undefined,
    title: typeof value.title === "string" ? value.title : undefined,
    description: typeof value.description === "string" ? value.description : undefined,
  };
}

export async function fetchResetCredits(
  credential: AuthCredential | undefined,
  accountId?: string,
  signal?: AbortSignal,
): Promise<RateLimitResetCredits> {
  const response = await fetch(BASE_URL, { headers: headers(credential, accountId), signal: requestSignal(signal) });
  const data = await checkedJson(response);
  const count = Number(data?.available_count ?? 0);
  return {
    availableCount: Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0,
    credits: Array.isArray(data?.credits) ? data.credits.flatMap((value: any) => parseCredit(value) ?? []) : [],
  };
}

export async function consumeResetCredit(
  credential: AuthCredential | undefined,
  accountId: string | undefined,
  creditId: string | undefined,
  signal?: AbortSignal,
): Promise<ConsumeResetOutcome> {
  const redeemRequestId = randomUUID();
  const response = await fetch(`${BASE_URL}/consume`, {
    method: "POST",
    headers: { ...headers(credential, accountId), "Content-Type": "application/json" },
    body: JSON.stringify({ redeem_request_id: redeemRequestId, ...(creditId ? { credit_id: creditId } : {}) }),
    signal: requestSignal(signal),
  });
  const data = await checkedJson(response);
  const code = data?.code;
  if (code === "reset" || code === "already_redeemed" || code === "nothing_to_reset" || code === "no_credit") return code;
  throw new Error(`Unexpected reset response: ${JSON.stringify(data)}`);
}
