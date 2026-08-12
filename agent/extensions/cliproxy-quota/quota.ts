import { parseCodexWindows, resetText } from "../codex-usage/quota.ts";

const MANAGEMENT_URL = process.env.CLIPROXY_MANAGEMENT_URL ?? "http://127.0.0.1:8317";
const MANAGEMENT_KEY = process.env.CLIPROXY_MANAGEMENT_KEY ?? "";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const FETCH_TIMEOUT_MS = 15_000;

type WindowLabel = "5h" | "7d" | "30d";

type ManagementAuthFile = {
	auth_index?: string;
	authIndex?: string;
	disabled?: boolean;
	email?: string;
	id_token?: unknown;
	metadata?: { id_token?: unknown };
	attributes?: { id_token?: unknown };
	name?: string;
	provider?: string;
};

type ManagementAuthFilesResponse = { files?: ManagementAuthFile[] };
type ManagementApiCallResponse = { status_code?: number; body?: unknown };

export type ManagementQuotaOptions = {
	managementUrl?: string;
	managementKey?: string;
	fetchImpl?: typeof fetch;
};

export type AccountQuota = {
	name: string;
	email?: string;
	planType?: string;
	availableResetCount?: number;
	windows: Partial<Record<WindowLabel, { remaining: number; resetsAt: number }>>;
};

export type PoolQuota = {
	totalAccounts: number;
	availableAccounts: number;
	accounts: AccountQuota[];
	windows: Partial<Record<WindowLabel, { remaining: number }>>;
	errors: string[];
};

export function nearestPoolReset(accounts: AccountQuota[], now = Date.now()): number | undefined {
	const resets = accounts.flatMap((account) => Object.values(account.windows).flatMap((window) =>
		window && window.resetsAt > now ? [window.resetsAt] : [],
	));
	return resets.length > 0 ? Math.min(...resets) : undefined;
}

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, value));
}

export function aggregatePoolQuota(totalAccounts: number, accounts: AccountQuota[], errors: string[] = []): PoolQuota {
	const windows: PoolQuota["windows"] = {};
	for (const label of ["5h", "7d", "30d"] as const) {
		const values = accounts
			.map((account) => account.windows[label]?.remaining)
			.filter((value): value is number => value !== undefined);
		if (values.length > 0) {
			windows[label] = {
				remaining: clampPercent(values.reduce((sum, value) => sum + value, 0) / values.length),
			};
		}
	}

	return {
		totalAccounts,
		availableAccounts: accounts.length,
		accounts,
		windows,
		errors,
	};
}

function managementBaseUrl(url: string): string {
	const normalized = url.trim().replace(/\/+$/, "");
	return normalized.endsWith("/v0/management") ? normalized : `${normalized}/v0/management`;
}

function decodeJwtPayload(value: string): Record<string, unknown> | undefined {
	const payload = value.split(".")[1];
	if (!payload) return undefined;
	try {
		return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

function accountIdFromToken(value: unknown): string | undefined {
	const token = typeof value === "string" ? decodeJwtPayload(value) : value;
	if (!token || typeof token !== "object" || Array.isArray(token)) return undefined;
	const auth = (token as Record<string, unknown>)["https://api.openai.com/auth"];
	const source = auth && typeof auth === "object" && !Array.isArray(auth) ? auth : token;
	const accountId = (source as Record<string, unknown>).chatgpt_account_id
		?? (source as Record<string, unknown>).chatgptAccountId;
	return typeof accountId === "string" && accountId.trim() ? accountId.trim() : undefined;
}

function accountIdFromAuth(auth: ManagementAuthFile): string | undefined {
	for (const token of [auth.id_token, auth.metadata?.id_token, auth.attributes?.id_token]) {
		const accountId = accountIdFromToken(token);
		if (accountId) return accountId;
	}
	return undefined;
}

async function managementRequest<T>(
	baseUrl: string,
	managementKey: string,
	path: string,
	init: RequestInit,
	fetchImpl: typeof fetch,
): Promise<T> {
	const response = await fetchImpl(`${baseUrl}${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${managementKey}`,
			Accept: "application/json",
			...init.headers,
		},
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`Management API HTTP ${response.status}${body ? `: ${body}` : ""}`);
	}
	return response.json() as Promise<T>;
}

