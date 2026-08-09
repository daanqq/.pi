import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fetchPoolQuota, formatPoolDetails, formatPoolFooter, type PoolQuota } from "./quota.ts";
import { findAuthForTrace } from "./binding.ts";

const EXTENSION_ID = "cliproxy-quota";
const PROVIDER_ID = "cliproxy";
const REFRESH_MS = 60_000;
const SYSTEMD_UNIT = process.env.CLIPROXY_SYSTEMD_UNIT ?? "cliproxyapi.service";

export function isCLIProxyProvider(provider: string | undefined): boolean {
	return provider === PROVIDER_ID;
}

function isCLIProxyModel(ctx: ExtensionContext | ExtensionCommandContext): boolean {
	return isCLIProxyProvider(ctx.model?.provider);
}

export default function cliproxyQuotaExtension(pi: ExtensionAPI) {
	let activeContext: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let refreshInFlight: Promise<PoolQuota> | undefined;
	let lastPool: PoolQuota | undefined;
	let selectedProvider: string | undefined;
	let currentAuthName: string | undefined;
	let bindingGeneration = 0;

	function clearStatus(ctx: ExtensionContext | ExtensionCommandContext): void {
		if (ctx.hasUI) ctx.ui.setStatus(EXTENSION_ID, undefined);
	}

	function render(ctx: ExtensionContext | ExtensionCommandContext, pool: PoolQuota, provider = ctx.model?.provider): void {
		if (!ctx.hasUI || provider !== selectedProvider || !isCLIProxyProvider(provider)) {
			clearStatus(ctx);
			return;
		}
		ctx.ui.setStatus(EXTENSION_ID, formatPoolFooter(pool, currentAuthName));
	}

	async function load(): Promise<PoolQuota> {
		if (refreshInFlight) return refreshInFlight;
		refreshInFlight = fetchPoolQuota().finally(() => {
			refreshInFlight = undefined;
		});
		return refreshInFlight;
	}

	async function refresh(ctx: ExtensionContext, provider = ctx.model?.provider): Promise<void> {
		if (ctx !== activeContext || provider !== selectedProvider || !isCLIProxyProvider(provider)) {
			clearStatus(ctx);
			return;
		}
		try {
			lastPool = await load();
			if (ctx === activeContext) render(ctx, lastPool, provider);
		} catch {
			if (ctx === activeContext && isCLIProxyModel(ctx)) {
				ctx.ui.setStatus(EXTENSION_ID, "quota unavailable");
			}
		}
	}

	pi.registerCommand("cliproxy:quota", {
		description: "Show combined Codex quota for CLIProxyAPI accounts",
		handler: async (_args, ctx) => {
			try {
				lastPool = await load();
				render(ctx, lastPool);
				ctx.ui.notify(formatPoolDetails(lastPool, currentAuthName), lastPool.errors.length > 0 ? "warning" : "info");
			} catch (error) {
				ctx.ui.notify(`CLIProxyAPI quota unavailable: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.registerCommand("statuses", {
		description: "Show quota status for every CLIProxyAPI Codex subscription",
		handler: async (_args, ctx) => {
			try {
				lastPool = await load();
				render(ctx, lastPool);
				ctx.ui.notify(ctx.ui.theme.fg("dim", formatPoolDetails(lastPool, currentAuthName)), lastPool.errors.length > 0 ? "warning" : "info");
			} catch (error) {
				ctx.ui.notify(`CLIProxyAPI quota unavailable: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		activeContext = ctx;
		selectedProvider = ctx.model?.provider;
		currentAuthName = undefined;
		bindingGeneration += 1;
		if (timer) clearInterval(timer);
		timer = setInterval(() => void refresh(ctx, selectedProvider), REFRESH_MS);
		timer.unref?.();
		if (isCLIProxyModel(ctx)) void refresh(ctx);
		else clearStatus(ctx);
	});

	pi.on("model_select", (event, ctx) => {
		const provider = event.model.provider;
		selectedProvider = provider;
		currentAuthName = undefined;
		bindingGeneration += 1;
		if (!isCLIProxyProvider(provider)) {
			clearStatus(ctx);
			return;
		}
		const uiContext = activeContext ?? ctx;
		if (lastPool) render(uiContext, lastPool, provider);
		void refresh(uiContext, provider);
	});

	pi.on("after_provider_response", (event) => {
		if (!isCLIProxyProvider(selectedProvider)) return;
		const traceId = event.headers["x-cpa-trace-id"] ?? event.headers["X-Cpa-Trace-Id"];
		if (!traceId) return;
		const generation = bindingGeneration;

		void (async () => {
			for (const delay of [0, 75, 200]) {
				if (generation !== bindingGeneration) return;
				if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
				const result = await pi.exec("journalctl", [
					"--user",
					"-u",
					SYSTEMD_UNIT,
					"--since=-2min",
					"--no-pager",
					"-o",
					"cat",
				], { timeout: 2_000 });
				const authName = findAuthForTrace(result.stdout, traceId);
				if (!authName) continue;
				if (generation !== bindingGeneration) return;
				currentAuthName = authName;
				if (activeContext && lastPool && isCLIProxyProvider(selectedProvider)) {
					render(activeContext, lastPool, selectedProvider);
				}
				return;
			}
		})().catch(() => {
			// If journald is unavailable, leave the current subscription unknown.
		});
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (timer) clearInterval(timer);
		timer = undefined;
		activeContext = undefined;
		selectedProvider = undefined;
		currentAuthName = undefined;
		bindingGeneration += 1;
		refreshInFlight = undefined;
		clearStatus(ctx);
	});
}
