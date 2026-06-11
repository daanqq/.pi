import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { caList, caRestore, caToken } from "./ca";
import { withRotationLock } from "./lock";
import { fetchQuotaForCredential, formatFooterQuota, formatQuota, formatQuotaCommandOutput, normalizeQuota, quotaReason } from "./quota";
import { chooseBestCandidate, isInCooldown, profileLabel, scoreCandidate } from "./scoring";
import { pruneCooldowns, readState, updateState, watchState, writeState } from "./state";
import type { CandidateScan, CaProfile, NormalizedQuota, RotationConfig, RotationResult, RotationState } from "./types";
import { CODEX_PROVIDER, EXTENSION_ID } from "./types";

const CONFIG: RotationConfig = {
  rotateBelowPercent: 5,
  eligibleAbovePercent: 10,
  quotaCacheTtlMs: 60_000,
  quotaRefreshIntervalMs: 60_000,
  cooldownMs: 10 * 60_000,
  lockStaleMs: 60_000,
  statePollMs: 2_000,
  retryAfter429: "ask",
};

let quotaCache: { key: string; quota: NormalizedQuota; fetchedAt: number } | undefined;
let quotaFetchInFlight: { key: string; promise: Promise<NormalizedQuota | undefined> } | undefined;
let quotaRefreshTimer: ReturnType<typeof setInterval> | undefined;
let quotaRefreshGeneration = 0;
let quotaRefreshInFlight = false;
let quotaRefreshQueued = false;
let stopWatcher: (() => void) | undefined;
let activeContext: ExtensionContext | undefined;
let lastSeenActiveProfile: string | undefined;
let providerInFlight = false;

function isStaleContextError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("extension ctx is stale");
}

function safeSignal(ctx: ExtensionContext | ExtensionCommandContext): AbortSignal | undefined {
  try {
    return ctx.signal;
  } catch (error) {
    if (isStaleContextError(error)) return undefined;
    throw error;
  }
}

function isActiveEventContext(ctx: ExtensionContext | ExtensionCommandContext): boolean {
  return ctx === activeContext;
}

function isCodexContext(ctx: ExtensionContext | ExtensionCommandContext): boolean {
  try {
    return ctx.model?.provider === CODEX_PROVIDER;
  } catch (error) {
    if (isStaleContextError(error)) return false;
    throw error;
  }
}

function getCurrentCredential(ctx: ExtensionContext | ExtensionCommandContext): any {
  return ctx.modelRegistry.authStorage.get(CODEX_PROVIDER);
}

function getFallbackCodexAccountId(): string | undefined {
  try {
    const authPath = join(homedir(), ".codex", "auth.json");
    const data = JSON.parse(readFileSync(authPath, "utf8")) as any;
    return data?.tokens?.account_id ?? data?.tokens?.accountId;
  } catch {
    return undefined;
  }
}

function getCurrentAccountId(ctx: ExtensionContext | ExtensionCommandContext): string | undefined {
  const credential = getCurrentCredential(ctx);
  return credential?.accountId ?? credential?.account_id ?? getFallbackCodexAccountId();
}

function cacheKeyForCredential(credential: any): string {
  return `${credential?.type ?? "none"}:${credential?.accountId ?? credential?.account_id ?? ""}:${credential?.access ?? credential?.key ?? ""}`;
}

async function fetchCurrentQuotaResult(ctx: ExtensionContext | ExtensionCommandContext) {
  return fetchQuotaForCredential(getCurrentCredential(ctx), getCurrentAccountId(ctx), safeSignal(ctx));
}

