import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

const BALANCE_URL = "https://api.deepseek.com/user/balance";
const API_KEY_ENV = "DEEPSEEK_PI_API_KEY";
const STATUS_ID = "deepseek-balance";
const REFRESH_INTERVAL_MS = 60_000;

type DeepSeekBalanceInfo = {
  currency?: string;
  total_balance?: string;
  granted_balance?: string;
  topped_up_balance?: string;
};

type DeepSeekBalanceResponse = {
  is_available?: boolean;
  balance_infos?: DeepSeekBalanceInfo[];
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
};

function isDeepSeekContext(ctx: ExtensionContext) {
  return ctx.model?.provider === "deepseek" || ctx.model?.id?.startsWith("deepseek/");
}

function parseAmount(value: string | undefined) {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatAmount(currency: string | undefined, value: string | undefined) {
  const amount = parseAmount(value);
  const unit = currency ?? "balance";
  if (amount === undefined) return `${unit} ${value ?? "unknown"}`;
  if (currency === "USD") return `$${amount.toFixed(2)}`;
  return `${amount.toFixed(2)} ${unit}`;
}

function formatBalanceInfo(info: DeepSeekBalanceInfo) {
  const currency = info.currency ?? "unknown";
  const total = info.total_balance ?? "unknown";
  const granted = info.granted_balance ?? "unknown";
  const toppedUp = info.topped_up_balance ?? "unknown";

  return `${currency}: total ${total}, granted ${granted}, topped up ${toppedUp}`;
}

function formatBalance(data: DeepSeekBalanceResponse) {
  if (data.error?.message) {
    const type = data.error.type ? ` (${data.error.type})` : "";
    return `DeepSeek balance error${type}: ${data.error.message}`;
  }

  const availability =
    typeof data.is_available === "boolean"
      ? data.is_available
        ? "available"
        : "not available"
      : "availability unknown";

  const balances = data.balance_infos?.length
    ? data.balance_infos.map(formatBalanceInfo).join("\n")
    : "No balance rows returned.";

  return `DeepSeek account: ${availability}\n${balances}`;
}

function formatFooterBalance(ctx: ExtensionContext, data: DeepSeekBalanceResponse) {
  const theme = ctx.ui.theme;

  if (data.error?.message) {
    return theme.fg("warning", "deepseek balance unavailable");
  }

  if (data.is_available === false) {
    return `${theme.fg("dim", "deepseek:")}${theme.fg("warning", " unavailable")}`;
  }

  const balances = data.balance_infos ?? [];
  const preferred = balances.find((info) => info.currency === "USD") ?? balances[0];
  if (!preferred) return theme.fg("warning", "deepseek balance unavailable");

  return `${theme.fg("dim", "API Balance: ")}${theme.fg("success", formatAmount(preferred.currency, preferred.total_balance))}`;
}

async function fetchDeepSeekBalance(apiKey: string): Promise<DeepSeekBalanceResponse> {
  const response = await fetch(BALANCE_URL, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
  });

  let data: DeepSeekBalanceResponse;
  try {
    data = (await response.json()) as DeepSeekBalanceResponse;
  } catch {
    data = {};
  }

  if (!response.ok && !data.error?.message) {
    return {
      error: {
        message: `HTTP ${response.status} ${response.statusText}`.trim(),
      },
    };
  }

  return data;
}

function createBalanceRefresher() {
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let activeContext: ExtensionContext | undefined;
  let inFlight = false;
  let queued = false;

  async function update(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI || !isDeepSeekContext(ctx)) return;

    const apiKey = process.env[API_KEY_ENV];
    if (!apiKey) {
      ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("warning", `set ${API_KEY_ENV}`));
      return;
    }

    if (inFlight) {
      queued = true;
      return;
    }

    inFlight = true;
    try {
      const balance = await fetchDeepSeekBalance(apiKey);
      if (activeContext !== ctx || !isDeepSeekContext(ctx)) return;
      ctx.ui.setStatus(STATUS_ID, formatFooterBalance(ctx, balance));
    } catch {
      if (activeContext !== ctx || !isDeepSeekContext(ctx)) return;
      ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("warning", "deepseek balance unavailable"));
    } finally {
      inFlight = false;
      if (queued) {
        queued = false;
        void update(ctx);
      }
    }
  }

  return {
    async refreshFor(ctx: ExtensionContext): Promise<void> {
      activeContext = ctx;
      if (!ctx.hasUI || !isDeepSeekContext(ctx)) {
        ctx.ui.setStatus(STATUS_ID, undefined);
        return;
      }
      await update(ctx);
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

export default function deepSeekBalanceExtension(pi: ExtensionAPI) {
  const refresher = createBalanceRefresher();

  pi.on("session_start", async (_event, ctx) => {
    refresher.start();
    await refresher.refreshFor(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    await refresher.refreshFor(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    await refresher.refreshFor(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    refresher.stop(ctx);
  });

  pi.registerCommand("deepseek:balance", {
    description: `Check DeepSeek API balance using ${API_KEY_ENV}`,
    handler: async (_args, ctx) => {
      const apiKey = process.env[API_KEY_ENV];
      if (!apiKey) {
        ctx.ui.notify(`Set ${API_KEY_ENV} to check DeepSeek balance`, "error");
        return;
      }

      try {
        const balance = await fetchDeepSeekBalance(apiKey);
        ctx.ui.notify(formatBalance(balance), balance.error ? "error" : "info");
        if (ctx.hasUI && isDeepSeekContext(ctx)) {
          ctx.ui.setStatus(STATUS_ID, formatFooterBalance(ctx, balance));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`DeepSeek balance request failed: ${message}`, "error");
      }
    },
  });
}
