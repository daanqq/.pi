import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const logDir = join(homedir(), ".pi", "logs", "prompt-audit");

let enabled = process.env.PI_PROMPT_AUDIT === "1";
let once = false;
let pendingSystemBreakdown: unknown = undefined;
let pendingUserPrompt = "";
let seq = 0;

function roughTokens(text: unknown): number {
  if (typeof text !== "string" || text.length === 0) return 0;
  // Cheap cross-provider estimate. Use payload dump for exact provider tokenizer offline.
  return Math.ceil(text.length / 4);
}

function summarizeText(name: string, text: unknown) {
  const value = typeof text === "string" ? text : "";
  return {
    name,
    chars: value.length,
    roughTokens: roughTokens(value),
    preview: value.slice(0, 500),
  };
}

function summarizeMessage(message: any, index: number) {
  const content = message?.content;
  let text = "";

  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part?.text === "string") return part.text;
        if (typeof part?.content === "string") return part.content;
        return JSON.stringify(part);
      })
      .join("\n");
  } else if (content != null) {
    text = JSON.stringify(content);
  }

  return {
    index,
    role: message?.role,
    chars: text.length,
    roughTokens: roughTokens(text),
    preview: text.slice(0, 500),
  };
}

function summarizePayload(payload: any) {
  const system = payload?.system;
  const instructions = payload?.instructions;
  const messages = payload?.messages ?? payload?.input;

  return {
    providerFields: Object.keys(payload ?? {}),
    model: payload?.model,
    system: Array.isArray(system)
      ? system.map((part, index) => summarizeText(`system[${index}]`, part?.text ?? part?.content ?? JSON.stringify(part)))
      : summarizeText("system", system),
    instructions: summarizeText("instructions", instructions),
    messages: Array.isArray(messages) ? messages.map(summarizeMessage) : summarizeText("input", messages),
    payloadJsonChars: JSON.stringify(payload ?? {}).length,
    payloadJsonRoughTokens: roughTokens(JSON.stringify(payload ?? {})),
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("prompt-audit", {
    description: "Toggle/log initial prompt payload sent by pi",
    handler: async (args, ctx) => {
      const arg = args.trim();
      if (arg === "on") enabled = true;
      else if (arg === "off") enabled = false;
      else if (arg === "once" || arg === "") {
        enabled = true;
        once = true;
      } else if (arg !== "status") {
        ctx.ui.notify("Usage: /prompt-audit [once|on|off|status]", "warn");
        return;
      }
      ctx.ui.notify(`prompt-audit: ${enabled ? (once ? "once" : "on") : "off"}. Logs: ${logDir}`, "info");
    },
  });

  pi.on("before_agent_start", async (event) => {
    if (!enabled) return;

    pendingUserPrompt = event.prompt;
    const options: any = event.systemPromptOptions ?? {};
    pendingSystemBreakdown = {
      systemPrompt: summarizeText("final pi systemPrompt", event.systemPrompt),
      customPrompt: summarizeText("customPrompt", options.customPrompt),
      appendSystemPrompt: Array.isArray(options.appendSystemPrompt)
        ? options.appendSystemPrompt.map((text: string, index: number) => summarizeText(`appendSystemPrompt[${index}]`, text))
        : summarizeText("appendSystemPrompt", options.appendSystemPrompt),
      contextFiles: Array.isArray(options.contextFiles)
        ? options.contextFiles.map((file: any, index: number) => ({
            index,
            path: file?.path ?? file?.name,
            ...summarizeText("content", file?.content ?? file?.text ?? JSON.stringify(file)),
          }))
        : [],
      skills: Array.isArray(options.skills)
        ? options.skills.map((skill: any, index: number) => ({
            index,
            name: skill?.name,
            ...summarizeText("content", skill?.content ?? skill?.description ?? JSON.stringify(skill)),
          }))
        : [],
      selectedTools: Array.isArray(options.selectedTools) ? options.selectedTools : [],
      toolSnippets: Array.isArray(options.toolSnippets)
        ? options.toolSnippets.map((text: string, index: number) => summarizeText(`toolSnippets[${index}]`, text))
        : [],
      promptGuidelines: Array.isArray(options.promptGuidelines)
        ? options.promptGuidelines.map((text: string, index: number) => summarizeText(`promptGuidelines[${index}]`, text))
        : [],
    };
  });

  pi.on("before_provider_request", (event) => {
    if (!enabled) return;

    mkdirSync(logDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = join(logDir, `${stamp}-${++seq}.json`);
    const report = {
      createdAt: new Date().toISOString(),
      note: "roughTokens ~= ceil(chars/4). payload is exact serialized provider request; run provider-specific tokenizer offline for exact counts.",
      userPrompt: summarizeText("user prompt", pendingUserPrompt),
      piSystemBreakdown: pendingSystemBreakdown,
      providerPayloadSummary: summarizePayload(event.payload),
      providerPayload: event.payload,
    };
    writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(`[prompt-audit] wrote ${file}`);

    if (once) {
      once = false;
      enabled = false;
    }
  });
}