async function fetchAccountQuota(
	baseUrl: string,
	managementKey: string,
	auth: ManagementAuthFile,
	fetchImpl: typeof fetch,
): Promise<AccountQuota> {
	const name = auth.name ?? auth.email ?? "unknown Codex account";
	const authIndex = auth.auth_index ?? auth.authIndex;
	if (!authIndex) throw new Error(`${name}: auth_index is missing`);
	const accountId = accountIdFromAuth(auth);
	if (!accountId) throw new Error(`${name}: ChatGPT account id is missing`);

	const response = await managementRequest<ManagementApiCallResponse>(baseUrl, managementKey, "/api-call", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			auth_index: authIndex,
			method: "GET",
			url: USAGE_URL,
			header: {
				Authorization: "Bearer $TOKEN$",
				"Chatgpt-Account-Id": accountId,
				Accept: "application/json",
				"Content-Type": "application/json",
				"User-Agent": "codex_cli_rs/0.76.0",
			},
		}),
	}, fetchImpl);

	const statusCode = Number(response.status_code ?? 0);
	if (statusCode < 200 || statusCode >= 300) {
		throw new Error(`${name}: upstream HTTP ${statusCode || "unknown"}`);
	}
	let data: any;
	try {
		data = typeof response.body === "string" ? JSON.parse(response.body) : response.body;
	} catch {
		throw new Error(`${name}: invalid quota response`);
	}
	if (!data || typeof data !== "object") throw new Error(`${name}: empty quota response`);
	const windows = parseCodexWindows(data);
	if (windows.length === 0) throw new Error(`${name}: quota windows are missing`);
	const availableResetCount = Number(data?.rate_limit_reset_credits?.available_count);

	return {
		name,
		email: auth.email,
		planType: typeof data?.plan_type === "string" ? data.plan_type : undefined,
		availableResetCount: Number.isFinite(availableResetCount) && availableResetCount >= 0
			? Math.floor(availableResetCount)
			: undefined,
		windows: Object.fromEntries(windows.map((window) => [
			window.label,
			{ remaining: window.remainingPercent, resetsAt: window.resetsAt.getTime() },
		])),
	};
}

export async function fetchPoolQuotaFromManagement(options: ManagementQuotaOptions = {}): Promise<PoolQuota> {
	const managementUrl = options.managementUrl ?? MANAGEMENT_URL;
	const managementKey = options.managementKey ?? MANAGEMENT_KEY;
	const fetchImpl = options.fetchImpl ?? fetch;
	if (!managementUrl.trim()) throw new Error("CLIPROXY_MANAGEMENT_URL is empty");
	if (!managementKey.trim()) throw new Error("CLIPROXY_MANAGEMENT_KEY is empty");
	const baseUrl = managementBaseUrl(managementUrl);
	const response = await managementRequest<ManagementAuthFilesResponse>(
		baseUrl,
		managementKey,
		"/auth-files",
		{ method: "GET" },
		fetchImpl,
	);
	const authFiles = (response.files ?? []).filter((auth) => auth.provider === "codex" && !auth.disabled);
	if (authFiles.length === 0) throw new Error(`No enabled Codex accounts found at ${baseUrl}`);

	const results = await Promise.allSettled(authFiles.map((auth) =>
		fetchAccountQuota(baseUrl, managementKey, auth, fetchImpl),
	));
	const accounts: AccountQuota[] = [];
	const errors: string[] = [];
	for (const result of results) {
		if (result.status === "fulfilled") accounts.push(result.value);
		else errors.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
	}

	if (accounts.length === 0) throw new Error(errors.join("; ") || "Codex quota is unavailable");
	return aggregatePoolQuota(authFiles.length, accounts, errors);
}

export async function fetchPoolQuota(): Promise<PoolQuota> {
	return fetchPoolQuotaFromManagement();
}

export function formatPoolFooter(pool: PoolQuota): string {
	const accountCount = pool.availableAccounts === pool.totalAccounts
		? `${pool.totalAccounts}subs`
		: `${pool.availableAccounts}/${pool.totalAccounts}`;
	const parts = [accountCount];
	if (pool.windows["5h"]) parts.push(`5h:${Math.round(pool.windows["5h"].remaining)}%`);
	if (pool.windows["7d"]) parts.push(`7d:${Math.round(pool.windows["7d"].remaining)}%`);
	if (pool.windows["30d"]) parts.push(`30d:${Math.round(pool.windows["30d"].remaining)}%`);
	const nearestReset = nearestPoolReset(pool.accounts);
	if (nearestReset !== undefined) parts.push(`next:${resetText(new Date(nearestReset))}`);
	return parts.join(" ");
}

export function formatPoolDetails(pool: PoolQuota): string {
	const lines = pool.accounts.flatMap((account, index) => {
		const accountLines = [
			`subscription ${index + 1}`,
			`  email: ${account.email ?? "unknown"}`,
			`  plan: ${account.planType ?? "unknown"}`,
		];
		for (const label of ["5h", "7d", "30d"] as const) {
			const window = account.windows[label];
			if (!window) continue;
			accountLines.push(
				`  ${label} window`,
				`    remaining: ${Math.round(window.remaining)}%`,
				`    resets: in ${resetText(new Date(window.resetsAt))}`,
			);
		}
		accountLines.push(`  available usage resets: ${account.availableResetCount ?? "unknown"}`);
		return [...accountLines, ""];
	});
	if (pool.errors.length > 0) lines.push(`errors: ${pool.errors.join("; ")}`);
	return lines.join("\n").trimEnd();
}
