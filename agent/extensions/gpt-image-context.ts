import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type JsonObject = { [key: string]: any };

type Stats = {
  applied: boolean;
  api: "responses" | "chat" | "unknown";
  reason?: string;
  model?: string;
  collapsedItems?: number;
  charsBefore?: number;
  charsAfter?: number;
  imageCount?: number;
  collapsedSections?: number;
  cacheHits?: number;
  cacheMisses?: number;
  cachePrefixSha8?: string;
};

type TransformResult = { payload?: JsonObject; stats: Stats };

type HistoryTurn = {
  index: number;
  role: string;
  text: string;
  userText?: string;
  openIds: string[];
  closeIds: string[];
  opaque?: boolean;
};

type PlannedSection = {
  start: number;
  end: number;
  text: string;
  images: string[];
  facts: string;
  imageSha8: string;
  cacheHit: boolean;
};

type SectionPlan = {
  protectedPrefix: number;
  rawEnd: number;
  sections: PlannedSection[];
  reason?: string;
};

const STATUS_ID = "gptimg";
const LOG_DIR = join(homedir(), ".pi", "logs", "gpt-image-context");
const CACHE_DIR = join(homedir(), ".pi", "cache", "gpt-image-context");
const RENDERER_VERSION = "gptimg-pil-v2";

const CONFIG = {
  keepTailItems: 8,
  minCollapsePrefix: 4,
  collapseChunk: 4,
  sectionTokens: 3_500,
  minSectionTokens: 2_200,
  maxCollapseChars: 160_000,
  wrapColumns: 152,
  maxLinesPerImage: 118,
  maxImages: 10,
  fontSize: 13,
  lineHeight: 17,
  padding: 18,
  imageWidth: 1_360,
};

let enabled = process.env.PI_GPT_IMAGE_CONTEXT !== "0";
let lastStats: Stats = { applied: false, api: "unknown", reason: "not run" };
let dumpNext = false;

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(Math.max(0, Math.round(tokens)));
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function supportsGptImages(model: unknown): boolean {
  if (typeof model !== "string") return false;
  const id = model.toLowerCase();
  return /(^|[-_/])(gpt|o3|o4|codex)/.test(id) && !/(embedding|audio|tts|transcribe|whisper)/.test(id);
}

function updateStatus(ctx: ExtensionContext | undefined, stats = lastStats): void {
  if (!ctx?.hasUI) return;
  const text = enabled
    ? stats.applied
      ? `on ${stats.imageCount ?? 0}img ${formatTokens(Math.ceil((stats.charsBefore ?? 0) / 4))}→${formatTokens(Math.ceil((stats.charsAfter ?? 0) / 4))}`
      : `on ${stats.reason ?? "idle"}`
    : "off";
  ctx.ui.setStatus(STATUS_ID, text);
}

function record(stats: Stats, ctx?: ExtensionContext): void {
  lastStats = stats;
  updateStatus(ctx, stats);
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(join(LOG_DIR, "events.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), ...stats })}\n`, "utf8");
  } catch {
    // Telemetry is best-effort only.
  }
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!isObject(part)) return JSON.stringify(part);
      if (typeof part.text === "string") return part.text;
      if (typeof part.content === "string") return part.content;
      if (typeof part.output_text === "string") return part.output_text;
      if (part.type === "input_image" || part.type === "image_url") return `[${part.type}]`;
      return JSON.stringify(part);
    })
    .join("\n");
}

function responsesItemText(item: unknown): string {
  if (!isObject(item)) return JSON.stringify(item);
  if (typeof item.role === "string") return textFromContent(item.content);
  if (item.type === "message") return textFromContent(item.content);
  if (item.type === "function_call") return `function ${item.name ?? "tool"}(${item.arguments ?? ""})`;
  if (item.type === "function_call_output") return textFromContent(item.output);
  if (item.type === "reasoning") return "[reasoning item]";
  return JSON.stringify(item);
}

