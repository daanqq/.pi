import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const LOCK_PATH = join(homedir(), ".pi", "agent", "codex-usage.lock");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function lockAgeMs(): number | undefined {
  try {
    const data = JSON.parse(readFileSync(join(LOCK_PATH, "owner.json"), "utf8"));
    return Date.now() - Number(data?.createdAt ?? 0);
  } catch {
    return undefined;
  }
}

function tryAcquire(staleMs: number): boolean {
  try {
    mkdirSync(LOCK_PATH);
    writeFileSync(join(LOCK_PATH, "owner.json"), JSON.stringify({ pid: process.pid, createdAt: Date.now() }), "utf8");
    return true;
  } catch {
    const age = lockAgeMs();
    if (age != null && age > staleMs) {
      try {
        rmSync(LOCK_PATH, { recursive: true, force: true });
      } catch {
        // Ignore and retry below.
      }
      try {
        mkdirSync(LOCK_PATH);
        writeFileSync(join(LOCK_PATH, "owner.json"), JSON.stringify({ pid: process.pid, createdAt: Date.now() }), "utf8");
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

export async function withRotationLock<T>(staleMs: number, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 15_000;
  while (!tryAcquire(staleMs)) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for codex usage lock");
    await sleep(150 + Math.floor(Math.random() * 100));
  }

  try {
    return await fn();
  } finally {
    if (existsSync(LOCK_PATH)) rmSync(LOCK_PATH, { recursive: true, force: true });
  }
}
