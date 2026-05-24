/**
 * Q&A extraction hook - extracts questions from assistant responses
 *
 * Custom interactive TUI for answering questions.
 *
 * Demonstrates the "prompt generator" pattern with custom TUI:
 * 1. /answer command gets the last assistant message
 * 2. Shows a spinner while extracting questions as structured JSON
 * 3. Presents an interactive TUI to navigate and answer questions
 * 4. Submits the compiled answers when done
 */

import { complete, type Model, type Api, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import fs from "node:fs/promises";
import path from "node:path";
import {
	collectAnswers,
	createDraftStore,
	getInitialResponses,
	getLatestDraft,
	hasAnyDraftContent,
} from "./qna-adapter";
import {
	type AnswerDraftSettings,
	type AnswerSettings,
	DEFAULT_DRAFT_SETTINGS,
	DEFAULT_MODEL_PREFERENCES,
	DEFAULT_SYSTEM_PROMPT,
	type ExtractionResult,
	mergeAnswerSettings,
	normalizeTemplates,
	parseExtractionResult,
} from "./utils";
import { collectQuickAnswer } from "./quick-tui";
import { chooseAnswerUiMode, compileAnswers, getQuestionsHash, type AnswerToolParams } from "./tool-utils";

/**
 * Prefer configured extraction models, otherwise fallback to the current model.
 */
async function selectExtractionModel(
	currentModel: Model<Api>,
	modelRegistry: {
		find: (provider: string, modelId: string) => Model<Api> | undefined;
		getApiKeyAndHeaders: (model: Model<Api>) => Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string> }>;
	},
	modelPreferences: { provider: string; id: string }[],
): Promise<Model<Api>> {
	for (const preference of modelPreferences) {
		const model = modelRegistry.find(preference.provider, preference.id);
		if (!model) {
			continue;
		}

		const auth = await modelRegistry.getApiKeyAndHeaders(model);
		if (auth.ok) {
			return model;
		}
	}

	return currentModel;
}

async function readSettingsFile(
	filePath: string,
	ctx: ExtensionContext,
): Promise<Record<string, unknown> | null> {
	try {
		const contents = await fs.readFile(filePath, "utf8");
		return JSON.parse(contents) as Record<string, unknown>;
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "ENOENT") {
			return null;
		}

		if (ctx.hasUI) {
			ctx.ui.notify(`Failed to read ${filePath}: ${err.message ?? "unknown error"}`, "warning");
		}
		return null;
	}
}

export function getAnswerSettingsPaths(cwd: string): { globalPath: string; projectPath: string } {
	return {
		globalPath: path.join(getAgentDir(), "settings.json"),
		projectPath: path.join(cwd, ".pi", "settings.json"),
	};
}

async function loadAnswerSettings(ctx: ExtensionContext): Promise<AnswerSettings> {
	const { globalPath, projectPath } = getAnswerSettingsPaths(ctx.cwd);

	const [globalSettings, projectSettings] = await Promise.all([
		readSettingsFile(globalPath, ctx),
		readSettingsFile(projectPath, ctx),
	]);

	const merged = mergeAnswerSettings(
		(globalSettings?.answer as AnswerSettings | undefined) ?? undefined,
		(projectSettings?.answer as AnswerSettings | undefined) ?? undefined,
	);

	return merged;
}

const QuestionOptionSchema = {
	type: "object",
	properties: {
		label: { type: "string", description: "Answer option label returned to the model when selected" },
		description: { type: "string", description: "Short explanation shown under the option" },
	},
	required: ["label"],
};

const ToolQuestionSchema = {
	type: "object",
	properties: {
		id: { type: "string", description: "Stable snake_case identifier for this question" },
		header: { type: "string", description: "Short section label" },
		question: { type: "string", description: "The user-facing question" },
		context: { type: "string", description: "Essential context needed to answer" },
		options: {
			type: "array",
			description: "Concrete choices, if the decision space is clear",
			items: QuestionOptionSchema,
		},
		required: { type: "boolean", description: "Whether an empty answer is allowed. Defaults to true." },
		multiline: { type: "boolean", description: "Whether a multiline custom answer is expected" },
	},
	required: ["question"],
};

const AnswerQuestionsParamsSchema = {
	type: "object",
	properties: {
		title: { type: "string", description: "Short title for the Q&A dialog" },
		reason: { type: "string", description: "Why these answers are needed" },
		source: { type: "string", enum: ["grill-me", "general", "planning", "review", "other"] },
		mode: { type: "string", enum: ["quick", "full"] },
		questions: {
			type: "array",
			description: "Questions to ask the user",
			items: ToolQuestionSchema,
		},
	},
	required: ["questions"],
} as any;

