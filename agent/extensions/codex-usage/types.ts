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

export type CaProfile = {
  name: string;
  accountId?: string;
  email?: string;
};

export type CaListResult = {
  profiles: CaProfile[];
  current?: string;
};

export type CaTokenResult = {
  name: string;
  credential: AuthCredential;
  accountId?: string;
  email?: string;
};

export type QuotaWindow = {
  label: "5h" | "7d";
  usedPercent: number;
  remainingPercent: number;
  resetsAt: Date;
  windowSeconds: number;
};

export type QuotaResult =
  | { success: true; windows: QuotaWindow[]; subscriptionMail?: string; fetchedAt: number }
  | { success: false; error: { kind: "config" | "http" | "timeout" | "cancelled" | "network" | "parse"; message: string }; fetchedAt: number };

export type NormalizedQuota = {
  fetchedAt: number;
  fiveHourRemaining: number;
  weeklyRemaining: number;
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
  profile: CaProfile;
  token?: CaTokenResult;
  quota?: QuotaResult;
  normalizedQuota?: NormalizedQuota;
  score?: number;
  eligible: boolean;
  reason?: string;
};

export type RotationResult =
  | { rotated: true; from?: string; to: string; reason: string; quota?: NormalizedQuota }
  | { rotated: false; reason: string; scans?: CandidateScan[] };
