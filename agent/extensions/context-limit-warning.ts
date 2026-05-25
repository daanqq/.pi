import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const THRESHOLD_TOKENS = 128_000;

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(Math.round(tokens));
}

export default function (pi: ExtensionAPI) {
  let wasAboveThreshold = false;

  pi.on("agent_end", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    const usage = ctx.getContextUsage();
    if (!usage) return;

    const isAboveThreshold = usage.tokens > THRESHOLD_TOKENS;
    if (!isAboveThreshold) {
      wasAboveThreshold = false;
      return;
    }

    if (wasAboveThreshold) return;
    wasAboveThreshold = true;

    ctx.ui.notify(
      `Context usage crossed ${formatTokens(THRESHOLD_TOKENS)}. Consider /compact or /new.`,
      "warning",
    );
  });
}