async function fetchCurrentQuota(ctx: ExtensionContext | ExtensionCommandContext, force = false): Promise<NormalizedQuota | undefined> {
  const credential = getCurrentCredential(ctx);
  const key = `${cacheKeyForCredential(credential)}:${getCurrentAccountId(ctx) ?? ""}`;
  if (!force && quotaCache?.key === key && Date.now() - quotaCache.fetchedAt < CONFIG.quotaCacheTtlMs) return quotaCache.quota;
  if (quotaFetchInFlight?.key === key) return quotaFetchInFlight.promise;

  const promise = (async () => {
    const result = await fetchCurrentQuotaResult(ctx);
    const quota = normalizeQuota(result);
    if (quota) quotaCache = { key, quota, fetchedAt: Date.now() };
    return quota;
  })().finally(() => {
    if (quotaFetchInFlight?.key === key && quotaFetchInFlight.promise === promise) quotaFetchInFlight = undefined;
  });

  quotaFetchInFlight = { key, promise };
  return promise;
}

function stateProfileForCurrent(state: RotationState, caCurrent?: string): string | undefined {
  return state.activeProfile ?? caCurrent;
}

function setFooter(ctx: ExtensionContext | ExtensionCommandContext, state = readState(), quota?: NormalizedQuota): void {
  try {
    if (!ctx.hasUI) return;
    if (!isCodexContext(ctx)) {
      ctx.ui.setStatus(EXTENSION_ID, undefined);
      return;
    }
    const profile = state.activeProfile ?? "?";
    const knownQuota = quota ?? (profile !== "?" ? state.lastQuotaByProfile[profile] : undefined);
    const low = knownQuota && knownQuota.minRemaining <= CONFIG.rotateBelowPercent ? " low" : "";
    const text = `${profile}${low} ${formatFooterQuota(knownQuota)}`;
    ctx.ui.setStatus(EXTENSION_ID, low ? ctx.ui.theme.fg("warning", text) : text);
  } catch (error) {
    if (!isStaleContextError(error)) throw error;
  }
}

function notify(ctx: ExtensionContext | ExtensionCommandContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  try {
    ctx.ui.notify(message, level);
  } catch {
    // Non-UI/teardown contexts may reject notifications.
  }
}

function audit(pi: ExtensionAPI, type: string, data: Record<string, unknown>): void {
  try {
    pi.appendEntry(type, { ...data, at: Date.now() });
  } catch {
    // Audit must not break the request path.
  }
}

async function scanCandidates(pi: ExtensionAPI, state: RotationState, skipProfile?: string, signal?: AbortSignal): Promise<CandidateScan[]> {
  const list = await caList(pi, signal);
  const now = Date.now();
  pruneCooldowns(state, now);

  const scans = await Promise.all(
    list.profiles.map(async (profile): Promise<CandidateScan> => {
      if (profile.name === skipProfile) return { profile, eligible: false, reason: "current profile" };
      const cooldown = isInCooldown(state, profile.name, now);
      if (cooldown) return { profile, eligible: false, reason: cooldown };

      try {
        if (signal?.aborted) return { profile, eligible: false, reason: "aborted" };
        const token = await caToken(pi, profile.name, signal);
        const quota = await fetchQuotaForCredential(token.credential, token.accountId ?? profile.accountId, signal);
        const normalizedQuota = normalizeQuota(quota);
        if (normalizedQuota) state.lastQuotaByProfile[profile.name] = normalizedQuota;
        return scoreCandidate({ profile, token, quota, normalizedQuota, eligible: false }, CONFIG.eligibleAbovePercent);
      } catch (error) {
        state.cooldowns[profile.name] = { until: Date.now() + CONFIG.cooldownMs, reason: "auth_error" };
        return { profile, eligible: false, reason: error instanceof Error ? error.message : String(error) };
      }
    }),
  );

  writeState(state);
  return scans;
}