function itemLabel(item: unknown): string {
  if (!isObject(item)) return "item";
  if (typeof item.role === "string") return item.role;
  if (item.type === "message" && typeof item.role === "string") return item.role;
  if (item.type === "function_call") return `assistant.tool_call:${item.name ?? "tool"}`;
  if (item.type === "function_call_output") return "tool.output";
  if (typeof item.type === "string") return item.type;
  return "item";
}

function toTranscript(items: unknown[], api: "responses" | "chat"): string {
  const lines = [
    `Earlier ${api === "responses" ? "OpenAI Responses input items" : "OpenAI chat messages"} rendered as an image transcript.`,
    "Do not copy exact IDs/hashes/paths from the image unless they also appear in plain text below.",
    "",
  ];

  items.forEach((item, index) => {
    const label = itemLabel(item);
    const text = api === "responses" ? responsesItemText(item) : isObject(item) ? textFromContent(item.content) : JSON.stringify(item);
    lines.push(`===== ${index + 1}. ${label} =====`);
    lines.push(text.trim() || "[empty]");
    lines.push("");
  });

  return lines.join("\n");
}

function containsUnsafeExactText(text: string): boolean {
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)
    || /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/.test(text)
    || /\bAKIA[0-9A-Z]{16}\b/.test(text)
    || /\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*['"]?[^\s'"]{12,}/i.test(text);
}

function factSheet(text: string): string {
  const found = new Set<string>();
  const patterns = [
    /\b[0-9a-f]{7,64}\b/gi,
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    /(?:^|\s)((?:~|\.|\.\.|\/)[\w@%+=:,./-]{3,})/g,
    /\b[A-Z_][A-Z0-9_]{3,}\b/g,
    /\bv?\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?\b/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = (match[1] ?? match[0]).trim();
      if (value.length >= 4 && value.length <= 120) found.add(value);
      if (found.size >= 40) break;
    }
    if (found.size >= 40) break;
  }
  if (found.size === 0) return "";
  return `Exact strings preserved from rendered history:\n${[...found].map((value) => `- ${value}`).join("\n")}`;
}

function wrapText(text: string, columns: number): string[] {
  const out: string[] = [];
  for (const raw of text.replace(/\t/g, "  ").split(/\r?\n/)) {
    let line = raw;
    if (line.length === 0) {
      out.push("");
      continue;
    }
    while (line.length > columns) {
      let cut = line.lastIndexOf(" ", columns);
      if (cut < Math.floor(columns * 0.55)) cut = columns;
      out.push(line.slice(0, cut));
      line = line.slice(cut).replace(/^\s+/, "");
    }
    out.push(line);
  }
  return out;
}

