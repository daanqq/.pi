import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, watch, type FSWatcher } from "node:fs";
import { dirname } from "node:path";
import { ensureCodexUsageDir, STATE_PATH } from "./paths";
import type { RotationState } from "./types";

export function defaultState(): RotationState {
  return { version: 1, autoEnabled: true, cooldowns: {}, lastQuotaByProfile: {} };
}

function sanitizeState(data: any): RotationState {
  return {
    version: 1,
    autoEnabled: typeof data?.autoEnabled === "boolean" ? data.autoEnabled : true,
    activeProfile: typeof data?.activeProfile === "string" ? data.activeProfile : undefined,
    activeAccountId: typeof data?.activeAccountId === "string" ? data.activeAccountId : undefined,
    activeEmail: typeof data?.activeEmail === "string" ? data.activeEmail : undefined,
    lastRotationAt: typeof data?.lastRotationAt === "number" ? data.lastRotationAt : undefined,
    cooldowns: data?.cooldowns && typeof data.cooldowns === "object" ? data.cooldowns : {},
    lastQuotaByProfile: data?.lastQuotaByProfile && typeof data.lastQuotaByProfile === "object" ? data.lastQuotaByProfile : {},
  };
}

export function ensureStateDir(): void {
  ensureCodexUsageDir();
  mkdirSync(dirname(STATE_PATH), { recursive: true, mode: 0o700 });
}

export function readState(): RotationState {
  ensureStateDir();
  if (!existsSync(STATE_PATH)) return defaultState();
  try {
    return sanitizeState(JSON.parse(readFileSync(STATE_PATH, "utf8")));
  } catch {
    return defaultState();
  }
}

export function writeState(state: RotationState): void {
  ensureStateDir();
  const tmp = `${STATE_PATH}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(sanitizeState(state), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // chmod is best-effort on non-POSIX filesystems.
  }
  renameSync(tmp, STATE_PATH);
  try {
    chmodSync(STATE_PATH, 0o600);
  } catch {
    // chmod is best-effort on non-POSIX filesystems.
  }
}

export function updateState(mutator: (state: RotationState) => void): RotationState {
  const state = readState();
  mutator(state);
  writeState(state);
  return state;
}

export function pruneCooldowns(state: RotationState, now = Date.now()): void {
  for (const [profile, cooldown] of Object.entries(state.cooldowns)) {
    if (!cooldown || cooldown.until <= now) delete state.cooldowns[profile];
  }
}

export function watchState(onChange: () => void, pollMs: number): () => void {
  ensureStateDir();
  let watcher: FSWatcher | undefined;
  let lastText = "";
  let timer: ReturnType<typeof setInterval> | undefined;

  const check = () => {
    let text = "";
    try {
      text = existsSync(STATE_PATH) ? readFileSync(STATE_PATH, "utf8") : "";
    } catch {
      return;
    }
    if (text !== lastText) {
      lastText = text;
      onChange();
    }
  };

  try {
    watcher = watch(dirname(STATE_PATH), (event, filename) => {
      if (filename?.toString() === "state.json" || event === "rename") check();
    });
  } catch {
    // Polling below is enough on filesystems without watch support.
  }

  timer = setInterval(check, pollMs);
  timer.unref?.();
  check();

  return () => {
    watcher?.close();
    if (timer) clearInterval(timer);
  };
}
