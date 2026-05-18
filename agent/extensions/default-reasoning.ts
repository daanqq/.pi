import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

function getDefaultThinkingLevel(provider: string, modelId: string): ThinkingLevel | undefined {
  const normalizedProvider = provider.toLowerCase();
  const normalizedModelId = modelId.toLowerCase();

  if (normalizedProvider.includes("deepseek") || normalizedModelId.includes("deepseek")) {
    return "high";
  }

  if (normalizedModelId.includes("gpt-5.4-mini")) {
    return "medium";
  }

  if (normalizedModelId.includes("gpt")) {
    return "low";
  }

  return undefined;
}

export default function defaultReasoningExtension(pi: ExtensionAPI) {
  pi.on("model_select", (event) => {
    if (event.source === "restore") return;

    if (!event.model.reasoning) {
      pi.setThinkingLevel("off");
      return;
    }

    const defaultLevel = getDefaultThinkingLevel(event.model.provider, event.model.id);
    if (!defaultLevel) return;

    pi.setThinkingLevel(defaultLevel);
  });
}
