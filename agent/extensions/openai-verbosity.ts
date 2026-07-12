import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER = "openai-codex";
const MODEL = "gpt-5.6-sol";

export default function (pi: ExtensionAPI) {
  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.provider !== PROVIDER || ctx.model.id !== MODEL) return;
    if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return;

    const payload = event.payload as Record<string, unknown>;
    const text = payload.text;

    return {
      ...payload,
      text: {
        ...(text && typeof text === "object" && !Array.isArray(text) ? text : {}),
        verbosity: "low",
      },
    };
  });
}