function renderTranscriptImages(transcript: string): string[] | undefined {
  const lines = wrapText(transcript.slice(0, CONFIG.maxCollapseChars), CONFIG.wrapColumns);
  const pageCount = Math.ceil(lines.length / CONFIG.maxLinesPerImage);
  if (pageCount === 0 || pageCount > CONFIG.maxImages) return undefined;

  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += CONFIG.maxLinesPerImage) pages.push(lines.slice(i, i + CONFIG.maxLinesPerImage));

  const script = String.raw`
import base64, io, json, sys
payload = json.load(sys.stdin)
try:
    from PIL import Image, ImageDraw, ImageFont
except Exception as exc:
    print(json.dumps({"error": "PIL unavailable: %s" % exc}))
    sys.exit(0)
font = None
for path in ["/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", "/usr/share/fonts/truetype/liberation2/LiberationMono-Regular.ttf"]:
    try:
        font = ImageFont.truetype(path, payload["fontSize"])
        break
    except Exception:
        pass
if font is None:
    font = ImageFont.load_default()
images = []
for lines in payload["pages"]:
    height = payload["padding"] * 2 + max(1, len(lines)) * payload["lineHeight"]
    img = Image.new("RGB", (payload["width"], height), "white")
    draw = ImageDraw.Draw(img)
    y = payload["padding"]
    for line in lines:
        draw.text((payload["padding"], y), line, fill=(0, 0, 0), font=font)
        y += payload["lineHeight"]
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    images.append(base64.b64encode(buf.getvalue()).decode("ascii"))
print(json.dumps({"images": images}))
`;

  const result = spawnSync("python3", ["-c", script], {
    input: JSON.stringify({
      pages,
      width: CONFIG.imageWidth,
      padding: CONFIG.padding,
      fontSize: CONFIG.fontSize,
      lineHeight: CONFIG.lineHeight,
    }),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 20_000,
  });

  if (result.error || result.status !== 0 || !result.stdout.trim()) return undefined;
  try {
    const parsed = JSON.parse(result.stdout) as { images?: string[] };
    return parsed.images?.length ? parsed.images : undefined;
  } catch {
    return undefined;
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function sha8(text: string): string {
  return sha256(text).slice(0, 8);
}

function renderTranscriptImagesCached(transcript: string): { images: string[]; sha8: string; cacheHit: boolean } | undefined {
  const key = sha256(JSON.stringify({
    version: RENDERER_VERSION,
    wrapColumns: CONFIG.wrapColumns,
    maxLinesPerImage: CONFIG.maxLinesPerImage,
    fontSize: CONFIG.fontSize,
    lineHeight: CONFIG.lineHeight,
    padding: CONFIG.padding,
    imageWidth: CONFIG.imageWidth,
    transcript,
  }));
  const file = join(CACHE_DIR, `${key}.json`);
  if (existsSync(file)) {
    try {
      const cached = JSON.parse(readFileSync(file, "utf8")) as { images?: string[] };
      if (cached.images?.length) return { images: cached.images, sha8: key.slice(0, 8), cacheHit: true };
    } catch {
      // Bad cache entries are ignored and overwritten below.
    }
  }

  const images = renderTranscriptImages(transcript);
  if (!images) return undefined;
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(file, JSON.stringify({ images }), "utf8");
  } catch {
    // Render cache is best-effort; byte stability still holds for this process.
  }
  return { images, sha8: key.slice(0, 8), cacheHit: false };
}

function responsesImagePart(base64: string): JsonObject {
  return { type: "input_image", image_url: `data:image/png;base64,${base64}`, detail: "original" };
}

function chatImagePart(base64: string): JsonObject {
  return { type: "image_url", image_url: { url: `data:image/png;base64,${base64}`, detail: "original" } };
}