async function commitRotation(
  pi: ExtensionAPI,
  ctx: ExtensionContext | ExtensionCommandContext,
  state: RotationState,
  winner: CandidateScan,
  from: string | undefined,
  reason: string,
): Promise<RotationResult> {
  if (!winner.token) return { rotated: false, reason: "winner has no token" };

  try {
    ctx.modelRegistry.authStorage.set(CODEX_PROVIDER, winner.token.credential);
  } catch {
    await caRestore(pi, winner.profile.name, safeSignal(ctx));
    ctx.modelRegistry.authStorage.reload();
  }

  state.activeProfile = winner.profile.name;
  state.activeAccountId = winner.token.accountId ?? winner.profile.accountId;
  state.activeEmail = winner.token.email ?? winner.profile.email;
  state.lastRotationAt = Date.now();
  if (winner.normalizedQuota) state.lastQuotaByProfile[winner.profile.name] = winner.normalizedQuota;
  writeState(state);
  quotaCache = undefined;

  const result: RotationResult = { rotated: true, from, to: winner.profile.name, reason, quota: winner.normalizedQuota };
  audit(pi, "codex-usage", { from, to: winner.profile.name, reason, quota: winner.normalizedQuota });
  notify(ctx, `Codex auth rotated: ${from ?? "unknown"} -> ${winner.profile.name}; reason: ${reason}`, "info");
  setFooter(ctx, state, winner.normalizedQuota);
  return result;
}

async function rotateToBest(
  pi: ExtensionAPI,
  ctx: ExtensionContext | ExtensionCommandContext,
  reason: string,
  options: { force?: boolean; skipProfile?: string } = {},
): Promise<RotationResult> {
  if (providerInFlight && !options.force) return { rotated: false, reason: "provider request in flight" };

  return withRotationLock(CONFIG.lockStaleMs, async () => {
    const state = readState();
    pruneCooldowns(state);
    const signal = safeSignal(ctx);
    const list = await caList(pi, signal).catch(() => ({ profiles: [] as CaProfile[], current: undefined }));
    const from = stateProfileForCurrent(state, list.current);
    const skipProfile = options.skipProfile ?? from;
    const scans = await scanCandidates(pi, state, skipProfile, signal);
    const winner = chooseBestCandidate(scans);
    if (!winner) {
      writeState(state);
      audit(pi, "codex-usage-skip", { from, reason, detail: "no eligible profiles", scans: summarizeScans(scans) });
      return { rotated: false, reason: "no eligible profiles", scans };
    }
    return commitRotation(pi, ctx, state, winner, from, reason);
  });
}

async function rotateToProfile(pi: ExtensionAPI, ctx: ExtensionCommandContext, profile: string): Promise<RotationResult> {
  await ctx.waitForIdle();
  return withRotationLock(CONFIG.lockStaleMs, async () => {
    const state = readState();
    pruneCooldowns(state);
    const signal = safeSignal(ctx);
    const list = await caList(pi, signal);
    const from = stateProfileForCurrent(state, list.current);
    const profileInfo = list.profiles.find((candidate) => candidate.name === profile) ?? { name: profile };
    const token = await caToken(pi, profile, signal);
    const quotaResult = await fetchQuotaForCredential(token.credential, token.accountId ?? profileInfo.accountId, signal);
    const normalizedQuota = normalizeQuota(quotaResult);
    if (!quotaResult.success || !normalizedQuota) throw new Error(`Cannot switch to ${profile}: quota unavailable`);
    const scan: CandidateScan = { profile: profileInfo, token, quota: quotaResult, normalizedQuota, score: normalizedQuota.minRemaining, eligible: true };
    return commitRotation(pi, ctx, state, scan, from, "manual_profile_switch");
  });
}

async function maybeEnsureActiveProfile(pi: ExtensionAPI): Promise<RotationState> {
  const state = readState();
  if (state.activeProfile) return state;
  try {
    const list = await caList(pi);
    if (list.current) {
      const profile = list.profiles.find((candidate) => candidate.name === list.current);
      state.activeProfile = list.current;
      state.activeAccountId = profile?.accountId;
      state.activeEmail = profile?.email;
      writeState(state);
    }
  } catch {
    // ca may be unavailable; state will remain unknown.
  }
  return state;
}

