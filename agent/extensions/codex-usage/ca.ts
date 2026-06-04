import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CaListResult, CaProfile, CaTokenResult } from "./types";

const CA_COMMAND = process.env.CODEX_ROTATION_CA_COMMAND || "ca";
const PI_ZSHRC = `${process.env.HOME}/.pi/agent/zshrc`;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function parseJson<T>(stdout: string, command: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch (error) {
    throw new Error(`${command} returned non-JSON output: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function explainCaFailure(args: string[], code: number, stderr?: string, stdout?: string): string {
  const output = stderr?.trim() || stdout?.trim();
  if (output) return `${CA_COMMAND} ${args.join(" ")} failed (${code}): ${output}`;
  return `${CA_COMMAND} ${args.join(" ")} failed (${code}): no output. The Codex rotation extension requires a real executable named '${CA_COMMAND}' in PATH (shell aliases are not visible to pi.exec) that supports '${CA_COMMAND} list --json' and '${CA_COMMAND} token <profile> --json'. Set CODEX_ROTATION_CA_COMMAND=/path/to/cli if needed.`;
}

async function execJson<T>(pi: ExtensionAPI, args: string[], signal?: AbortSignal): Promise<T> {
  let result = await pi.exec(CA_COMMAND, args, { signal, timeout: 20_000 });

  // User setup keeps ca/codexauth as a zsh function in ~/.pi/agent/zshrc.
  // pi.exec does not see aliases/functions by name, so fall back to sourcing
  // the lightweight zsh file when the real executable is unavailable.
  if (result.code !== 0 && CA_COMMAND === "ca" && !result.stdout?.trim() && !result.stderr?.trim()) {
    const command = `source ${shellQuote(PI_ZSHRC)}; ca ${args.map(shellQuote).join(" ")}`;
    result = await pi.exec("zsh", ["-fc", command], { signal, timeout: 20_000 });
  }

  if (result.code !== 0) throw new Error(explainCaFailure(args, result.code, result.stderr, result.stdout));
  return parseJson<T>(result.stdout, `${CA_COMMAND} ${args.join(" ")}`);
}

function assertProfile(value: any): CaProfile {
  if (!value || typeof value.name !== "string" || value.name.length === 0) throw new Error("Invalid ca profile entry");
  return {
    name: value.name,
    accountId: typeof value.accountId === "string" ? value.accountId : undefined,
    email: typeof value.email === "string" ? value.email : undefined,
  };
}

export async function caList(pi: ExtensionAPI, signal?: AbortSignal): Promise<CaListResult> {
  const data = await execJson<any>(pi, ["list", "--json"], signal);
  const profiles = Array.isArray(data?.profiles) ? data.profiles.map(assertProfile) : [];
  return { profiles, current: typeof data?.current === "string" ? data.current : undefined };
}

export async function caCurrent(pi: ExtensionAPI, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const data = await execJson<any>(pi, ["current", "--json"], signal);
    return typeof data?.current === "string" ? data.current : typeof data?.name === "string" ? data.name : undefined;
  } catch {
    return undefined;
  }
}

export async function caToken(pi: ExtensionAPI, profile: string, signal?: AbortSignal): Promise<CaTokenResult> {
  const data = await execJson<any>(pi, ["token", profile, "--json"], signal);
  if (!data?.credential || (data.credential.type !== "oauth" && data.credential.type !== "api_key")) {
    throw new Error(`ca token ${profile} did not return a usable credential`);
  }
  return {
    name: typeof data?.name === "string" ? data.name : profile,
    credential: data.credential,
    accountId: typeof data?.accountId === "string" ? data.accountId : undefined,
    email: typeof data?.email === "string" ? data.email : undefined,
  };
}

export async function caRestore(pi: ExtensionAPI, profile: string, signal?: AbortSignal): Promise<void> {
  await execJson<any>(pi, ["restore", profile, "--json"], signal);
}
