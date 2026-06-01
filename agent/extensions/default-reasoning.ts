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

function isGptModel(model: ModelLike | undefined): boolean {
  if (!model) return false;

  const provider = model.provider.toLowerCase();
  const id = model.id.toLowerCase();
  return provider.includes("openai") || provider.includes("codex") || id.includes("gpt");
}

function hasConversationEntries(ctx: { sessionManager: { getEntries(): Array<{ type?: string }> } }): boolean {
  return ctx.sessionManager.getEntries().some((entry) => entry.type === "message");
}

const CACHE_WARNING_WIDGET_ID = "gpt-cache-warning";

function clearCacheWarning(ctx: any) {
  ctx.ui.setWidget(CACHE_WARNING_WIDGET_ID, undefined);
}

function showThinkingCacheWarning(ctx: any, level: ThinkingLevel) {
  queueMicrotask(() => {
    ctx.ui.notify(`Thinking level: ${level} • Context cache will be invalidated`, "info");
  });
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
  let suppressNextThinkingWarning = false;
  let sessionInitialThinkingLevel: ThinkingLevel | undefined;
  let sessionInitialModel: ModelLike | undefined;
  let pendingModelWarningTimer: ReturnType<typeof setTimeout> | undefined;

  pi.on("session_start", (_event, ctx) => {
    sessionInitialThinkingLevel = pi.getThinkingLevel();
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
      if (!sameModel(event.model, sessionInitialModel)) {
        pendingModelWarningTimer = showModelCacheWarning(ctx, event.model, () => pi.getThinkingLevel());
      }
    }

    if (event.source === "restore") return;

    if (!event.model.reasoning) {
      if (pi.getThinkingLevel() !== "off") suppressNextThinkingWarning = true;
      pi.setThinkingLevel("off");
      return;
    }

    const defaultLevel = getDefaultThinkingLevel(event.model.provider, event.model.id);
    if (!defaultLevel) return;

    if (pi.getThinkingLevel() !== defaultLevel) suppressNextThinkingWarning = true;
    pi.setThinkingLevel(defaultLevel);
  });

  pi.on("thinking_level_select", (event, ctx) => {
    if (suppressNextThinkingWarning) {
      suppressNextThinkingWarning = false;
      return;
    }

    if (!event.previousLevel || event.previousLevel === event.level) return;
    if (sessionInitialThinkingLevel && event.level === sessionInitialThinkingLevel) {
      clearCacheWarning(ctx);
      return;
    }
    if (!hasConversationEntries(ctx) || !isGptModel(ctx.model)) return;

    clearCacheWarning(ctx);
    showThinkingCacheWarning(ctx, event.level);
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
