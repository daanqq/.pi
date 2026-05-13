import { dirname, join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";

const PI_QUOTAS_COMMANDS_PATH = join(
  dirname(dirname(process.execPath)),
  "lib",
  "node_modules",
  "@latentminds",
  "pi-quotas",
  "src",
  "extensions",
  "command-quotas",
  "command.ts",
);

type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];

async function runCapturedCommand(
  commandName: string,
  args: string,
  ctx: ExtensionCommandContext,
): Promise<boolean> {
  const commandModule = (await import(PI_QUOTAS_COMMANDS_PATH)) as {
    registerQuotasCommands: (pi: ExtensionAPI) => void;
  };

  let handler: CommandOptions["handler"] | undefined;
  const capturePi = {
    registerCommand(name: string, options: CommandOptions) {
      if (name === commandName) handler = options.handler;
    },
  } as ExtensionAPI;

  commandModule.registerQuotasCommands(capturePi);

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
}
