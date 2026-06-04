import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, watch, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { RotationState } from "./types";

export const STATE_PATH = join(homedir(), ".pi", "agent", "codex-usage-state.json");
const LEGACY_STATE_PATH = join(homedir(), ".pi", "agent", "codex-rotation-state.json");

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
  mkdirSync(dirname(STATE_PATH), { recursive: true });
}

export function readState(): RotationState {
  ensureStateDir();
  const path = existsSync(STATE_PATH) ? STATE_PATH : LEGACY_STATE_PATH;
  if (!existsSync(path)) return defaultState();
  try {
    return sanitizeState(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return defaultState();
  }
}

export function writeState(state: RotationState): void {
  ensureStateDir();
  const tmp = `${STATE_PATH}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(sanitizeState(state), null, 2)}\n`, "utf8");
  renameSync(tmp, STATE_PATH);
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
      if (filename?.toString() === "codex-usage-state.json" || filename?.toString() === "codex-rotation-state.json" || event === "rename") check();
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
