import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

function getDefaultThinkingLevel(provider: string, modelId: string): ThinkingLevel | undefined {
  const normalizedProvider = provider.toLowerCase();
  const normalizedModelId = modelId.toLowerCase();

  if (normalizedProvider.includes("deepseek")) {
    return "max";
  }

  if (normalizedModelId.includes("gpt")) {
    return "low";
  }

  return undefined;
}

export default function defaultReasoningExtension(pi: ExtensionAPI) {
  pi.on("model_select", (event) => {
    // При восстановлении сессии не переопределяем сохранённый уровень мышления.
    if (event.source === "restore") return;

    if (!event.model.reasoning) {
      pi.setThinkingLevel("off");
      return;
    }

    const defaultLevel = getDefaultThinkingLevel(event.model.provider, event.model.id);
    if (defaultLevel) pi.setThinkingLevel(defaultLevel);
  });
}
