import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, sep } from "node:path";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AuthCredential, CodexProfile, ProfileCredentialResult, ProfileListResult, StoredCodexProfile } from "./types";
import { ensureCodexUsageDir, PROFILE_DIR } from "./paths";
import { CODEX_PROVIDER } from "./types";
const CURRENT_FILE = join(PROFILE_DIR, ".current");

function ensureProfileDir(): void {
  ensureCodexUsageDir();
  mkdirSync(PROFILE_DIR, { recursive: true, mode: 0o700 });
}

function bestEffortChmod(path: string, mode = 0o600): void {
  try {
    chmodSync(path, mode);
  } catch {
    // chmod is best-effort on non-POSIX filesystems (for example Windows).
  }
}

export function validateProfileName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Profile name must be non-empty");
  if (trimmed === ".current") throw new Error("Profile name '.current' is reserved");
  if (trimmed === "." || trimmed === ".." || trimmed.includes("..")) throw new Error("Profile name must not contain '..'");
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes(sep)) throw new Error("Profile name must not contain path separators");
  if (basename(trimmed) !== trimmed) throw new Error("Profile name must be a plain file name");
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) throw new Error("Profile name may contain only letters, numbers, '.', '_' and '-'");
  return trimmed;
}

function profilePath(name: string): string {
  return join(PROFILE_DIR, `${validateProfileName(name)}.json`);
}

function atomicWriteJson(path: string, data: unknown): void {
  ensureProfileDir();
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  bestEffortChmod(tmp);
  renameSync(tmp, path);
  bestEffortChmod(path);
}

function atomicWriteText(path: string, text: string): void {
  ensureProfileDir();
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
  bestEffortChmod(tmp);
  renameSync(tmp, path);
  bestEffortChmod(path);
}

function assertCredential(value: any, profile: string): AuthCredential {
  if (!value || (value.type !== "oauth" && value.type !== "api_key")) throw new Error(`Profile ${profile} does not contain a usable credential`);
  return value as AuthCredential;
}

function sanitizeStoredProfile(data: any, fallbackName: string): StoredCodexProfile {
  const name = validateProfileName(typeof data?.name === "string" ? data.name : fallbackName);
  if (data?.version !== 1) throw new Error(`Profile ${name} has unsupported version`);
  if (data?.provider !== CODEX_PROVIDER) throw new Error(`Profile ${name} is not for ${CODEX_PROVIDER}`);
  return {
    version: 1,
    name,
    provider: CODEX_PROVIDER,
    credential: assertCredential(data?.credential, name),
    accountId: typeof data?.accountId === "string" ? data.accountId : credentialAccountId(data?.credential),
    email: typeof data?.email === "string" ? data.email : credentialEmail(data?.credential),
    savedAt: typeof data?.savedAt === "number" ? data.savedAt : 0,
    lastUsedAt: typeof data?.lastUsedAt === "number" ? data.lastUsedAt : undefined,
  };
}

function readStoredProfile(name: string): StoredCodexProfile {
  const path = profilePath(name);
  if (!existsSync(path)) throw new Error(`Profile '${name}' not found`);
  return sanitizeStoredProfile(JSON.parse(readFileSync(path, "utf8")), validateProfileName(name));
}

function credentialAccountId(credential: any): string | undefined {
  return credential?.accountId ?? credential?.account_id;
}

function credentialEmail(credential: any): string | undefined {
  return credential?.email ?? credential?.account?.email;
}

function profileSummary(profile: StoredCodexProfile): CodexProfile {
  return { name: profile.name, accountId: profile.accountId, email: profile.email };
}

export function listProfiles(): ProfileListResult {
  ensureProfileDir();
  const profiles = readdirSync(PROFILE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name.slice(0, -".json".length))
    .flatMap((name) => {
      try {
        return [profileSummary(readStoredProfile(name))];
      } catch {
        return [];
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return { profiles, current: getCurrentProfile() };
}

export function getCurrentProfile(): string | undefined {
  ensureProfileDir();
  if (!existsSync(CURRENT_FILE)) return undefined;
  try {
    const name = readFileSync(CURRENT_FILE, "utf8").trim();
    return name ? validateProfileName(name) : undefined;
  } catch {
    return undefined;
  }
}

export function setCurrentProfile(name: string | undefined): void {
  ensureProfileDir();
  if (!name) {
    rmSync(CURRENT_FILE, { force: true });
    return;
  }
  atomicWriteText(CURRENT_FILE, `${validateProfileName(name)}\n`);
}

export function getProfileCredential(name: string): ProfileCredentialResult {
  const profile = readStoredProfile(name);
  return {
    name: profile.name,
    credential: profile.credential,
    accountId: profile.accountId,
    email: profile.email,
  };
}

export function saveCurrentProfile(ctx: ExtensionContext | ExtensionCommandContext, name: string): StoredCodexProfile {
  const safeName = validateProfileName(name);
  const credential = assertCredential(ctx.modelRegistry.authStorage.get(CODEX_PROVIDER), safeName);
  const profile: StoredCodexProfile = {
    version: 1,
    name: safeName,
    provider: CODEX_PROVIDER,
    credential,
    accountId: credentialAccountId(credential),
    email: credentialEmail(credential),
    savedAt: Date.now(),
    lastUsedAt: Date.now(),
  };
  atomicWriteJson(profilePath(safeName), profile);
  setCurrentProfile(safeName);
  return profile;
}

export function useProfile(ctx: ExtensionContext | ExtensionCommandContext, name: string): ProfileCredentialResult {
  const profile = readStoredProfile(name);
  ctx.modelRegistry.authStorage.set(CODEX_PROVIDER, profile.credential);
  const updated = { ...profile, lastUsedAt: Date.now() };
  atomicWriteJson(profilePath(profile.name), updated);
  setCurrentProfile(profile.name);
  return {
    name: profile.name,
    credential: profile.credential,
    accountId: profile.accountId,
    email: profile.email,
  };
}

export function deleteProfile(name: string): void {
  const safeName = validateProfileName(name);
  rmSync(profilePath(safeName), { force: true });
  if (getCurrentProfile() === safeName) setCurrentProfile(undefined);
}
