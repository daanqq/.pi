import crypto from "node:crypto";
import type { ExtractedQuestion } from "./utils";

export type AnswerSource = "grill-me" | "general" | "planning" | "review" | "other";
export type AnswerUiMode = "quick" | "full";

export interface AnswerToolParams {
	title?: string;
	reason?: string;
	source?: AnswerSource;
	mode?: AnswerUiMode;
	questions: ExtractedQuestion[];
}

export interface SingleQuestionSettings {
	quickByDefault?: boolean;
	skipFinalConfirmation?: boolean;
}

export interface GrillMeSettings {
	enabled?: boolean;
	preferForSingleQuestion?: boolean;
	forceQuickMode?: boolean;
}

export const DEFAULT_SINGLE_QUESTION_SETTINGS: Required<SingleQuestionSettings> = {
	quickByDefault: false,
	skipFinalConfirmation: true,
};

export const DEFAULT_GRILL_ME_SETTINGS: Required<GrillMeSettings> = {
	enabled: true,
	preferForSingleQuestion: true,
	forceQuickMode: true,
};

export function chooseAnswerUiMode(
	params: Pick<AnswerToolParams, "mode" | "source" | "questions">,
	settings: {
		singleQuestion?: SingleQuestionSettings;
		grillMe?: GrillMeSettings;
	},
): AnswerUiMode {
	if (params.mode === "quick" || params.mode === "full") {
		return params.mode;
	}

	const singleQuestion = { ...DEFAULT_SINGLE_QUESTION_SETTINGS, ...(settings.singleQuestion ?? {}) };
	const grillMe = { ...DEFAULT_GRILL_ME_SETTINGS, ...(settings.grillMe ?? {}) };

	if (
		params.questions.length === 1 &&
		params.source === "grill-me" &&
		grillMe.enabled &&
		grillMe.forceQuickMode
	) {
		return "quick";
	}

	if (params.questions.length === 1 && singleQuestion.quickByDefault) {
		return "quick";
	}

	return "full";
}

export function getQuestionsHash(input: {
	title?: string;
	reason?: string;
	source?: string;
	questions: ExtractedQuestion[];
}): string {
	const normalized = {
		title: input.title ?? "",
		reason: input.reason ?? "",
		source: input.source ?? "",
		questions: input.questions.map((question) => ({
			id: question.id ?? "",
			header: question.header ?? "",
			question: question.question,
			context: question.context ?? "",
			options: (question.options ?? []).map((option) => ({
				label: option.label,
				description: option.description ?? "",
			})),
		})),
	};

	return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 16);
}

export function compileAnswers(questions: ExtractedQuestion[], answers: string[]): string {
	return questions
		.map((question, index) => {
			const answer = answers[index] ?? "";
			if (answer.trim().length === 0) {
				return "";
			}

			const parts: string[] = [];
			if (question.header) {
				parts.push(question.header);
			}
			parts.push(question.question);
			parts.push(`Answer: ${answer}`);
			return parts.join("\n");
		})
		.filter(Boolean)
		.join("\n\n");
}
