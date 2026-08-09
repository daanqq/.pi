import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { parseCodexWindows, resetText } from "../codex-usage/quota.ts";

const AUTH_DIR = process.env.CLIPROXY_AUTH_DIR ?? join(homedir(), ".cli-proxy-api");
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const FETCH_TIMEOUT_MS = 15_000;

type WindowLabel = "5h" | "7d" | "30d";

type ProxyAuthFile = {
	access_token?: string;
	account_id?: string;
	disabled?: boolean;
	email?: string;
	type?: string;
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

export function minimumSubscriptionRemaining(accounts: AccountQuota[]): number | undefined {
	const values = accounts.flatMap((account) => Object.values(account.windows).flatMap((window) =>
		window ? [window.remaining] : [],
	));
	return values.length > 0 ? Math.min(...values) : undefined;
}

export function currentSubscriptionRemaining(pool: PoolQuota, authName: string | undefined): number | undefined {
	if (!authName) return undefined;
	const account = pool.accounts.find((candidate) => candidate.name === authName);
	return account ? minimumSubscriptionRemaining([account]) : undefined;
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

async function listAuthFiles(): Promise<Array<{ name: string; auth: ProxyAuthFile }>> {
	const entries = await readdir(AUTH_DIR, { withFileTypes: true });
	const files = entries.filter((entry) => entry.isFile() && entry.name.startsWith("codex-") && entry.name.endsWith(".json"));
	const authFiles = await Promise.all(files.map(async (entry) => {
		const data = JSON.parse(await readFile(join(AUTH_DIR, entry.name), "utf8")) as ProxyAuthFile;
		return { name: entry.name, auth: data };
	}));
	return authFiles.filter(({ auth }) => auth.type === "codex" && !auth.disabled);
}

async function fetchAccountQuota(name: string, auth: ProxyAuthFile): Promise<AccountQuota> {
	if (!auth.access_token) throw new Error(`${name}: access token is missing`);
	if (!auth.account_id) throw new Error(`${name}: account id is missing`);

	const response = await fetch(USAGE_URL, {
		headers: {
			Authorization: `Bearer ${auth.access_token}`,
			"ChatGPT-Account-Id": auth.account_id,
			Accept: "application/json",
			Origin: "https://chatgpt.com",
			Referer: "https://chatgpt.com/",
			"User-Agent": "Mozilla/5.0",
		},
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});

	if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
	const data = await response.json();
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

export async function fetchPoolQuota(): Promise<PoolQuota> {
	const authFiles = await listAuthFiles();
	if (authFiles.length === 0) throw new Error(`No enabled Codex accounts found in ${AUTH_DIR}`);

	const results = await Promise.allSettled(authFiles.map(({ name, auth }) => fetchAccountQuota(name, auth)));
	const accounts: AccountQuota[] = [];
	const errors: string[] = [];
	for (const result of results) {
		if (result.status === "fulfilled") accounts.push(result.value);
		else errors.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
	}

	if (accounts.length === 0) throw new Error(errors.join("; ") || "Codex quota is unavailable");
	return aggregatePoolQuota(authFiles.length, accounts, errors);
}

export function formatPoolFooter(pool: PoolQuota, currentAuthName?: string): string {
	const accountCount = pool.availableAccounts === pool.totalAccounts
		? `${pool.totalAccounts}subs`
		: `${pool.availableAccounts}/${pool.totalAccounts}`;
	const parts = [accountCount];
	if (pool.windows["5h"]) parts.push(`5h:${Math.round(pool.windows["5h"].remaining)}%`);
	if (pool.windows["7d"]) parts.push(`7d:${Math.round(pool.windows["7d"].remaining)}%`);
	if (pool.windows["30d"]) parts.push(`30d:${Math.round(pool.windows["30d"].remaining)}%`);
	const current = currentSubscriptionRemaining(pool, currentAuthName);
	parts.push(current === undefined ? "cur:?" : `cur:${Math.round(current)}%`);
	return parts.join(" ");
}

export function formatPoolDetails(pool: PoolQuota, currentAuthName?: string): string {
	const lines = pool.accounts.flatMap((account, index) => {
		const accountLines = [
			`${account.name === currentAuthName ? "* " : ""}subscription ${index + 1}`,
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
