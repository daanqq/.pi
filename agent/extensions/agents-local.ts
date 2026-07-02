import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse } from "node:path";

const NAME = "AGENTS.local.md";

function localContextFiles(cwd: string) {
  const dirs: string[] = [];
  for (let dir = cwd; ; dir = dirname(dir)) {
    dirs.push(dir);
    if (dir === parse(dir).root) break;
  }

  const files = [join(homedir(), ".pi", "agent", NAME), ...dirs.reverse().map((dir) => join(dir, NAME))];
  return [...new Set(files)]
    .filter((path) => existsSync(path))
    .map((path) => ({ path, content: readFileSync(path, "utf8").trimEnd() }))
    .filter((file) => file.content.length > 0);
}

function escapeAttr(value: string) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function insertLikeNativeContext(systemPrompt: string, block: string) {
  const localContext = `Project-specific local instructions and guidelines from ${NAME}:\n\n${block}\n\n`;

  if (systemPrompt.includes("</project_context>")) {
    return systemPrompt.replace("</project_context>", `${localContext}</project_context>`);
  }

  const section = `\n\n<project_context>\n\n${localContext}</project_context>\n`;
  const markers = ["\n<available_skills>", "\nCurrent date:"];
  const marker = markers.find((marker) => systemPrompt.includes(marker));
  return marker ? systemPrompt.replace(marker, `${section}${marker}`) : `${systemPrompt}${section}`;
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", (event, ctx) => {
    const files = localContextFiles(ctx.cwd);
    if (files.length === 0) return;

    const block = files
      .map(
        ({ path, content }) =>
          `<project_instructions path="${escapeAttr(path)}">\n${content}\n</project_instructions>`,
      )
      .join("\n\n");

    return { systemPrompt: insertLikeNativeContext(event.systemPrompt, block) };
  });
}
