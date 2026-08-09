import assert from "node:assert/strict";
import test from "node:test";
import { aggregatePoolQuota, currentSubscriptionRemaining, formatPoolDetails, formatPoolFooter, minimumSubscriptionRemaining, type AccountQuota } from "./quota.ts";
import { isCLIProxyProvider } from "./index.ts";
import { findAuthForTrace, traceSuffix } from "./binding.ts";

function account(name: string, fiveHour: number, weekly: number): AccountQuota {
	return {
		name,
		windows: {
			"5h": { remaining: fiveHour, resetsAt: Date.now() + 60_000 },
			"7d": { remaining: weekly, resetsAt: Date.now() + 60_000 },
		},
	};
}

test("averages equal subscription capacity across two accounts", () => {
	const pool = aggregatePoolQuota(2, [account("one", 80, 40), account("two", 20, 60)]);
	assert.equal(pool.windows["5h"]?.remaining, 50);
	assert.equal(pool.windows["7d"]?.remaining, 50);
	assert.equal(minimumSubscriptionRemaining(pool.accounts), 20);
	assert.equal(formatPoolFooter(pool), "2subs 5h:50% 7d:50% cur:?");
	assert.equal(currentSubscriptionRemaining(pool, "two"), 20);
	assert.equal(formatPoolFooter(pool, "two"), "2subs 5h:50% 7d:50% cur:20%");
});

test("shows partial account availability instead of pretending the whole pool was measured", () => {
	const pool = aggregatePoolQuota(2, [account("one", 80, 40)], ["two: HTTP 401"]);
	assert.equal(formatPoolFooter(pool), "1/2 5h:80% 7d:40% cur:?");
});

test("uses the newly selected provider instead of stale context state", () => {
	const staleContextProvider = "openai-codex";
	const selectedEventProvider = "cliproxy";
	assert.equal(isCLIProxyProvider(staleContextProvider), false);
	assert.equal(isCLIProxyProvider(selectedEventProvider), true);
});

test("formats per-subscription status like the Codex quota command", () => {
	const pool = aggregatePoolQuota(1, [{
		...account("one", 80, 40),
		email: "one@example.com",
		planType: "plus",
		availableResetCount: 1,
	}]);
	const text = formatPoolDetails(pool);
	assert.match(text, /subscription 1/);
	assert.match(text, /email: one@example\.com/);
	assert.match(text, /5h window\n    remaining: 80%/);
	assert.match(text, /7d window\n    remaining: 40%/);
	assert.match(text, /available usage resets: 1/);
});

test("maps a CPA response trace to the auth selected by session affinity", () => {
	const traceId = "20260808205301-c377926964340d12-afdcfec2";
	const log = [
		"[other123] session-affinity: cache hit | session=x auth=wrong.json provider=mixed model=gpt",
		"[afdcfec2] session-affinity: cache hit | session=x auth=codex-second.json provider=mixed model=gpt",
	].join("\n");
	assert.equal(traceSuffix(traceId), "afdcfec2");
	assert.equal(findAuthForTrace(log, traceId), "codex-second.json");
});