async function maybeRotateForQuota(pi: ExtensionAPI, ctx: ExtensionContext | ExtensionCommandContext, hook: string): Promise<void> {
  if (!isActiveEventContext(ctx) || !isCodexContext(ctx)) return;
  if (safeSignal(ctx)?.aborted) return;
  const state = await maybeEnsureActiveProfile(pi);
  if (!isActiveEventContext(ctx) || safeSignal(ctx)?.aborted) return;
  const quota = await fetchCurrentQuota(ctx, true);
  if (!isActiveEventContext(ctx) || safeSignal(ctx)?.aborted) return;
  if (!quota) {
    // Request cancellation aborts the nested quota fetch too. Do not show a
    // scary rotation warning for an intentional Esc/Ctrl+C abort.
    if (!safeSignal(ctx)?.aborted) {
      if (state.autoEnabled) notify(ctx, "Codex quota unavailable; not rotating blindly", "warning");
      setFooter(ctx, state);
    }
    return;
  }

  if (state.activeProfile) {
    state.lastQuotaByProfile[state.activeProfile] = quota;
    writeState(state);
  }
  setFooter(ctx, state, quota);

  if (!state.autoEnabled) return;

  if (quota.minRemaining <= CONFIG.rotateBelowPercent) {
    try {
      const result = await rotateToBest(pi, ctx, `${hook}: ${quotaReason(quota)}`);
      if (!result.rotated) notify(ctx, `Codex quota low (${formatQuota(quota)}), but ${result.reason}; keeping current profile`, "warning");
    } catch (error) {
      notify(ctx, `Codex quota low (${formatQuota(quota)}), but rotation failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  }
}

async function maybeRotateForQuotaSafely(pi: ExtensionAPI, ctx: ExtensionContext | ExtensionCommandContext, hook: string): Promise<void> {
  try {
    await maybeRotateForQuota(pi, ctx, hook);
  } catch (error) {
    // Async fire-and-forget quota checks can outlive /resume, /fork, /new, or
    // /reload.  Pi correctly marks their captured ctx/pi as stale; treat that
    // as cancellation instead of crashing the process.
    if (isStaleContextError(error) || safeSignal(ctx)?.aborted) return;
    notify(ctx, `Codex quota check failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
  }
}

async function refreshFooterQuota(pi: ExtensionAPI, ctx: ExtensionContext, generation = quotaRefreshGeneration): Promise<void> {
  if (!ctx.hasUI) return;
  if (!isCodexContext(ctx)) {
    setFooter(ctx, readState());
    return;
  }
  if (quotaRefreshInFlight) {
    quotaRefreshQueued = true;
    return;
  }

  quotaRefreshInFlight = true;
  try {
    const state = await maybeEnsureActiveProfile(pi);
    if (generation !== quotaRefreshGeneration || !isActiveEventContext(ctx) || safeSignal(ctx)?.aborted) return;

    const quota = await fetchCurrentQuota(ctx, true);
    if (generation !== quotaRefreshGeneration || !isActiveEventContext(ctx) || safeSignal(ctx)?.aborted) return;

    if (quota && state.activeProfile) {
      state.lastQuotaByProfile[state.activeProfile] = quota;
      writeState(state);
    }
    setFooter(ctx, state, quota);
  } catch (error) {
    if (isStaleContextError(error) || safeSignal(ctx)?.aborted) return;
    setFooter(ctx, readState());
  } finally {
    quotaRefreshInFlight = false;
    if (quotaRefreshQueued && generation === quotaRefreshGeneration && isActiveEventContext(ctx)) {
      quotaRefreshQueued = false;
      void refreshFooterQuota(pi, ctx, generation);
    } else {
      quotaRefreshQueued = false;
    }
  }
}

function startQuotaRefresh(pi: ExtensionAPI, ctx: ExtensionContext): void {
  if (quotaRefreshTimer) clearInterval(quotaRefreshTimer);
  quotaRefreshGeneration += 1;
  if (!ctx.hasUI) return;
  const generation = quotaRefreshGeneration;
  quotaRefreshTimer = setInterval(() => {
    if (isActiveEventContext(ctx)) void refreshFooterQuota(pi, ctx, generation);
  }, CONFIG.quotaRefreshIntervalMs);
  quotaRefreshTimer.unref?.();
  void refreshFooterQuota(pi, ctx, generation);
}

function stopQuotaRefresh(): void {
  quotaRefreshGeneration += 1;
  if (quotaRefreshTimer) clearInterval(quotaRefreshTimer);
  quotaRefreshTimer = undefined;
  quotaRefreshQueued = false;
  quotaFetchInFlight = undefined;
}

function summarizeScans(scans: CandidateScan[]): unknown[] {
  return scans.map((scan) => ({
    profile: scan.profile.name,
    email: scan.profile.email,
    eligible: scan.eligible,
    score: scan.score,
    quota: scan.normalizedQuota,
    reason: scan.reason,
  }));
}

function formatScans(scans: CandidateScan[]): string {
  if (scans.length === 0) return "No ca profiles found.";
  return scans
    .map((scan) => {
      const status = scan.eligible ? `eligible score=${scan.score}` : `skip ${scan.reason ?? "not eligible"}`;
      return `${profileLabel(scan.profile)} — ${formatQuota(scan.normalizedQuota)} — ${status}`;
    })
    .join("\n");
}

async function commandStatus(ctx: ExtensionCommandContext): Promise<string> {
  const state = readState();
  const quota = isCodexContext(ctx) ? await fetchCurrentQuota(ctx, true) : undefined;
  if (state.activeProfile && quota) {
    state.lastQuotaByProfile[state.activeProfile] = quota;
    writeState(state);
  }
  const cooldowns = Object.entries(state.cooldowns)
    .filter(([, cooldown]) => cooldown.until > Date.now())
    .map(([profile, cooldown]) => `  ${profile}: ${cooldown.reason}, until ${new Date(cooldown.until).toLocaleString()}`);
  return [
    `autoEnabled: ${state.autoEnabled}`,
    `activeProfile: ${state.activeProfile ?? "unknown"}`,
    `activeAccountId: ${state.activeAccountId ?? "unknown"}`,
    `activeEmail: ${state.activeEmail ?? "unknown"}`,
    `current quota: ${formatQuota(quota ?? (state.activeProfile ? state.lastQuotaByProfile[state.activeProfile] : undefined))}`,
    `cooldowns:${cooldowns.length ? `\n${cooldowns.join("\n")}` : " none"}`,
  ].join("\n");
}

function startCrossProcessSync(ctx: ExtensionContext): void {
  stopWatcher?.();
  activeContext = ctx;
  lastSeenActiveProfile = readState().activeProfile;
  stopWatcher = watchState(() => {
    const state = readState();
    if (state.activeProfile !== lastSeenActiveProfile) {
      lastSeenActiveProfile = state.activeProfile;
      try {
        ctx.modelRegistry.authStorage.reload();
      } catch {
        // Ignore reload errors; status will show last known state.
      }
      quotaCache = undefined;
    }

    // Keep footer quota synchronized across multiple Pi windows.  Any window
    // that fetches fresh quota writes it to shared state; other windows redraw
    // from that state without issuing their own network request immediately.
    if (ctx === activeContext) setFooter(ctx, state);
  }, CONFIG.statePollMs);
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("codex:quotas", {
    description: "Show Codex subscription quota",
    handler: async (_args, ctx) => {
      const result = await fetchCurrentQuotaResult(ctx);
      const quota = normalizeQuota(result);
      if (quota) {
        const state = readState();
        if (state.activeProfile) {
          state.lastQuotaByProfile[state.activeProfile] = quota;
          writeState(state);
          setFooter(ctx, state, quota);
        }
      }
      notify(ctx, ctx.ui.theme.fg("dim", formatQuotaCommandOutput(result)), result.success ? "info" : "warning");
    },
  });

  pi.registerCommand("codex:rotate", {
    description: "Manage Codex OAuth profile rotation: status|now|on|off|profile <name>|scan",
    getArgumentCompletions: (prefix: string) => {
      const commands = ["status", "now", "on", "off", "profile ", "scan"];
      return commands.filter((command) => command.startsWith(prefix)).map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      const [action, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      try {
        if (!action || action === "status") {
          const text = await commandStatus(ctx);
          notify(ctx, ctx.ui.theme.fg("dim", text), "info");
          setFooter(ctx);
          return;
        }
        if (action === "on" || action === "off") {
          const state = updateState((draft) => {
            draft.autoEnabled = action === "on";
          });
          notify(ctx, `Codex rotation ${state.autoEnabled ? "enabled" : "disabled"}`, "info");
          setFooter(ctx, state);
          return;
        }
        if (action === "scan") {
          const state = readState();
          const scans = await scanCandidates(pi, state, state.activeProfile, safeSignal(ctx));
          notify(ctx, ctx.ui.theme.fg("dim", formatScans(scans)), "info");
          setFooter(ctx, state);
          return;
        }
        if (action === "now") {
          await ctx.waitForIdle();
          const result = await rotateToBest(pi, ctx, "manual_now", { force: true });
          if (!result.rotated) notify(ctx, `Codex rotation skipped: ${result.reason}`, "warning");
          return;
        }
        if (action === "profile") {
          const profile = rest.join(" ").trim();
          if (!profile) throw new Error("Usage: /codex:rotate profile <name>");
          await rotateToProfile(pi, ctx, profile);
          return;
        }
        notify(ctx, "Usage: /codex:rotate status|now|on|off|profile <name>|scan", "warning");
      } catch (error) {
        notify(ctx, `Codex rotation error: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    activeContext = ctx;
    ctx.modelRegistry.authStorage.reload();
    startCrossProcessSync(ctx);
    const state = await maybeEnsureActiveProfile(pi);
    setFooter(ctx, state);
    startQuotaRefresh(pi, ctx);
    if (isCodexContext(ctx)) void maybeRotateForQuotaSafely(pi, ctx, "session_start");
  });

  pi.on("before_agent_start", (_event, ctx) => {
    // Do not fetch quota/rotate here: this hook blocks prompt submission.
    // Rotation still happens at safe provider boundaries: turn_end, agent_end,
    // model_select/session_start async refresh, and reactive 429 handling.
    if (isCodexContext(ctx)) setFooter(ctx, readState());
  });

  pi.on("before_provider_request", () => {
    providerInFlight = true;
  });

  pi.on("after_provider_response", async (event, ctx) => {
    if (!isCodexContext(ctx)) {
      providerInFlight = false;
      return;
    }
    if (event.status === 429) {
      const state = readState();
      const current = state.activeProfile ?? "unknown";
      state.cooldowns[current] = { until: Date.now() + CONFIG.cooldownMs, reason: "429" };
      writeState(state);
      audit(pi, "codex-usage-429", { profile: current, retryAfter: (event.headers as any)?.["retry-after"] });
      try {
        const result = await rotateToBest(pi, ctx, "429", { force: true, skipProfile: current });
        if (result.rotated) {
          notify(ctx, `Codex rate limited on ${current}; rotated to ${result.to}. Retry manually.`, "warning");
        } else {
          notify(ctx, `Codex rate limited on ${current}; ${result.reason}. Retry manually.`, "warning");
        }
      } catch (error) {
        notify(ctx, `Codex rate limited on ${current}; rotation failed: ${error instanceof Error ? error.message : String(error)}. Retry manually.`, "warning");
      }
    }
    providerInFlight = false;
  });

  pi.on("turn_end", async (_event, ctx) => {
    providerInFlight = false;
    await maybeRotateForQuotaSafely(pi, ctx, "turn_end");
  });

  pi.on("agent_end", async (_event, ctx) => {
    providerInFlight = false;
    await maybeRotateForQuotaSafely(pi, ctx, "agent_end");
  });

  pi.on("model_select", (_event, ctx) => {
    const state = readState();
    setFooter(ctx, state);
    if (ctx === activeContext) void refreshFooterQuota(pi, ctx);
    if (isCodexContext(ctx)) void maybeRotateForQuotaSafely(pi, ctx, "model_select");
  });

  pi.on("session_shutdown", (_event, ctx) => {
    providerInFlight = false;
    stopQuotaRefresh();
    stopWatcher?.();
    stopWatcher = undefined;
    activeContext = undefined;
    try {
      ctx.ui.setStatus(EXTENSION_ID, undefined);
    } catch {
      // Ignore stale context.
    }
  });
}
