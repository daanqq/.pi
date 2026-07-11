import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { generateBranchSummary } from "@earendil-works/pi-coding-agent";
import { streamSimple } from "@earendil-works/pi-ai/compat";

const PROVIDER = "openai-codex";
const MODEL_ID = "gpt-5.6-luna";

export default function (pi: ExtensionAPI) {
	pi.on("session_before_tree", async (event, ctx) => {
		const { preparation, signal } = event;
		if (!preparation.userWantsSummary || preparation.entriesToSummarize.length === 0) return;

		const model = ctx.modelRegistry.find(PROVIDER, MODEL_ID);
		if (!model) {
			ctx.ui.notify(`Branch summary model ${PROVIDER}/${MODEL_ID} is unavailable; using the current model.`, "warning");
			return;
		}

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) {
			const reason = auth.ok ? "no credentials" : auth.error;
			ctx.ui.notify(`Cannot use ${PROVIDER}/${MODEL_ID} for branch summary (${reason}); using the current model.`, "warning");
			return;
		}

		ctx.ui.notify(`Summarizing branch with ${PROVIDER}/${MODEL_ID}...`, "info");
		const result = await generateBranchSummary(preparation.entriesToSummarize, {
			model,
			apiKey: auth.apiKey,
			headers: auth.headers,
			 env: auth.env,
			 signal,
			streamFn: (model, context, options) =>
				streamSimple(model, context, { ...options, reasoning: "high" }),
		});

		if (result.aborted) return { cancel: true };
		if (result.error || !result.summary?.trim()) {
			ctx.ui.notify(
				`Branch summary with ${PROVIDER}/${MODEL_ID} failed${result.error ? `: ${result.error}` : "."} Using the current model.`,
				"warning",
			);
			return;
		}

		return {
			summary: {
				summary: result.summary,
				details: {
					readFiles: result.readFiles ?? [],
					modifiedFiles: result.modifiedFiles ?? [],
				},
			},
		};
	});
}
