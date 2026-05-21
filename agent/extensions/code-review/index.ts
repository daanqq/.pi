import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, getKeybindings, Input, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { CODEX_REVIEW_PROMPT } from "./codex-review-prompt";

const BRANCH_SELECTOR_VISIBLE_ITEMS = 12;

type PendingReview = {
	branch: string;
	mergeBase: string;
};

type SelectListWithInternals = SelectList & {
	items: SelectItem[];
	filteredItems: SelectItem[];
	selectedIndex: number;
};

let pendingReview: PendingReview | undefined;
let awaitingReviewOutput = false;

export default function (pi: ExtensionAPI) {
	pi.registerCommand("review", {
		description: "Review current code changes against a selected branch",
		handler: async (args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait until the current agent turn finishes before running /review.", "warning");
				return;
			}

			const branch = await resolveBranch(pi, ctx, args);
			if (!branch) return;

			const mergeBase = await resolveMergeBase(pi, ctx, branch);
			if (!mergeBase) return;

			pendingReview = { branch, mergeBase };
			awaitingReviewOutput = true;
			pi.sendUserMessage(buildReviewPrompt(branch, mergeBase));
		},
	});

	pi.on("before_agent_start", async (event) => {
		if (!pendingReview) return;

		const review = pendingReview;
		pendingReview = undefined;

		return {
			systemPrompt: `${event.systemPrompt}\n\n${CODEX_REVIEW_PROMPT}\n\nAdditional review target:\n- Base branch: ${review.branch}\n- Merge base: ${review.mergeBase}\n- Review committed, staged, unstaged, and untracked changes relative to this base branch.\n- Inspect git diff ${review.mergeBase} for tracked changes.\n- Also inspect git status --short and review relevant untracked files as part of the proposed change.\n`,
		};
	});

	pi.on("message_end", async (event, ctx) => {
		if (!awaitingReviewOutput || event.message.role !== "assistant") return;

		const text = assistantText(event.message);
		const review = parseReviewOutput(text);
		if (!review) return;

		awaitingReviewOutput = false;
		return {
			message: {
				...event.message,
				content: [{ type: "text", text: formatReviewCards(review, ctx.cwd) }],
			},
		};
	});
}

async function resolveBranch(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	args: string,
): Promise<string | undefined> {
	const explicitBranch = parseBranchArg(args);
	if (explicitBranch) {
		const exists = await branchExists(pi, ctx.cwd, explicitBranch);
		if (!exists) {
			ctx.ui.notify(`Git branch not found: ${explicitBranch}`, "warning");
			return undefined;
		}
		return explicitBranch;
	}

	const branches = await listBranches(pi, ctx.cwd);
	if (branches.length === 0) {
		ctx.ui.notify("No git branches found.", "warning");
		return undefined;
	}

	return await selectBranch(ctx, branches);
}


type ReviewOutput = {
	findings?: ReviewFinding[];
	overall_correctness?: string;
	overall_explanation?: string;
	overall_confidence_score?: number;
};

type ReviewFinding = {
	title?: string;
	body?: string;
	confidence_score?: number;
	priority?: number;
	code_location?: {
		absolute_file_path?: string;
		line_range?: {
			start?: number;
			end?: number;
		};
	};
};

function assistantText(message: { content: unknown[] }): string {
	return message.content
		.map((item) => {
			if (isTextContent(item)) return item.text;
			return "";
		})
		.join("\n")
		.trim();
}

function isTextContent(item: unknown): item is { type: "text"; text: string } {
	return (
		typeof item === "object" &&
		item !== null &&
		"type" in item &&
		item.type === "text" &&
		"text" in item &&
		typeof item.text === "string"
	);
}

function parseReviewOutput(text: string): ReviewOutput | undefined {
	const trimmed = text.trim();
	if (!trimmed) return undefined;

	for (const candidate of reviewJsonCandidates(trimmed)) {
		try {
			const parsed = JSON.parse(candidate) as ReviewOutput;
			if (parsed && Array.isArray(parsed.findings) && parsed.overall_correctness) {
				return parsed;
			}
		} catch {
			// Try the next candidate.
		}
	}

	return undefined;
}

function reviewJsonCandidates(text: string): string[] {
	const candidates = [text];
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
	if (fenced?.[1]) candidates.push(fenced[1]);

	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));

	return candidates;
}

function formatReviewCards(review: ReviewOutput, cwd: string): string {
	const findings = review.findings ?? [];
	const lines: string[] = [];
	lines.push(`Review: ${review.overall_correctness ?? "unknown"}`);
	if (typeof review.overall_confidence_score === "number") {
		lines.push(`Confidence: ${review.overall_confidence_score.toFixed(2)}`);
	}
	lines.push("");

	if (review.overall_explanation) {
		lines.push(...wrapText(review.overall_explanation, 88));
		lines.push("");
	}

	if (findings.length === 0) {
		lines.push("No findings.");
		return lines.join("\n");
	}

	for (const [index, finding] of findings.entries()) {
		if (index > 0) {
			lines.push("");
			lines.push("─".repeat(72));
			lines.push("");
		}

		lines.push(finding.title ?? "Untitled finding");
		lines.push(`  File: ${formatLocation(finding, cwd)}`);
		if (typeof finding.confidence_score === "number") {
			lines.push(`  Confidence: ${finding.confidence_score.toFixed(2)}`);
		}
		lines.push("");
		lines.push(...wrapText(finding.body ?? "", 88, "  "));
	}

	return lines.join("\n");
}

