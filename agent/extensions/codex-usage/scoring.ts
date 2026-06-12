import type { CandidateScan, CodexProfile, RotationState } from "./types";

export function isInCooldown(state: RotationState, profile: string, now = Date.now()): string | undefined {
  const cooldown = state.cooldowns[profile];
  if (!cooldown) return undefined;
  if (cooldown.until <= now) return undefined;
  const seconds = Math.ceil((cooldown.until - now) / 1000);
  return `cooldown:${cooldown.reason} (${seconds}s)`;
}

export function scoreCandidate(scan: CandidateScan, eligibleAbovePercent: number): CandidateScan {
  if (!scan.quota?.success) {
    return { ...scan, eligible: false, reason: scan.quota ? scan.quota.error.message : scan.reason ?? "quota unavailable" };
  }
  if (!scan.normalizedQuota) return { ...scan, eligible: false, reason: "quota windows unavailable" };
  const score = Math.min(scan.normalizedQuota.fiveHourRemaining, scan.normalizedQuota.weeklyRemaining);
  if (score < eligibleAbovePercent) {
    return { ...scan, score, eligible: false, reason: `quota below eligible threshold (${score}%)` };
  }
  return { ...scan, score, eligible: true };
}

export function chooseBestCandidate(scans: CandidateScan[]): CandidateScan | undefined {
  return scans
    .filter((scan) => scan.eligible && typeof scan.score === "number")
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.profile.name.localeCompare(b.profile.name))[0];
}

export function profileLabel(profile?: Pick<CodexProfile, "name" | "email">): string {
  if (!profile) return "unknown";
  return profile.email ? `${profile.name} <${profile.email}>` : profile.name;
}
