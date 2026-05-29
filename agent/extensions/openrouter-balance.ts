import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const BALANCE_URL = "https://openrouter.ai/api/v1/credits";
const PROVIDER_ID = "openrouter";
const AUTH_PATH = join(homedir(), ".pi", "agent", "auth.json");
const STATUS_ID = "openrouter-balance";
const REFRESH_INTERVAL_MS = 60_000;

type OpenRouterBalanceResponse = {
  data?: {
    total_credits?: number;
    total_usage?: number;
  };
  error?: {
    message?: string;
    code?: number;
  };
};

function isOpenRouterContext(ctx: ExtensionContext) {
  return ctx.model?.provider === "openrouter" || ctx.model?.id?.startsWith("openrouter/");
}

function getOpenRouterApiKey() {
  try {
    const data = JSON.parse(readFileSync(AUTH_PATH, "utf8")) as Record<string, any>;
    const credential = data?.[PROVIDER_ID];
    const key = credential?.key ?? credential?.apiKey ?? credential?.token;
    if (typeof key === "string" && key.length > 0) return key;
  } catch {
    // Missing or malformed auth file is handled by the caller.
  }

  return undefined;
}

function formatAmount(value: number | undefined) {
  if (value === undefined) return "unknown";
  return `$${value.toFixed(2)}`;
}

function formatBalance(data: OpenRouterBalanceResponse) {
  if (data.error?.message) {
    return `OpenRouter balance error: ${data.error.message}`;
  }

  const credits = data.data?.total_credits;
  const usage = data.data?.total_usage;

  if (credits === undefined) {
    return "OpenRouter: no balance data available";
  }

  const remaining = credits - (usage ?? 0);
  return `OpenRouter: ${formatAmount(remaining)} remaining (credits: ${formatAmount(credits)}, used: ${formatAmount(usage)})`;
}

function formatFooterBalance(ctx: Pick<ExtensionContext, "ui">, data: OpenRouterBalanceResponse) {
  const theme = ctx.ui.theme;

  if (data.error?.message) return theme.fg("warning", "openrouter balance unavailable");

  const credits = data.data?.total_credits;
  const usage = data.data?.total_usage;

  if (credits === undefined) return theme.fg("warning", "openrouter balance unavailable");

  const remaining = credits - (usage ?? 0);
  return theme.fg("success", formatAmount(remaining));
}

async function fetchOpenRouterBalance(apiKey: string): Promise<OpenRouterBalanceResponse> {
  const response = await fetch(BALANCE_URL, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
  });

  let data: OpenRouterBalanceResponse;
  try {
    data = (await response.json()) as OpenRouterBalanceResponse;
  } catch {
    data = {};
  }

  if (!response.ok && !data.error?.message) {
    return { error: { message: `HTTP ${response.status} ${response.statusText}`.trim(), code: response.status } };
  }

  return data;
}

function createBalanceRefresher() {
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let activeContext: ExtensionContext | undefined;
  let lastBalance: OpenRouterBalanceResponse | undefined;
  let inFlight = false;
  let queued = false;

  async function update(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI || !isOpenRouterContext(ctx)) return;

    const apiKey = getOpenRouterApiKey();
    if (!apiKey) {
      ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("warning", "set openrouter auth"));
      return;
    }

    if (inFlight) {
      queued = true;
      return;
    }

    inFlight = true;
    try {
      const balance = await fetchOpenRouterBalance(apiKey);
      if (!balance.error?.message) lastBalance = balance;
      if (activeContext !== ctx || !isOpenRouterContext(ctx)) return;
      ctx.ui.setStatus(STATUS_ID, formatFooterBalance(ctx, balance));
    } catch {
      if (activeContext !== ctx || !isOpenRouterContext(ctx)) return;
      ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("warning", "openrouter balance unavailable"));
    } finally {
      inFlight = false;
      if (queued) {
        queued = false;
        void update(ctx);
      }
    }
  }

  return {
    refreshFor(ctx: ExtensionContext): void {
      activeContext = ctx;
      if (!ctx.hasUI || !isOpenRouterContext(ctx)) {
        ctx.ui.setStatus(STATUS_ID, undefined);
        return;
      }
      if (lastBalance) ctx.ui.setStatus(STATUS_ID, formatFooterBalance(ctx, lastBalance));
      void update(ctx);
    },
    remember(balance: OpenRouterBalanceResponse): void {
      if (!balance.error?.message) lastBalance = balance;
    },
    start(): void {
      if (refreshTimer) clearInterval(refreshTimer);
      refreshTimer = setInterval(() => {
        if (activeContext) void update(activeContext);
      }, REFRESH_INTERVAL_MS);
      refreshTimer.unref?.();
    },
    stop(ctx?: ExtensionContext): void {
      if (refreshTimer) clearInterval(refreshTimer);
      refreshTimer = undefined;
      activeContext = undefined;
      ctx?.ui.setStatus(STATUS_ID, undefined);
    },
  };
}

export default function openRouterBalanceExtension(pi: ExtensionAPI) {
  const refresher = createBalanceRefresher();

  pi.on("session_start", (_event, ctx) => {
    refresher.start();
    refresher.refreshFor(ctx);
  });

  pi.on("turn_end", (_event, ctx) => {
    refresher.refreshFor(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    refresher.refreshFor(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    refresher.stop(ctx);
  });

  pi.registerCommand("openrouter:balance", {
    description: "Check OpenRouter API balance using ~/.pi/agent/auth.json",
    handler: async (_args, ctx) => {
      const apiKey = getOpenRouterApiKey();
      if (!apiKey) {
        ctx.ui.notify("Set openrouter.key in ~/.pi/agent/auth.json to check OpenRouter balance", "error");
        return;
      }

      try {
        const balance = await fetchOpenRouterBalance(apiKey);
        refresher.remember(balance);
        ctx.ui.notify(formatBalance(balance), balance.error ? "error" : "info");
        if (ctx.hasUI && isOpenRouterContext(ctx)) {
          ctx.ui.setStatus(STATUS_ID, formatFooterBalance(ctx, balance));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`OpenRouter balance request failed: ${message}`, "error");
      }
    },
  });
}