function formatLocation(finding: ReviewFinding, cwd: string): string {
	const location = finding.code_location;
	const absolutePath = location?.absolute_file_path;
	const filePath = absolutePath ? relativePath(cwd, absolutePath) : "unknown";
	const start = location?.line_range?.start;
	const end = location?.line_range?.end;

	if (typeof start !== "number") return filePath;
	if (typeof end !== "number" || end === start) return `${filePath}:${start}`;
	return `${filePath}:${start}-${end}`;
}

function relativePath(cwd: string, absolutePath: string): string {
	const relative = path.relative(cwd, absolutePath);
	if (!relative || relative.startsWith("..")) return absolutePath;
	return relative;
}

function wrapText(text: string, width: number, indent = ""): string[] {
	const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
	if (words.length === 0) return [indent.trimEnd()];

	const lines: string[] = [];
	let line = indent;
	for (const word of words) {
		const next = line.trim() ? `${line} ${word}` : `${indent}${word}`;
		if (next.length > width && line.trim()) {
			lines.push(line);
			line = `${indent}${word}`;
		} else {
			line = next;
		}
	}
	lines.push(line);
	return lines;
}

async function selectBranch(
	ctx: ExtensionCommandContext,
	branches: string[],
): Promise<string | undefined> {
	if (!ctx.hasUI) {
		return await ctx.ui.select("Review changes against which branch?", branches);
	}

	const items: SelectItem[] = branches.map((branch) => ({
		value: branch,
		label: branch,
	}));

	return await ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		container.addChild(
			new Text(
				theme.fg("accent", theme.bold("Review changes against which branch?")),
				1,
				0,
			),
		);
		container.addChild(new Text(theme.fg("dim", "Type to filter:"), 1, 0));

		const filterInput = new Input();
		filterInput.focused = true;
		container.addChild(filterInput);

		const selectList = new SelectList(
			items,
			Math.min(items.length, BRANCH_SELECTOR_VISIBLE_ITEMS),
			{
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			},
		);
		(selectList as SelectListWithInternals).setFilter = function (filter: string) {
			this.filteredItems = this.items.filter((item) =>
				item.value.toLowerCase().includes(filter.toLowerCase()),
			);
			this.selectedIndex = 0;
		};
		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(undefined);
		container.addChild(selectList);
		container.addChild(
			new Text(
				theme.fg(
					"dim",
					`type filter • ↑↓ navigate/scroll • enter select • esc cancel • showing ${Math.min(items.length, BRANCH_SELECTOR_VISIBLE_ITEMS)} of ${items.length}`,
				),
				1,
				0,
			),
		);
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

		return {
			render: (width) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				if (isSelectListKey(data)) {
					selectList.handleInput(data);
				} else {
					filterInput.handleInput(data);
					selectList.setFilter(filterInput.getValue());
				}
				tui.requestRender();
			},
		};
	});
}

function isSelectListKey(data: string): boolean {
	const keybindings = getKeybindings();
	return (
		keybindings.matches(data, "tui.select.up") ||
		keybindings.matches(data, "tui.select.down") ||
		keybindings.matches(data, "tui.select.pageUp") ||
		keybindings.matches(data, "tui.select.pageDown") ||
		keybindings.matches(data, "tui.select.confirm") ||
		keybindings.matches(data, "tui.select.cancel")
	);
}

function parseBranchArg(args: string): string | undefined {
	const trimmed = args.trim();
	if (!trimmed) return undefined;

	const baseMatch = trimmed.match(/^--base(?:=|\s+)(.+)$/);
	return (baseMatch?.[1] ?? trimmed).trim() || undefined;
}

async function listBranches(pi: ExtensionAPI, cwd: string): Promise<string[]> {
	const result = await pi.exec(
		"git",
		["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"],
		{
			cwd,
			timeout: 5_000,
		},
	);
	if (result.code !== 0) return [];

	const branches = result.stdout
		.split("\n")
		.map((ref) => ref.trim())
		.filter(Boolean)
		.filter((ref) => !ref.match(/^refs\/remotes\/[^/]+\/HEAD$/))
		.map((ref) =>
			ref
				.replace(/^refs\/heads\//, "")
				.replace(/^refs\/remotes\//, ""),
		);

	return [...new Set<string>(branches)].sort((a, b) => a.localeCompare(b));
}

async function branchExists(pi: ExtensionAPI, cwd: string, branch: string): Promise<boolean> {
	const result = await pi.exec("git", ["rev-parse", "--verify", `${branch}^{commit}`], {
		cwd,
		timeout: 5_000,
	});
	return result.code === 0;
}

async function resolveMergeBase(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	branch: string,
): Promise<string | undefined> {
	const result = await pi.exec("git", ["merge-base", "HEAD", branch], {
		cwd: ctx.cwd,
		timeout: 5_000,
	});
	if (result.code !== 0) {
		ctx.ui.notify(`Failed to find merge base with ${branch}.`, "warning");
		return undefined;
	}

	const mergeBase = result.stdout.trim();
	if (!mergeBase) {
		ctx.ui.notify(`Git returned an empty merge base for ${branch}.`, "warning");
		return undefined;
	}

	return mergeBase;
}

function buildReviewPrompt(branch: string, mergeBase: string): string {
	return `Review the code changes against the base branch '${branch}'.
The merge base commit for this comparison is ${mergeBase}.
Run \`git diff ${mergeBase}\` to inspect tracked committed, staged, and unstaged changes relative to ${branch}.
Also run \`git status --short\` and review relevant untracked files as part of the proposed change.
Provide prioritized, actionable findings.`;
}
