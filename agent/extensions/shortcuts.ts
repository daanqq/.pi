import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";

const CODEX_QUOTAS_EXTENSION_PATH = new URL("./codex-quotas.ts", import.meta.url).href;

type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];

async function runCapturedCommand(
  commandName: string,
  args: string,
  ctx: ExtensionCommandContext,
): Promise<boolean> {
  const commandModule = (await import(CODEX_QUOTAS_EXTENSION_PATH)) as {
    default: (pi: ExtensionAPI) => void;
  };

  let handler: CommandOptions["handler"] | undefined;
  const capturePi = {
    registerCommand(name: string, options: CommandOptions) {
      if (name === commandName) handler = options.handler;
    },
    on() {
      // Ignore lifecycle hooks while capturing the command handler.
    },
  } as unknown as ExtensionAPI;

  commandModule.default(capturePi);

  if (!handler) return false;
  await handler(args, ctx);
  return true;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("exit", {
    description: "Exit pi",
    handler: async (_args, ctx) => {
      ctx.shutdown();
    },
  });

  pi.registerCommand("q", {
    description: "Exit pi",
    handler: async (_args, ctx) => {
      ctx.shutdown();
    },
  });

  pi.registerCommand("e", {
    description: "Quit pi",
    handler: async (_args, ctx) => {
      ctx.shutdown();
    },
  });

  pi.registerCommand("status", {
    description: "Alias for /codex:quotas",
    handler: async (args, ctx) => {
      const executed = await runCapturedCommand("codex:quotas", args, ctx);
      if (!executed) {
        ctx.ui.notify("/codex:quotas command is not available", "warning");
      }
    },
  });

  pi.registerCommand("n", {
    description: "Alias for /new",
    handler: async (_args, ctx) => {
      await ctx.newSession();
    },
  });
}
