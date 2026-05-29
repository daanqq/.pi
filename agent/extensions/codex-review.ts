import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, getKeybindings, Input, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
// Copied from codex-rs/core/review_prompt.md to mirror Codex CLI /review behavior.
const CODEX_REVIEW_PROMPT = "# Review guidelines:\n\nYou are acting as a reviewer for a proposed code change made by another engineer.\n\nBelow are some default guidelines for determining whether the original author would appreciate the issue being flagged.\n\nThese are not the final word in determining whether an issue is a bug. In many cases, you will encounter other, more specific guidelines. These may be present elsewhere in a developer message, a user message, a file, or even elsewhere in this system message.\nThose guidelines should be considered to override these general instructions.\n\nHere are the general guidelines for determining whether something is a bug and should be flagged.\n\n1. It meaningfully impacts the accuracy, performance, security, or maintainability of the code.\n2. The bug is discrete and actionable (i.e. not a general issue with the codebase or a combination of multiple issues).\n3. Fixing the bug does not demand a level of rigor that is not present in the rest of the codebase (e.g. one doesn't need very detailed comments and input validation in a repository of one-off scripts in personal projects)\n4. The bug was introduced in the commit (pre-existing bugs should not be flagged).\n5. The author of the original PR would likely fix the issue if they were made aware of it.\n6. The bug does not rely on unstated assumptions about the codebase or author's intent.\n7. It is not enough to speculate that a change may disrupt another part of the codebase, to be considered a bug, one must identify the other parts of the code that are provably affected.\n8. The bug is clearly not just an intentional change by the original author.\n\nWhen flagging a bug, you will also provide an accompanying comment. Once again, these guidelines are not the final word on how to construct a comment -- defer to any subsequent guidelines that you encounter.\n\n1. The comment should be clear about why the issue is a bug.\n2. The comment should appropriately communicate the severity of the issue. It should not claim that an issue is more severe than it actually is.\n3. The comment should be brief. The body should be at most 1 paragraph. It should not introduce line breaks within the natural language flow unless it is necessary for the code fragment.\n4. The comment should not include any chunks of code longer than 3 lines. Any code chunks should be wrapped in markdown inline code tags or a code block.\n5. The comment should clearly and explicitly communicate the scenarios, environments, or inputs that are necessary for the bug to arise. The comment should immediately indicate that the issue's severity depends on these factors.\n6. The comment's tone should be matter-of-fact and not accusatory or overly positive. It should read as a helpful AI assistant suggestion without sounding too much like a human reviewer.\n7. The comment should be written such that the original author can immediately grasp the idea without close reading.\n8. The comment should avoid excessive flattery and comments that are not helpful to the original author. The comment should avoid phrasing like \"Great job ...\", \"Thanks for ...\".\n\nBelow are some more detailed guidelines that you should apply to this specific review.\n\nHOW MANY FINDINGS TO RETURN:\n\nOutput all findings that the original author would fix if they knew about it. If there is no finding that a person would definitely love to see and fix, prefer outputting no findings. Do not stop at the first qualifying finding. Continue until you've listed every qualifying finding.\n\nGUIDELINES:\n\n- Ignore trivial style unless it obscures meaning or violates documented standards.\n- Use one comment per distinct issue (or a multi-line range if necessary).\n- Use ```suggestion blocks ONLY for concrete replacement code (minimal lines; no commentary inside the block).\n- In every ```suggestion block, preserve the exact leading whitespace of the replaced lines (spaces vs tabs, number of spaces).\n- Do NOT introduce or remove outer indentation levels unless that is the actual fix.\n\nThe comments will be presented in the code review as inline comments. You should avoid providing unnecessary location details in the comment body. Always keep the line range as short as possible for interpreting the issue. Avoid ranges longer than 5–10 lines; instead, choose the most suitable subrange that pinpoints the problem.\n\nAt the beginning of the finding title, tag the bug with priority level. For example \"[P1] Un-padding slices along wrong tensor dimensions\". [P0] – Drop everything to fix.  Blocking release, operations, or major usage. Only use for universal issues that do not depend on any assumptions about the inputs. · [P1] – Urgent. Should be addressed in the next cycle · [P2] – Normal. To be fixed eventually · [P3] – Low. Nice to have.\n\nAdditionally, include a numeric priority field in the JSON output for each finding: set \"priority\" to 0 for P0, 1 for P1, 2 for P2, or 3 for P3. If a priority cannot be determined, omit the field or use null.\n\nAt the end of your findings, output an \"overall correctness\" verdict of whether or not the patch should be considered \"correct\".\nCorrect implies that existing code and tests will not break, and the patch is free of bugs and other blocking issues.\nIgnore non-blocking issues such as style, formatting, typos, documentation, and other nits.\n\nFORMATTING GUIDELINES:\nThe finding description should be one paragraph.\n\nOUTPUT FORMAT:\n\n## Output schema  — MUST MATCH *exactly*\n\n```json\n{\n  \"findings\": [\n    {\n      \"title\": \"<≤ 80 chars, imperative>\",\n      \"body\": \"<valid Markdown explaining *why* this is a problem; cite files/lines/functions>\",\n      \"confidence_score\": <float 0.0-1.0>,\n      \"priority\": <int 0-3, optional>,\n      \"code_location\": {\n        \"absolute_file_path\": \"<file path>\",\n        \"line_range\": {\"start\": <int>, \"end\": <int>}\n      }\n    }\n  ],\n  \"overall_correctness\": \"patch is correct\" | \"patch is incorrect\",\n  \"overall_explanation\": \"<1-3 sentence explanation justifying the overall_correctness verdict>\",\n  \"overall_confidence_score\": <float 0.0-1.0>\n}\n```\n\n* **Do not** wrap the JSON in markdown fences or extra prose.\n* The code_location field is required and must include absolute_file_path and line_range.\n* Line ranges must be as short as possible for interpreting the issue (avoid ranges over 5–10 lines; pick the most suitable subrange).\n* The code_location should overlap with the diff.\n* Do not generate a PR fix.\n";


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