function contentHasImage(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((part) => isObject(part) && (part.type === "input_image" || part.type === "image_url" || part.type === "image"));
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function responsesItemsToTurns(input: unknown[]): HistoryTurn[] {
  return input.map((item, index): HistoryTurn => {
    if (!isObject(item)) return { index, role: "unknown", text: JSON.stringify(item), openIds: [], closeIds: [], opaque: true };
    const role = typeof item.role === "string" ? item.role : typeof item.type === "string" ? item.type : "item";
    if (typeof item.role === "string") {
      const text = textFromContent(item.content);
      return {
        index,
        role,
        text,
        userText: item.role === "user" ? text : undefined,
        openIds: [],
        closeIds: [],
        opaque: contentHasImage(item.content),
      };
    }
    if (item.type === "message") {
      const text = textFromContent(item.content);
      return { index, role, text, userText: item.role === "user" ? text : undefined, openIds: [], closeIds: [], opaque: contentHasImage(item.content) };
    }
    if (item.type === "function_call") {
      const id = typeof item.call_id === "string" ? item.call_id : undefined;
      return { index, role, text: responsesItemText(item), openIds: id ? [id] : [], closeIds: [], opaque: !id };
    }
    if (item.type === "function_call_output") {
      const id = typeof item.call_id === "string" ? item.call_id : undefined;
      return { index, role, text: responsesItemText(item), openIds: [], closeIds: id ? [id] : [], opaque: !id };
    }
    return { index, role, text: responsesItemText(item), openIds: [], closeIds: [], opaque: true };
  });
}

function chatMessagesToTurns(messages: unknown[]): HistoryTurn[] {
  return messages.map((msg, index): HistoryTurn => {
    if (!isObject(msg)) return { index, role: "unknown", text: JSON.stringify(msg), openIds: [], closeIds: [], opaque: true };
    const role = typeof msg.role === "string" ? msg.role : "message";
    const text = textFromContent(msg.content);
    const openIds = Array.isArray(msg.tool_calls)
      ? msg.tool_calls.map((call) => (typeof call?.id === "string" ? call.id : undefined)).filter(Boolean) as string[]
      : [];
    const closeIds = role === "tool" && typeof msg.tool_call_id === "string" ? [msg.tool_call_id] : [];
    return {
      index,
      role,
      text: openIds.length ? [text, ...openIds.map((id) => `tool_call:${id}`)].filter(Boolean).join("\n") : text,
      userText: role === "user" ? text : undefined,
      openIds,
      closeIds,
      opaque: contentHasImage(msg.content) || (openIds.length === 0 && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0),
    };
  });
}

function leadingProtectedPrefix(turns: HistoryTurn[]): number {
  let i = 0;
  while (i < turns.length && (turns[i]!.role === "system" || turns[i]!.role === "developer")) i++;
  return i;
}

function isClosedRange(turns: HistoryTurn[], start: number, endExclusive: number): boolean {
  const open = new Set<string>();
  for (let i = start; i < endExclusive; i++) {
    const turn = turns[i];
    if (!turn || turn.opaque) return false;
    for (const id of turn.openIds) open.add(id);
    for (const id of turn.closeIds) {
      if (!open.has(id)) return false;
      open.delete(id);
    }
  }
  return open.size === 0;
}

function findClosedBoundary(turns: HistoryTurn[], desiredEndExclusive: number, start: number): number {
  for (let end = Math.min(desiredEndExclusive, turns.length); end > start; end--) {
    if (isClosedRange(turns, start, end)) return end;
  }
  return start;
}

function latestUserIndex(turns: HistoryTurn[], start: number): number {
  for (let i = turns.length - 1; i >= start; i--) {
    if (turns[i]?.userText !== undefined) return i;
  }
  return -1;
}

function sectionTranscript(turns: HistoryTurn[], start: number, end: number, api: "responses" | "chat"): string {
  const items = turns.slice(start, end).map((turn) => ({ role: turn.role, content: turn.text }));
  return toTranscript(items, api);
}

function renderSection(turns: HistoryTurn[], start: number, end: number, api: "responses" | "chat"): PlannedSection | undefined {
  const text = sectionTranscript(turns, start, end, api);
  const tokens = estimateTokens(text);
  if (tokens < CONFIG.minSectionTokens) return undefined;
  if (text.length > CONFIG.maxCollapseChars) return undefined;
  if (containsUnsafeExactText(text)) return undefined;
  const rendered = renderTranscriptImagesCached(text);
  if (!rendered) return undefined;
  return { start, end, text, images: rendered.images, facts: factSheet(text), imageSha8: rendered.sha8, cacheHit: rendered.cacheHit };
}

function planFrozenSections(turns: HistoryTurn[], api: "responses" | "chat"): SectionPlan {
  const pp = leadingProtectedPrefix(turns);
  const rawCutoff = turns.length - CONFIG.keepTailItems;
  if (rawCutoff - pp < CONFIG.minCollapsePrefix) return { protectedPrefix: pp, rawEnd: pp, sections: [], reason: "prefix_too_short" };
  const snappedCutoff = Math.min(
    rawCutoff,
    Math.max(pp + CONFIG.minCollapsePrefix, pp + Math.floor((rawCutoff - pp) / CONFIG.collapseChunk) * CONFIG.collapseChunk),
  );
  const rawEnd = findClosedBoundary(turns, snappedCutoff, pp);
  if (rawEnd - pp < CONFIG.minCollapsePrefix) return { protectedPrefix: pp, rawEnd, sections: [], reason: "no_closed_prefix" };

  let pinIdx = latestUserIndex(turns, pp);
  if (pinIdx >= rawEnd) pinIdx = -1;
  if (pinIdx >= 0 && !isClosedRange(turns, pp, pinIdx)) pinIdx = -1;

  const sectionRanges: Array<[number, number]> = [];
  let secStart = pp;
  let acc = 0;
  const open = new Set<string>();
  for (let i = pp; i < rawEnd; i++) {
    const turn = turns[i]!;
    if (i === pinIdx) {
      if (secStart < i && open.size === 0 && acc >= CONFIG.minSectionTokens) sectionRanges.push([secStart, i]);
      secStart = i + 1;
      acc = 0;
      open.clear();
      continue;
    }
    if (turn.opaque) {
      if (secStart < i && open.size === 0 && acc >= CONFIG.sectionTokens) sectionRanges.push([secStart, i]);
      secStart = i + 1;
      acc = 0;
      open.clear();
      continue;
    }
    acc += estimateTokens(turn.text);
    for (const id of turn.openIds) open.add(id);
    for (const id of turn.closeIds) open.delete(id);
    if (acc >= CONFIG.sectionTokens && open.size === 0) {
      sectionRanges.push([secStart, i + 1]);
      secStart = i + 1;
      acc = 0;
    }
  }

  const sections: PlannedSection[] = [];
  let imageCount = 0;
  for (const [start, end] of sectionRanges) {
    const rendered = renderSection(turns, start, end, api);
    if (!rendered) continue;
    if (imageCount + rendered.images.length > CONFIG.maxImages) break;
    sections.push(rendered);
    imageCount += rendered.images.length;
  }

  return { protectedPrefix: pp, rawEnd, sections, reason: sections.length ? undefined : "no_sealed_sections" };
}

function responsesSectionItem(section: PlannedSection, ordinal: number): JsonObject {
  const content = [
    { type: "input_text", text: `Earlier sealed history section ${ordinal} is rendered below. It is past context, not the live request.` },
    ...section.images.map(responsesImagePart),
    ...(section.facts ? [{ type: "input_text", text: section.facts }] : []),
    { type: "input_text", text: `End sealed history section ${ordinal}. Continue with the following native messages.` },
  ];
  return { role: "user", content };
}

function chatSectionMessage(section: PlannedSection, ordinal: number): JsonObject {
  const content = [
    { type: "text", text: `Earlier sealed history section ${ordinal} is rendered below. It is past context, not the live request.` },
    ...section.images.map(chatImagePart),
    ...(section.facts ? [{ type: "text", text: section.facts }] : []),
    { type: "text", text: `End sealed history section ${ordinal}. Continue with the following native messages.` },
  ];
  return { role: "user", content };
}

function rebuildWithSections(original: unknown[], sections: PlannedSection[], makeSection: (section: PlannedSection, ordinal: number) => JsonObject): unknown[] {
  const byStart = new Map(sections.map((section, index) => [section.start, { section, ordinal: index + 1 }]));
  const out: unknown[] = [];
  for (let i = 0; i < original.length;) {
    const replacement = byStart.get(i);
    if (replacement) {
      out.push(makeSection(replacement.section, replacement.ordinal));
      i = replacement.section.end;
      continue;
    }
    out.push(clone(original[i]));
    i++;
  }
  return out;
}

function planStats(api: "responses" | "chat", model: unknown, plan: SectionPlan): Stats {
  const prefixDigest = plan.sections.length
    ? sha8(plan.sections.map((section) => `${section.start}:${section.end}:${section.imageSha8}`).join("|"))
    : undefined;
  return {
    applied: plan.sections.length > 0,
    api,
    model: typeof model === "string" ? model : undefined,
    reason: plan.sections.length ? undefined : plan.reason,
    collapsedItems: plan.sections.reduce((sum, section) => sum + (section.end - section.start), 0),
    collapsedSections: plan.sections.length,
    charsBefore: plan.sections.reduce((sum, section) => sum + section.text.length, 0),
    charsAfter: plan.sections.reduce((sum, section) => sum + section.facts.length + 160, 0),
    imageCount: plan.sections.reduce((sum, section) => sum + section.images.length, 0),
    cacheHits: plan.sections.filter((section) => section.cacheHit).length,
    cacheMisses: plan.sections.filter((section) => !section.cacheHit).length,
    cachePrefixSha8: prefixDigest,
  };
}

function transformResponses(payload: JsonObject): { payload?: JsonObject; stats: Stats } {
  if (!Array.isArray(payload.input)) return { stats: { applied: false, api: "responses", model: payload.model, reason: "input is not array" } };
  if (!supportsGptImages(payload.model)) return { stats: { applied: false, api: "responses", model: payload.model, reason: "model not allowlisted" } };
  const plan = planFrozenSections(responsesItemsToTurns(payload.input), "responses");
  if (plan.sections.length === 0) return { stats: planStats("responses", payload.model, plan) };

  const next = clone(payload);
  next.input = rebuildWithSections(payload.input, plan.sections, responsesSectionItem);

  return {
    payload: next,
    stats: planStats("responses", payload.model, plan),
  };
}

function transformChat(payload: JsonObject): { payload?: JsonObject; stats: Stats } {
  if (!Array.isArray(payload.messages)) return { stats: { applied: false, api: "chat", model: payload.model, reason: "messages is not array" } };
  if (!supportsGptImages(payload.model)) return { stats: { applied: false, api: "chat", model: payload.model, reason: "model not allowlisted" } };
  const plan = planFrozenSections(chatMessagesToTurns(payload.messages), "chat");
  if (plan.sections.length === 0) return { stats: planStats("chat", payload.model, plan) };

  const next = clone(payload);
  next.messages = rebuildWithSections(payload.messages, plan.sections, chatSectionMessage);

  return {
    payload: next,
    stats: planStats("chat", payload.model, plan),
  };
}

function maybeDumpPayload(payload: unknown, label: string): void {
  if (!dumpNext) return;
  mkdirSync(LOG_DIR, { recursive: true });
  const file = join(LOG_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}-${label}.json`);
  appendFileSync(file, JSON.stringify(payload, null, 2), "utf8");
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("gptimg", {
    description: "Compress old GPT/OpenAI request context into PNG image blocks: on|off|status|dump-next",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase() || "status";
      if (arg === "on") enabled = true;
      else if (arg === "off") enabled = false;
      else if (arg === "dump-next") dumpNext = true;
      else if (arg !== "status") {
        ctx.ui.notify("Usage: /gptimg [on|off|status|dump-next]", "warning");
        return;
      }

      updateStatus(ctx as unknown as ExtensionContext);
      ctx.ui.notify(
        `gptimg: ${enabled ? "on" : "off"}; last=${lastStats.applied ? `${lastStats.api}, ${lastStats.imageCount} image(s), ${lastStats.collapsedItems} item(s)` : lastStats.reason}; logs=${LOG_DIR}`,
        "info",
      );
    },
  });

  pi.on("session_start", (_event, ctx) => updateStatus(ctx));

  pi.on("before_provider_request", (event, ctx) => {
    if (!enabled) return;
    if (!isObject(event.payload)) {
      record({ applied: false, api: "unknown", reason: "payload is not object" }, ctx);
      return;
    }

    maybeDumpPayload(event.payload, "before");
    const result: TransformResult = Array.isArray(event.payload.input)
      ? transformResponses(event.payload)
      : Array.isArray(event.payload.messages)
        ? transformChat(event.payload)
        : { payload: undefined, stats: { applied: false, api: "unknown" as const, model: event.payload.model, reason: "not OpenAI payload" } };

    record(result.stats, ctx);
    if (!result.payload) return;
    maybeDumpPayload(result.payload, "after");
    dumpNext = false;
    return result.payload;
  });
}
