import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

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

  pi.registerCommand("n", {
    description: "Alias for /new",
    handler: async (_args, ctx) => {
      await ctx.newSession();
    },
  });
}
