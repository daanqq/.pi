export type AuthCredential = { type: "api_key"; key: string } | ({ type: "oauth" } & Record<string, any>);

export const CODEX_PROVIDER = "openai-codex";
export const EXTENSION_ID = "codex-usage";

export type RetryAfter429Policy = "off" | "ask" | "auto";

export type RotationConfig = {
  rotateBelowPercent: number;
  eligibleAbovePercent: number;
  quotaCacheTtlMs: number;
  quotaRefreshIntervalMs: number;
  cooldownMs: number;
  lockStaleMs: number;
  statePollMs: number;
  retryAfter429: RetryAfter429Policy;
};

export type CodexProfile = {
  name: string;
  accountId?: string;
  email?: string;
};

export type ProfileListResult = {
  profiles: CodexProfile[];
  current?: string;
};

export type ProfileCredentialResult = {
  name: string;
  credential: AuthCredential;
  accountId?: string;
  email?: string;
};

export type StoredCodexProfile = {
  version: 1;
  name: string;
  provider: "openai-codex";
  credential: AuthCredential;
  accountId?: string;
  email?: string;
  savedAt: number;
  lastUsedAt?: number;
};

export type QuotaWindow = {
  label: "5h" | "7d" | "30d";
  usedPercent: number;
  remainingPercent: number;
  resetsAt: Date;
  windowSeconds: number;
};

export type QuotaResult =
  | { success: true; windows: QuotaWindow[]; subscriptionMail?: string; availableResetCount?: number; fetchedAt: number }
  | { success: false; error: { kind: "config" | "http" | "timeout" | "cancelled" | "network" | "parse"; message: string }; fetchedAt: number };

export type RateLimitResetCredit = {
  id: string;
  resetType: string;
  status: string;
  grantedAt?: string;
  expiresAt?: string;
  title?: string;
  description?: string;
};

export type RateLimitResetCredits = {
  availableCount: number;
  credits: RateLimitResetCredit[];
};

export type ConsumeResetOutcome = "reset" | "already_redeemed" | "nothing_to_reset" | "no_credit";

export type NormalizedQuota = {
  fetchedAt: number;
  fiveHourRemaining: number;
  weeklyRemaining: number;
  secondaryLabel: "7d" | "30d";
  hasFiveHourWindow?: boolean;
  hasSecondaryWindow?: boolean;
  minRemaining: number;
  fiveHourResetsAt?: number;
  weeklyResetsAt?: number;
};

export type Cooldown = {
  until: number;
  reason: string;
};

export type RotationState = {
  version: 1;
  autoEnabled: boolean;
  activeProfile?: string;
  activeAccountId?: string;
  activeEmail?: string;
  lastRotationAt?: number;
  cooldowns: Record<string, Cooldown>;
  lastQuotaByProfile: Record<string, NormalizedQuota>;
};

export type CandidateScan = {
  profile: CodexProfile;
  token?: ProfileCredentialResult;
  quota?: QuotaResult;
  normalizedQuota?: NormalizedQuota;
  score?: number;
  eligible: boolean;
  reason?: string;
};

export type RotationResult =
  | { rotated: true; from?: string; to: string; reason: string; quota?: NormalizedQuota }
  | { rotated: false; reason: string; scans?: CandidateScan[] };
