import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const CODEX_USAGE_DIR = join(homedir(), ".pi", "agent", "codex-usage");
export const STATE_PATH = join(CODEX_USAGE_DIR, "state.json");
export const LOCK_PATH = join(CODEX_USAGE_DIR, "lock");
export const PROFILE_DIR = join(CODEX_USAGE_DIR, "profiles");

const LEGACY_STATE_PATH = join(homedir(), ".pi", "agent", "codex-usage-state.json");
const LEGACY_PROFILE_DIR = join(homedir(), ".pi", "agent", "codex-usage-profiles");

let migrated = false;

function bestEffortChmod(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // chmod is best-effort on non-POSIX filesystems.
  }
}

function moveIfMissing(from: string, to: string): void {
  if (!existsSync(from) || existsSync(to)) return;
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  try {
    renameSync(from, to);
  } catch {
    copyFileSync(from, to);
    rmSync(from, { force: true });
  }
}

export function ensureCodexUsageDir(): void {
  mkdirSync(CODEX_USAGE_DIR, { recursive: true, mode: 0o700 });
  bestEffortChmod(CODEX_USAGE_DIR, 0o700);
  migrateRuntimeLayout();
}

export function migrateRuntimeLayout(): void {
  if (migrated) return;
  migrated = true;
  mkdirSync(CODEX_USAGE_DIR, { recursive: true, mode: 0o700 });
  bestEffortChmod(CODEX_USAGE_DIR, 0o700);

  moveIfMissing(LEGACY_STATE_PATH, STATE_PATH);
  if (existsSync(STATE_PATH)) bestEffortChmod(STATE_PATH, 0o600);

  if (existsSync(LEGACY_PROFILE_DIR) && !existsSync(PROFILE_DIR)) {
    mkdirSync(dirname(PROFILE_DIR), { recursive: true, mode: 0o700 });
    try {
      renameSync(LEGACY_PROFILE_DIR, PROFILE_DIR);
    } catch {
      // Leave the old directory in place rather than risk a partial recursive copy of credentials.
    }
  }

  if (existsSync(PROFILE_DIR)) bestEffortChmod(PROFILE_DIR, 0o700);
}
