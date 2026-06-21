import os from "node:os";
import process from "node:process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

function systemInfo(cwd: string) {
  const user = safe(() => os.userInfo().username) ?? "unknown";

  return [
    "Runtime system info:",
    `- OS: ${os.type()} ${os.release()} (${os.platform()} ${os.arch()})`,
    `- Hostname: ${os.hostname()}`,
    `- User: ${user}`,
    `- Home: ${os.homedir()}`,
    `- Shell: ${process.env.SHELL ?? process.env.ComSpec ?? "unknown"}`,
    `- CWD: ${cwd}`,
    `- Node: ${process.version}`,
  ].join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => ({
    systemPrompt: `${event.systemPrompt}\n\n${systemInfo(ctx.cwd)}`,
  }));
}
