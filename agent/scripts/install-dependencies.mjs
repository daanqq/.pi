import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";

const execFileAsync = promisify(execFile);
const agentDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const packageDirectories = [
  resolve(agentDir, "extensions"),
  resolve(agentDir, "extensions", "subagents"),
];

for (const cwd of packageDirectories) {
  console.log(`Installing dependencies in ${cwd}`);
  await execFileAsync(npm, ["ci"], { cwd, stdio: "inherit" });
}

console.log("All extension dependencies are installed.");
