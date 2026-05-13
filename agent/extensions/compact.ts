import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const COMPACTION_THRESHOLD = 256_000;

export default function (pi: ExtensionAPI) {
  let compacting = false;

  pi.on("before_agent_start", async (_event, ctx) => {
    if (compacting) return;

    const usage = ctx.getContextUsage();
    if (!usage || usage.tokens <= COMPACTION_THRESHOLD) return;

    compacting = true;
    ctx.ui.notify(
      `Context ${usage.tokens} > ${COMPACTION_THRESHOLD}. Compacting...`,
      "info",
    );

    ctx.compact({
      customInstructions: "Be concise. Keep only critical context.",
      onComplete: () => {
        compacting = false;
      },
      onError: (err) => {
        compacting = false;
        ctx.ui.notify(`Compaction failed: ${err.message}`, "error");
      },
    });
  });
}
