import { unlink } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const COMMAND = "delete";
const QUIT_COMMAND_RE = /^\/(?:quit|q)\s*$/;

type WritableSessionManager = {
  appendSessionInfo?: (name: string) => string;
};

declare global {
  var __piBeforeEditorSubmit: ((text: string) => boolean | Promise<boolean>) | undefined;
}

async function unlinkIfExists(path: string) {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

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

    await unlinkIfExists(sessionFile);
    return;
  }

  // ponytail: shortcut contexts cannot switch sessions; delete and exit instead.
  await unlinkIfExists(sessionFile);
  ctx.ui.notify("Deleted current session; exiting", "info");
  ctx.shutdown();
}

async function handleQuitUnnamedSession(ctx: ExtensionContext) {
  const hasConversation = ctx.sessionManager.getEntries().some((entry) => (
    entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant")
  ));
  if (!hasConversation) {
    ctx.shutdown();
    return;
  }

  if (ctx.sessionManager.getSessionName()) {
    ctx.shutdown();
    return;
  }

  const choice = await ctx.ui.select("Unnamed session", [
    "Delete and quit",
    "Name and quit",
    "Quit without deleting",
    "Cancel",
  ]);

  if (choice === "Delete and quit") {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (sessionFile) await unlinkIfExists(sessionFile);
    ctx.shutdown();
    return;
  }

  if (choice === "Name and quit") {
    const name = await ctx.ui.input("Session name:", "");
    const trimmedName = name?.replace(/\s+/g, " ").trim();
    if (!trimmedName) return;

    const sessionManager = ctx.sessionManager as WritableSessionManager;
    sessionManager.appendSessionInfo?.(trimmedName);
    ctx.shutdown();
    return;
  }

  if (choice === "Quit without deleting") {
    ctx.shutdown();
  }
}

export default function sessionHygieneExtension(pi: ExtensionAPI) {
  let activeCtx: ExtensionContext | undefined;

  pi.registerCommand(COMMAND, {
    description: "Delete the current session after confirmation",
    handler: async (_args, ctx) => deleteCurrentSession(ctx),
  });

  pi.on("session_start", (_event, ctx) => {
    activeCtx = ctx;
    globalThis.__piBeforeEditorSubmit = async (text) => {
      if (!QUIT_COMMAND_RE.test(text)) return false;
      if (!activeCtx?.hasUI || !activeCtx.isIdle()) return false;

      await handleQuitUnnamedSession(activeCtx);
      return true;
    };
  });

  pi.on("input", async (event, ctx) => {
    if (!QUIT_COMMAND_RE.test(event.text)) return { action: "continue" };
    if (!ctx.hasUI || !ctx.isIdle()) return { action: "continue" };

    await handleQuitUnnamedSession(ctx);
    return { action: "handled" };
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (activeCtx === ctx) activeCtx = undefined;
    if (!activeCtx) globalThis.__piBeforeEditorSubmit = undefined;
  });
}
