import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

type ModelLike = {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
};

function getDefaultThinkingLevel(provider: string, modelId: string): ThinkingLevel | undefined {
  const normalizedProvider = provider.toLowerCase();
  const normalizedModelId = modelId.toLowerCase();

  if (
    normalizedProvider.includes("deepseek") ||
    normalizedModelId.includes("deepseek") ||
    normalizedProvider.includes("xiaomi") ||
    normalizedModelId.includes("xiaomi") ||
    normalizedModelId.includes("gpt-5.4-mini")
  ) {
    return "high";
  }

  if (normalizedModelId.includes("gpt")) {
    return "low";
  }

  return undefined;
}

function hasConversationEntries(ctx: { sessionManager: { getEntries(): Array<{ type?: string }> } }): boolean {
  return ctx.sessionManager.getEntries().some((entry) => entry.type === "message");
}

const CACHE_WARNING_WIDGET_ID = "gpt-cache-warning";
const CONTEXT_CACHE_TTL_MS = 10 * 60 * 1000;

type SessionEntryLike = {
  type?: string;
  timestamp?: string | number;
  message?: { role?: string };
};

function clearCacheWarning(ctx: any) {
  ctx.ui.setWidget(CACHE_WARNING_WIDGET_ID, undefined);
}

function entryTimestampMs(entry: SessionEntryLike): number | undefined {
  if (typeof entry.timestamp === "number") return Number.isFinite(entry.timestamp) ? entry.timestamp : undefined;
  if (typeof entry.timestamp !== "string") return undefined;

  const timestamp = Date.parse(entry.timestamp);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function lastAssistantResponseTimestampMs(ctx: { sessionManager: { getEntries(): SessionEntryLike[] } }): number | undefined {
  const entries = ctx.sessionManager.getEntries();
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type === "message" && entry.message?.role === "assistant") {
      return entryTimestampMs(entry);
    }
  }

  return undefined;
}

function isContextCacheAlreadyExpiredByTime(ctx: { sessionManager: { getEntries(): SessionEntryLike[] } }): boolean {
  const lastResponseTimestamp = lastAssistantResponseTimestampMs(ctx);
  return lastResponseTimestamp !== undefined && Date.now() - lastResponseTimestamp >= CONTEXT_CACHE_TTL_MS;
}

function sameModel(a: ModelLike | undefined, b: ModelLike | undefined) {
  return Boolean(a && b && a.provider === b.provider && a.id === b.id);
}

function showModelCacheWarning(ctx: any, model: ModelLike, getThinkingLevel: () => ThinkingLevel) {
  return setTimeout(() => {
    const thinkingLevel = getThinkingLevel();
    const thinking = model.reasoning && thinkingLevel !== "off" ? ` (thinking: ${thinkingLevel})` : "";
    ctx.ui.notify(`Switched to ${model.name || model.id}${thinking} • Context cache will be invalidated`, "info");
  }, 0);
}

export default function defaultReasoningExtension(pi: ExtensionAPI) {
  let sessionInitialModel: ModelLike | undefined;
  let pendingModelWarningTimer: ReturnType<typeof setTimeout> | undefined;

  pi.on("session_start", (_event, ctx) => {
    sessionInitialModel = ctx.model;
  });

  pi.on("model_select", (event, ctx) => {
    const modelActuallyChanged =
      !event.previousModel ||
      event.previousModel.provider !== event.model.provider ||
      event.previousModel.id !== event.model.id;

    if (pendingModelWarningTimer) {
      clearTimeout(pendingModelWarningTimer);
      pendingModelWarningTimer = undefined;
    }

    if (
      event.source !== "restore" &&
      event.previousModel &&
      modelActuallyChanged &&
      hasConversationEntries(ctx)
    ) {
      clearCacheWarning(ctx);
      if (!sameModel(event.model, sessionInitialModel) && !isContextCacheAlreadyExpiredByTime(ctx)) {
        pendingModelWarningTimer = showModelCacheWarning(ctx, event.model, () => pi.getThinkingLevel());
      }
    }

    if (event.source === "restore") return;

    if (!event.model.reasoning) {
      pi.setThinkingLevel("off");
      return;
    }

    const defaultLevel = getDefaultThinkingLevel(event.model.provider, event.model.id);
    if (!defaultLevel) return;

    pi.setThinkingLevel(defaultLevel);
  });

  pi.on("before_agent_start", (_event, ctx) => {
    if (pendingModelWarningTimer) {
      clearTimeout(pendingModelWarningTimer);
      pendingModelWarningTimer = undefined;
    }
    clearCacheWarning(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (pendingModelWarningTimer) {
      clearTimeout(pendingModelWarningTimer);
      pendingModelWarningTimer = undefined;
    }
    clearCacheWarning(ctx);
  });
}