function normalizeToolQuestions(params: AnswerToolParams): ExtractionResult["questions"] {
	return params.questions.map((question, index) => ({
		id: question.id,
		header: question.header,
		question: question.question.trim() || `Question ${index + 1}`,
		context: question.context,
		options: question.options?.map((option) => ({
			label: option.label,
			description: option.description ?? "",
		})),
	}));
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "answer_questions",
		label: "Answer Questions",
		description: "Show the user an interactive Q&A TUI and return their answers to the model.",
		promptSnippet: "Show the user an interactive Q&A form and return their answers.",
		promptGuidelines: [
			"Use answer_questions when you need the user to answer concrete questions before continuing.",
			"Use answer_questions instead of writing question lists in plain text.",
			"Use answer_questions when a question has explicit choices, tradeoffs, priorities, constraints, or needs a structured answer.",
			"Do not use answer_questions for rhetorical questions or questions answerable by inspecting files or running tools.",
			"When the grill-me skill is active, use answer_questions even for a single concrete user-facing question.",
			"When the grill-me skill is active, usually call answer_questions with source='grill-me' and mode='quick'.",
			"When using answer_questions with grill-me, ask one focused question at a time unless batching is clearly better.",
			"When using answer_questions with grill-me, include options only if the decision space is clear; otherwise use freeform input.",
		],
		parameters: AnswerQuestionsParamsSchema,
		async execute(_toolCallId, params: AnswerToolParams, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text" as const, text: "answer_questions requires interactive mode." }],
					details: { ok: false, error: "answer_questions requires interactive mode." },
				};
			}

			if (!params.questions || params.questions.length === 0) {
				return {
					content: [{ type: "text" as const, text: "No questions provided." }],
					details: { ok: false, error: "No questions provided." },
				};
			}

			const settings = await loadAnswerSettings(ctx);
			const questions = normalizeToolQuestions(params);
			const mode = chooseAnswerUiMode(params, settings);

			if (mode === "quick" && questions.length === 1) {
				const result = await collectQuickAnswer(ctx, { ...questions[0], ...params.questions[0] });
				if (result === null) {
					return {
						content: [{ type: "text" as const, text: "User cancelled the Q&A dialog." }],
						details: { ok: false, cancelled: true, message: "User cancelled the Q&A dialog." },
					};
				}

				const answers = [result.answer];
				const compiled = compileAnswers(questions, answers);
				return {
					content: [{ type: "text" as const, text: compiled || "User submitted an empty answer." }],
					details: {
						ok: true,
						mode,
						answers: questions.map((question, index) => ({
							id: question.id,
							header: question.header,
							question: question.question,
							answer: answers[index] ?? "",
						})),
						compiled,
					},
				};
			}

			const templates = normalizeTemplates(settings.answerTemplates);
			const draftSettings: Required<AnswerDraftSettings> = {
				...DEFAULT_DRAFT_SETTINGS,
				...(settings.drafts ?? {}),
			};
			const draftSourceId = `tool:${getQuestionsHash({ title: params.title, reason: params.reason, source: params.source, questions })}`;
			const branch = ctx.sessionManager.getBranch();
			const draftStore = createDraftStore(pi, { sourceEntryId: draftSourceId, questions }, draftSettings);
			let initialResponses = getInitialResponses(questions, null);
			const draft = draftSettings.enabled ? getLatestDraft(branch, draftSourceId, questions) : null;
			if (draft) {
				initialResponses = getInitialResponses(questions, draft);
				if (hasAnyDraftContent(questions, initialResponses) && draftSettings.promptOnRestore) {
					const resume = await ctx.ui.confirm(
						"Resume draft answers?",
						"Saved answers were found for these questions. Restore them?",
					);
					if (!resume) {
						initialResponses = getInitialResponses(questions, null);
						draftStore.clear();
					}
				}
			}
			draftStore.seed(initialResponses);

			const answersResult = await collectAnswers(ctx, questions, {
				templates,
				initialResponses,
				onDraftChange: (responses) => draftStore.schedule(responses),
			});
			if (answersResult === null) {
				draftStore.flush();
				return {
					content: [{ type: "text" as const, text: "User cancelled the Q&A dialog." }],
					details: { ok: false, cancelled: true, message: "User cancelled the Q&A dialog." },
				};
			}
			draftStore.clear();

			const compiled = compileAnswers(questions, answersResult.answers);
			return {
				content: [{ type: "text" as const, text: compiled || "No answers provided." }],
				details: {
					ok: true,
					mode,
					answers: questions.map((question, index) => ({
						id: question.id,
						header: question.header,
						question: question.question,
						answer: answersResult.answers[index] ?? "",
					})),
					compiled,
				},
			};
		},
	});

	pi.on("before_agent_start", async (event) => {
		const skillsText = JSON.stringify(event.systemPromptOptions.skills ?? []);
		if (!skillsText.includes("grill-me")) {
			return;
		}

		return {
			systemPrompt:
				event.systemPrompt +
				"\n\nThe grill-me skill is active. For each concrete user-facing question, prefer calling answer_questions with source='grill-me' and mode='quick' instead of asking in plain text.",
		};
	});

	const answerHandler = async (ctx: ExtensionContext) => {
		if (!ctx.hasUI) {
			ctx.ui.notify("answer requires interactive mode", "error");
			return;
		}

		if (!ctx.model) {
			ctx.ui.notify("No model selected", "error");
			return;
		}

		const settings = await loadAnswerSettings(ctx);
		const systemPrompt = settings.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
		const modelPreferences = settings.extractionModels ?? DEFAULT_MODEL_PREFERENCES;
		const templates = normalizeTemplates(settings.answerTemplates);
		const draftSettings: Required<AnswerDraftSettings> = {
			...DEFAULT_DRAFT_SETTINGS,
			...(settings.drafts ?? {}),
		};

		const branch = ctx.sessionManager.getBranch();
		let lastAssistantText: string | undefined;
		let lastAssistantEntryId: string | undefined;

		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type === "message") {
				const msg = entry.message;
				if ("role" in msg && msg.role === "assistant") {
					if (msg.stopReason !== "stop") {
						ctx.ui.notify(`Last assistant message incomplete (${msg.stopReason})`, "error");
						return;
					}
					const textParts = msg.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text);
					if (textParts.length > 0) {
						lastAssistantText = textParts.join("\n");
						lastAssistantEntryId = entry.id;
						break;
					}
				}
			}
		}

		if (!lastAssistantText || !lastAssistantEntryId) {
			ctx.ui.notify("No assistant messages found", "error");
			return;
		}

		const extractionModel = await selectExtractionModel(ctx.model, ctx.modelRegistry, modelPreferences);

		const extractionResult = await ctx.ui.custom<ExtractionResult | null>((tui, theme, _kb, done) => {
			const loader = new BorderedLoader(tui, theme, `Extracting questions using ${extractionModel.id}...`);
			loader.onAbort = () => done(null);

			const doExtract = async () => {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(extractionModel);
				if (!auth.ok) {
					throw new Error(auth.error);
				}
				const userMessage: UserMessage = {
					role: "user",
					content: [{ type: "text", text: lastAssistantText! }],
					timestamp: Date.now(),
				};

				const response = await complete(
					extractionModel,
					{ systemPrompt, messages: [userMessage] },
					{ apiKey: auth.apiKey, headers: auth.headers, signal: loader.signal },
				);

				if (response.stopReason === "aborted") {
					return null;
				}

				const responseText = response.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n");

				return parseExtractionResult(responseText);
			};

			doExtract()
				.then(done)
				.catch(() => done(null));

			return loader;
		});

		if (extractionResult === null) {
			ctx.ui.notify("Cancelled", "info");
			return;
		}

		if (extractionResult.questions.length === 0) {
			ctx.ui.notify("No questions found in the last message", "info");
			return;
		}

		const draftStore = createDraftStore(
			pi,
			{ sourceEntryId: lastAssistantEntryId, questions: extractionResult.questions },
			draftSettings,
		);

		let initialResponses = getInitialResponses(extractionResult.questions, null);
		const draft = draftSettings.enabled
			? getLatestDraft(branch, lastAssistantEntryId, extractionResult.questions)
			: null;
		if (draft) {
			initialResponses = getInitialResponses(extractionResult.questions, draft);
			const hasContent = hasAnyDraftContent(extractionResult.questions, initialResponses);
			if (hasContent && draftSettings.promptOnRestore) {
				const resume = await ctx.ui.confirm(
					"Resume draft answers?",
					"Saved answers were found for this assistant message. Restore them?",
				);
				if (!resume) {
					initialResponses = getInitialResponses(extractionResult.questions, null);
					draftStore.clear();
				}
			}
		}

		draftStore.seed(initialResponses);

		const answersResult = await collectAnswers(ctx, extractionResult.questions, {
			templates,
			initialResponses,
			onDraftChange: (responses) => draftStore.schedule(responses),
		});

		if (answersResult === null) {
			draftStore.flush();
			ctx.ui.notify("Cancelled", "info");
			return;
		}

		draftStore.clear();

		if (answersResult.text.trim().length === 0) {
			ctx.ui.notify("No answers provided", "info");
			return;
		}

		pi.sendMessage(
			{
				customType: "answers",
				content: "I answered your questions in the following way:\n\n" + answersResult.text,
				display: true,
			},
			{ triggerTurn: true },
		);
	};

	pi.registerCommand("answer", {
		description: "Extract questions from last assistant message into interactive Q&A",
		handler: (_args, ctx) => answerHandler(ctx),
	});
}
