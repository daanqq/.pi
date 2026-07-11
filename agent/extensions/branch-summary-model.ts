import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { generateBranchSummary } from "@earendil-works/pi-coding-agent";
import { streamSimple } from "@earendil-works/pi-ai/compat";

export default function (pi: ExtensionAPI) {
	pi.on("session_before_tree", async (event, ctx) => {
		const { preparation, signal } = event;
		if (!preparation.userWantsSummary || preparation.entriesToSummarize.length === 0) return;

		const model = ctx.model;
		if (!model) return;
		const modelName = `${model.provider}/${model.id}`;

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) {
			const reason = auth.ok ? "no credentials" : auth.error;
			ctx.ui.notify(`Cannot use ${modelName} for branch summary (${reason}).`, "warning");
			return;
		}

		ctx.ui.notify(`Summarizing branch with ${modelName} (reasoning: low)...`, "info");
		const result = await generateBranchSummary(preparation.entriesToSummarize, {
			model,
			apiKey: auth.apiKey,
			headers: auth.headers,
			 env: auth.env,
			 signal,
			streamFn: (model, context, options) =>
				streamSimple(model, context, { ...options, reasoning: "low" }),
		});

		if (result.aborted) return { cancel: true };
		if (result.error || !result.summary?.trim()) {
			ctx.ui.notify(
				`Branch summary with ${modelName} failed${result.error ? `: ${result.error}` : "."}`,
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
