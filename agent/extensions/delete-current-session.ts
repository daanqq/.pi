import { unlink } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const COMMAND = "delete";

async function deleteCurrentSession(ctx: ExtensionContext | ExtensionCommandContext) {
  if ("waitForIdle" in ctx) {
    await ctx.waitForIdle();
  } else if (!ctx.isIdle()) {
    ctx.ui.notify("Wait for the agent to finish before deleting the session", "warning");
    return;
  }

  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) {
    ctx.ui.notify("Current session is not persisted", "warning");
    return;
  }

  const ok = await ctx.ui.confirm(
    "Delete current session?",
    "This will start a new session and remove the current one from history.",
  );
  if (!ok) return;

  if ("newSession" in ctx) {
    const result = await ctx.newSession({
      withSession: async (newCtx) => {
        newCtx.ui.notify("Started a new session", "info");
      },
    });
    if (result.cancelled) return;

    try {
      await unlink(sessionFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return;
  }

  // ponytail: shortcut contexts cannot switch sessions; delete and exit instead.
  try {
    await unlink(sessionFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  ctx.ui.notify("Deleted current session; exiting", "info");
  ctx.shutdown();
}

export default function deleteCurrentSessionExtension(pi: ExtensionAPI) {
  pi.registerCommand(COMMAND, {
    description: "Delete the current session after confirmation",
    handler: async (_args, ctx) => deleteCurrentSession(ctx),
  });

  pi.registerShortcut("delete", {
    description: "Delete current session",
    handler: async (ctx) => {
      await deleteCurrentSession(ctx);
    },
  });
}
