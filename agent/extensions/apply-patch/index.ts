import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { keyHint, renderDiff, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { buildUpdatePreview, formatNumberedDiffLines, numberUpdateDiffLines } from "./diff-lines.ts";

const APPLY_PATCH_PARAMETERS = Type.Object({
	input: Type.String({
		description:
			"Required. The complete patch text, starting with *** Begin Patch and ending with *** End Patch. Do not use fields named patch, patchText, command, or content.",
	}),
}, { additionalProperties: false });

interface ParsedPatchAction {
	type: "add" | "delete" | "update";
	path: string;
	movePath?: string | undefined;
	newFile?: string | undefined;
	lines?: string[] | undefined;
}

interface ExecutePatchResult {
	changedFiles: string[];
	createdFiles: string[];
	deletedFiles: string[];
	movedFiles: string[];
	fuzz: number;
}

interface RustApplyPatchJson {
	status: "success" | "failure";
	error?: string | null | undefined;
	exact?: boolean | undefined;
	result?: ExecutePatchResult | undefined;
}

interface ApplyPatchSuccessDetails {
	status: "success";
	result: ExecutePatchResult;
}

interface ApplyPatchPartialFailureDetails {
	status: "partial_failure";
	result: ExecutePatchResult;
	error: string;
	failedTargets: string[];
	appliedFiles: string[];
	failedFiles: string[];
	recoveryInstructions: {
		mustReadFiles: string[];
		mustNotReadFiles: string[];
	};
}

type ApplyPatchToolDetails = ApplyPatchSuccessDetails | ApplyPatchPartialFailureDetails;

interface RenderState {
	cwd: string;
	patchText: string;
	status: "pending" | "partial_failure" | "failed";
	failedTargets?: string[] | undefined;
}

type PatchPreview = { summary: string; diff: string } | { error: string };

type ApplyPatchCallRenderComponent = Box & {
	preview?: PatchPreview | undefined;
	previewArgsKey?: string | undefined;
	settledStatus?: "success" | "partial_failure" | "failed" | undefined;
	failedTargets?: string[] | undefined;
	renderKey?: string | undefined;
	renderTheme?: object | undefined;
};

interface ModelLike {
	provider?: string | undefined;
	id?: string | undefined;
	name?: string | undefined;
}

const renderStates = new Map<string, RenderState>();
const EMPTY_RESULT: ExecutePatchResult = { changedFiles: [], createdFiles: [], deletedFiles: [], movedFiles: [], fuzz: 0 };
const COLLAPSED_PREVIEW_LINE_LIMIT = 40;

export default function (pi: ExtensionAPI) {
	let editHiddenByGptToolPolicy = false;

	const applyModelToolPolicy = (model: ModelLike | undefined) => {
		const activeTools = pi.getActiveTools();
		let nextTools = [...activeTools];
		let changed = false;

		if (isGptLikeModel(model)) {
			const editIndex = nextTools.indexOf("edit");
			if (editIndex !== -1) {
				nextTools.splice(editIndex, 1);
				editHiddenByGptToolPolicy = true;
				changed = true;
			}

			if (!nextTools.includes("apply_patch")) {
				const insertAt = editIndex === -1 ? nextTools.length : Math.min(editIndex, nextTools.length);
				nextTools.splice(insertAt, 0, "apply_patch");
				changed = true;
			}
		} else {
			const patchIndex = nextTools.indexOf("apply_patch");
			if (patchIndex !== -1) {
				nextTools.splice(patchIndex, 1);
				changed = true;
			}

			if (editHiddenByGptToolPolicy && !nextTools.includes("edit")) {
				const insertAt = patchIndex === -1 ? nextTools.length : Math.min(patchIndex, nextTools.length);
				nextTools.splice(insertAt, 0, "edit");
				changed = true;
			}
			editHiddenByGptToolPolicy = false;
		}

		if (changed) pi.setActiveTools(uniqueStrings(nextTools));
	};

	pi.on("session_start", (_event, ctx) => {
		applyModelToolPolicy(ctx.model as ModelLike | undefined);
	});

	pi.on("model_select", (event) => {
		applyModelToolPolicy(event.model as ModelLike | undefined);
	});

	pi.registerTool({
		name: "apply_patch",
		label: "apply_patch",
		description: "Apply a Codex-style patch to files. Supports add, update, delete, and move operations.",
		renderShell: "self",
		promptSnippet: "Edit files with a patch.",
		promptGuidelines: [
			"Use apply_patch to create, update, delete, or move files. Always call apply_patch with exactly one JSON field: input.",
			"The apply_patch input value must contain the full patch text from *** Begin Patch through *** End Patch.",
			"Do not call apply_patch with patch, patchText, command, content, or raw text outside the input field.",
			"Group related edits in one apply_patch call, and read failed files before retrying after partial_failure.",
		],
		parameters: APPLY_PATCH_PARAMETERS,
		prepareArguments(args) {
			if (args && typeof args === "object") {
				const input = args as { input?: unknown; patch?: unknown; patchText?: unknown; command?: unknown; content?: unknown };
				if (typeof input.input === "string") return { input: input.input };
				if (typeof input.patchText === "string") return { input: input.patchText };
				if (typeof input.patch === "string") return { input: input.patch };
				if (typeof input.command === "string") return { input: input.command };
				if (typeof input.content === "string") return { input: input.content };
			}
			return args as { input: string };
		},
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("apply_patch aborted");
			const patchText = parseApplyPatchParams(params);
			renderStates.set(toolCallId, { cwd: ctx.cwd, patchText, status: "pending" });

			try {
				const result = await withPatchMutationQueues(ctx.cwd, patchText, () => executePatchWithBinary({ cwd: ctx.cwd, patchText, signal }));
				return {
					content: [{ type: "text", text: buildSuccessSummary(result) }],
					details: { status: "success", result } satisfies ApplyPatchSuccessDetails,
				};
			} catch (error) {
				if (error instanceof ApplyPatchExecutionError) {
					const partial = hasPartialSuccess(error.result);
					const failedTargets = failedTargetsForError(ctx.cwd, patchText, error.message, error.result);
					if (partial) {
						renderStates.set(toolCallId, { cwd: ctx.cwd, patchText, status: "partial_failure", failedTargets });
						const failedFiles = failedFilesForError(ctx.cwd, patchText, error.message, error.result);
						const appliedFiles = appliedFilesFromResult(error.result, failedFiles);
						const message = buildPartialFailureMessage(error.message, error.result, failedTargets, failedFiles, appliedFiles);
						return {
							content: [{ type: "text", text: message }],
							details: {
								status: "partial_failure",
								result: error.result,
								error: message,
								failedTargets,
								appliedFiles,
								failedFiles,
								recoveryInstructions: { mustReadFiles: failedFiles, mustNotReadFiles: appliedFiles },
							} satisfies ApplyPatchPartialFailureDetails,
						};
					}
					renderStates.set(toolCallId, { cwd: ctx.cwd, patchText, status: "failed", failedTargets });
					const target = failedTargets.length > 0 ? ` while patching ${failedTargets.join(", ")}` : "";
					throw new Error(`apply_patch failed${target}: ${error.message}`);
				}
				renderStates.set(toolCallId, { cwd: ctx.cwd, patchText, status: "failed" });
				throw error;
			}
		},
		renderCall(args, theme, context) {
			const component = getApplyPatchCallRenderComponent(context.state, context.lastComponent);
			const patchText = typeof (args as { input?: unknown })?.input === "string" ? (args as { input: string }).input : "";
			const argsKey = patchText || undefined;
			if (component.previewArgsKey !== argsKey) {
				component.preview = undefined;
				component.previewArgsKey = argsKey;
				component.settledStatus = undefined;
				component.failedTargets = undefined;
				component.renderKey = undefined;
			}
			if (context.argsComplete && patchText.trim().length > 0 && !component.preview) {
				component.preview = previewPatch(patchText, context.cwd);
			}
			const cached = context.toolCallId ? renderStates.get(context.toolCallId) : undefined;
			if (cached?.status === "partial_failure" || cached?.status === "failed") {
				component.settledStatus = cached.status;
				component.failedTargets = cached.failedTargets;
			}
			if (!context.isPartial && !component.settledStatus) component.settledStatus = context.isError ? "failed" : "success";
			return buildApplyPatchCallComponent(component, args as { input?: unknown }, theme, context);
		},
		renderResult(result, { isPartial }, theme, context) {
			const callComponent = context.state.callComponent as ApplyPatchCallRenderComponent | undefined;
			if (isPartial) return new Container();
			if (!isApplyPatchToolDetails(result.details)) return new Container();
			if (callComponent) {
				callComponent.settledStatus = result.details.status;
				if (result.details.status === "partial_failure") callComponent.failedTargets = result.details.failedTargets;
				buildApplyPatchCallComponent(callComponent, context.args as { input?: unknown }, theme, context);
			}
			return new Container();
		},
	});
}

function parseApplyPatchParams(params: unknown): string {
	if (!params || typeof params !== "object" || !("input" in params) || typeof params.input !== "string") {
		throw new Error('apply_patch requires {"input":"*** Begin Patch\\n...\\n*** End Patch"}. Retry the same patch using the input field.');
	}
	return params.input;
}

function isGptLikeModel(model: ModelLike | undefined): boolean {
	if (!model) return false;
	const provider = (model.provider ?? "").toLowerCase();
	const id = (model.id ?? "").toLowerCase();
	const name = (model.name ?? "").toLowerCase();
	return provider.includes("openai") || provider.includes("codex") || id.includes("gpt") || id.includes("codex") || name.includes("gpt") || name.includes("codex");
}

function createApplyPatchCallRenderComponent(): ApplyPatchCallRenderComponent {
	return Object.assign(new Box(1, 1, (text: string) => text), {
		preview: undefined as PatchPreview | undefined,
		previewArgsKey: undefined as string | undefined,
		settledStatus: undefined as "success" | "partial_failure" | "failed" | undefined,
		failedTargets: undefined as string[] | undefined,
		renderKey: undefined as string | undefined,
		renderTheme: undefined as object | undefined,
	});
}


function getApplyPatchCallRenderComponent(state: Record<string, unknown>, lastComponent: unknown): ApplyPatchCallRenderComponent {
	if (lastComponent instanceof Box) {
		const component = lastComponent as ApplyPatchCallRenderComponent;
		state.callComponent = component;
		return component;
	}
	if (state.callComponent instanceof Box) return state.callComponent as ApplyPatchCallRenderComponent;
	const component = createApplyPatchCallRenderComponent();
	state.callComponent = component;
	return component;
}

function getApplyPatchHeaderBg(component: ApplyPatchCallRenderComponent, theme: { bg(role: string, text: string): string }): (text: string) => string {
	if (component.settledStatus === "failed" || component.settledStatus === "partial_failure") return (text: string) => theme.bg("toolErrorBg", text);
	if (component.settledStatus === "success" || (component.preview && !("error" in component.preview))) return (text: string) => theme.bg("toolSuccessBg", text);
	if (component.preview && "error" in component.preview) return (text: string) => theme.bg("toolErrorBg", text);
	return (text: string) => theme.bg("toolPendingBg", text);
}

function buildApplyPatchCallComponent(
	component: ApplyPatchCallRenderComponent,
	args: { input?: unknown },
	theme: { fg(role: string, text: string): string; bold(text: string): string; bg(role: string, text: string): string },
	context?: { cwd?: string | undefined; argsComplete?: boolean | undefined; expanded?: boolean | undefined; isPartial?: boolean | undefined },
): ApplyPatchCallRenderComponent {
	const patchText = typeof args.input === "string" ? args.input : "";
	const renderKey = [
		component.previewArgsKey ?? patchText,
		component.settledStatus ?? "pending",
		component.failedTargets?.join("\0") ?? "",
		context?.cwd ?? process.cwd(),
		context?.argsComplete === false ? "incomplete" : "complete",
		context?.expanded === true ? "expanded" : "collapsed",
		context?.isPartial === true ? "partial" : "settled",
	].join("\u0001");
	if (component.renderKey === renderKey && component.renderTheme === theme) return component;
	component.renderKey = renderKey;
	component.renderTheme = theme;

	component.setBgFn(getApplyPatchHeaderBg(component, theme));
	component.clear();
	const cwd = context?.cwd ?? process.cwd();
	const inProgressActions = context?.isPartial === true && !component.preview ? parsePatchActionHeaders(patchText) : undefined;
	component.addChild(new Text(formatApplyPatchHeader(args, component.preview, theme, cwd, context?.isPartial === true && !component.settledStatus, inProgressActions), 0, 0));

	if (!component.preview) {
		const activeBody = context?.isPartial === true ? formatInProgressApplyPatchBody(inProgressActions ?? [], cwd) : "";
		if (activeBody.trim().length > 0) {
			component.addChild(new Text(theme.fg("muted", activeBody), 0, 0));
		}
		return component;
	}

	if (context?.argsComplete === false) return component;

	const body = "error" in component.preview ? theme.fg("error", component.preview.error) : renderPatchPreview(component.preview, theme, component.settledStatus, component.failedTargets, context?.expanded === true);
	if (body.trim().length === 0) return component;
	component.addChild(new Spacer(1));
	component.addChild(new Text(body, 0, 0));
	return component;
}

function formatApplyPatchHeader(
	args: { input?: unknown },
	preview: PatchPreview | undefined,
	theme: { fg(role: string, text: string): string; bold(text: string): string },
	cwd: string,
	showInProgress: boolean,
	inProgressActions?: Array<{ path: string; movePath?: string | undefined }>,
): string {
	let title = theme.fg("toolTitle", theme.bold("apply_patch"));
	const patchText = typeof args.input === "string" ? args.input : "";
	if (showInProgress) {
		const summary = formatInProgressApplyPatchSummary(inProgressActions ?? parsePatchActionHeaders(patchText), cwd);
		if (summary) return `${title} ${theme.fg("muted", summary)}`;
		return title;
	}
	if (preview && !("error" in preview) && preview.summary) {
		const summary = preview.summary.replace(/^•\s*/, "");
		return `${title} ${formatApplyPatchHeaderSummary(summary, theme)}`;
	}
	const fallback = formatApplyPatchSummary(patchText, cwd).replace(/^•\s*/, "");
	if (fallback) title += ` ${formatApplyPatchHeaderSummary(fallback, theme)}`;
	return title;
}

function formatApplyPatchHeaderSummary(summary: string, theme: { fg(role: string, text: string): string }): string {
	return summary
		.split(/([+-]\d+)/g)
		.map((part) => part.startsWith("+") ? theme.fg("toolDiffAdded", part) : part.startsWith("-") ? theme.fg("toolDiffRemoved", part) : theme.fg("muted", part))
		.join("");
}

function formatInProgressApplyPatchSummary(actions: Array<{ path: string; movePath?: string | undefined }>, cwd: string): string {
	if (actions.length === 0) return "";
	if (actions.length === 1) return formatPatchTarget(actions[0]!.path, actions[0]!.movePath, cwd);
	return `${actions.length} files`;
}

function formatInProgressApplyPatchBody(actions: Array<{ path: string; movePath?: string | undefined }>, cwd: string): string {
	if (actions.length <= 1) return "";
	return actions.map((action) => `  └ ${formatPatchTarget(action.path, action.movePath, cwd)}`).join("\n");
}

function parsePatchActionHeaders(text: string): Array<{ path: string; movePath?: string | undefined }> {
	const actions: Array<{ path: string; movePath?: string | undefined }> = [];
	let current: { path: string; movePath?: string | undefined } | undefined;
	for (const line of text.split("\n")) {
		if (line.startsWith("*** Add File: ") || line.startsWith("*** Delete File: ") || line.startsWith("*** Update File: ")) {
			current = { path: normalizePatchPath(line.slice(line.indexOf(": ") + 2)) };
			actions.push(current);
			continue;
		}
		if (current && line.startsWith("*** Move to: ")) current.movePath = normalizePatchPath(line.slice("*** Move to: ".length));
	}
	return actions.filter((action) => action.path.length > 0);
}

function previewPatch(patchText: string, cwd: string): PatchPreview {
	try {
		const files = buildFilePreviews(patchText, cwd);
		if (files.length === 0) throw new Error("No files were modified.");
		const summary = formatApplyPatchSummaryFromFiles(files, cwd);
		const diff = formatApplyPatchDiffFromFiles(files, cwd);
		return { summary, diff };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

function renderPatchPreview(
	preview: { summary: string; diff: string },
	theme: { fg(role: string, text: string): string },
	status: "success" | "partial_failure" | "failed" | undefined,
	failedTargets?: string[] | undefined,
	expanded = false,
): string {
	const diffLines = preview.diff.split("\n");
	const visibleDiff = expanded || diffLines.length <= COLLAPSED_PREVIEW_LINE_LIMIT
		? preview.diff
		: diffLines.slice(0, COLLAPSED_PREVIEW_LINE_LIMIT).join("\n");
	let body = colorPatchCountPairs(renderDiff(visibleDiff), theme);
	if (!expanded && diffLines.length > COLLAPSED_PREVIEW_LINE_LIMIT) {
		body += `\n${theme.fg("muted", `... (${diffLines.length - COLLAPSED_PREVIEW_LINE_LIMIT} more lines; ${keyHint("app.tools.expand", "to expand")})`)}`;
	}
	if (status === "partial_failure" || status === "failed") {
		const role = status === "failed" ? "error" : "warning";
		body = body
			.split("\n")
			.map((line) => failedTargets?.some((target) => line.includes(target)) ? theme.fg(role, line) : line)
			.join("\n");
	}
	return body;
}

function colorPatchCountPairs(text: string, theme: { fg(role: string, text: string): string }): string {
	return text.replace(/\+(\d+)\s+-(\d+)/g, `${theme.fg("toolDiffAdded", "+$1")} ${theme.fg("toolDiffRemoved", "-$2")}`);
}

function getBundledApplyPatchBinaryPath(): string | undefined {
	const extensionDir = dirname(fileURLToPath(import.meta.url));
	const exe = process.platform === "win32" ? "apply_patch.exe" : "apply_patch";
	const binary = join(extensionDir, "bin", `${process.platform}-${process.arch}`, exe);
	return existsSync(binary) ? binary : undefined;
}

class ApplyPatchExecutionError extends Error {
	constructor(message: string, readonly result: ExecutePatchResult) {
		super(message);
		this.name = "ApplyPatchExecutionError";
	}
}

async function executePatchWithBinary({ cwd, patchText, signal }: { cwd: string; patchText: string; signal?: AbortSignal | undefined }): Promise<ExecutePatchResult> {
	const binary = getBundledApplyPatchBinaryPath();
	if (!binary) throw new Error(`apply_patch binary is not bundled for ${process.platform}-${process.arch}`);
	const child = await runProcess({ binary, cwd, stdin: patchText, env: { ...process.env, PI_APPLY_PATCH_JSON: "1" }, signal });
	const parsed = parseSingleJsonLine<RustApplyPatchJson>(child.stdout, "apply_patch");
	const result = parsed.result ?? EMPTY_RESULT;
	if (parsed.status === "success" && child.status === 0) return result;
	throw new ApplyPatchExecutionError(parsed.error ?? (child.stderr.trim() || "apply_patch failed"), result);
}

function runProcess({ binary, cwd, stdin, env, signal }: { binary: string; cwd: string; stdin: string; env: NodeJS.ProcessEnv; signal?: AbortSignal | undefined }): Promise<{ stdout: string; stderr: string; status: number | null }> {
	return new Promise((resolveProcess, reject) => {
		if (signal?.aborted) {
			reject(new Error("Operation aborted"));
			return;
		}
		let stdout = "";
		let stderr = "";
		let settled = false;
		let outputBytes = 0;
		const maxOutputBytes = 64 * 1024 * 1024;
		const child = spawn(binary, [], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
		const cleanup = () => signal?.removeEventListener("abort", onAbort);
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			cleanup();
			fn();
		};
		const append = (target: "stdout" | "stderr", chunk: Buffer | string) => {
			const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
			outputBytes += Buffer.byteLength(text, "utf8");
			if (outputBytes > maxOutputBytes) {
				child.kill();
				finish(() => reject(new Error(`apply_patch output exceeded ${maxOutputBytes} bytes`)));
				return;
			}
			if (target === "stdout") stdout += text;
			else stderr += text;
		};
		const onAbort = () => {
			child.kill();
			finish(() => reject(new Error("Operation aborted")));
		};
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk) => append("stdout", chunk));
		child.stderr?.on("data", (chunk) => append("stderr", chunk));
		child.on("error", (error) => finish(() => reject(error)));
		child.on("close", (status) => finish(() => resolveProcess({ stdout, stderr, status })));
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdin?.end(stdin);
	});
}

function parseSingleJsonLine<T>(stdout: string, label: string): T {
	const jsonLine = stdout
		.trimEnd()
		.split("\n")
		.findLast((line) => line.trimStart().startsWith("{"));
	if (!jsonLine) throw new Error(`${label} did not return structured JSON output`);
	return JSON.parse(jsonLine) as T;
}

async function withPatchMutationQueues<T>(cwd: string, patchText: string, fn: () => Promise<T>): Promise<T> {
	let paths: string[] = [];
	try {
		paths = parsePatchActions(patchText).flatMap((action) => [action.path, action.movePath].filter((path): path is string => Boolean(path)));
	} catch {
		return fn();
	}
	const absolutePaths = Array.from(new Set(paths.map((path) => resolvePatchPath(cwd, path)))).sort();
	const run = (index: number): Promise<T> => {
		if (index >= absolutePaths.length) return fn();
		return withFileMutationQueue(absolutePaths[index]!, () => run(index + 1));
	};
	return run(0);
}

function parsePatchActions(text: string): ParsedPatchAction[] {
	// The bundled binary accepts both LF and CRLF patches. Normalize here too so
	// the TUI preview does not report a false "No files were modified" after a
	// CRLF patch was successfully applied.
	const lines = text.trim().replace(/\r\n?/g, "\n").split("\n");
	if (lines.length < 2 || !lines[0]!.startsWith("*** Begin Patch") || lines.at(-1) !== "*** End Patch") {
		throw new Error("Invalid patch text");
	}
	const actions: ParsedPatchAction[] = [];
	const seenPaths = new Set<string>();
	let index = 1;
	while (index < lines.length - 1) {
		const line = lines[index]!;
		if (line.startsWith("*** Add File: ")) {
			const path = normalizePatchPath(line.slice("*** Add File: ".length));
			checkDuplicatePath(seenPaths, path, "Add File");
			index += 1;
			const newLines: string[] = [];
			while (index < lines.length - 1 && !isActionHeader(lines[index]!)) {
				const value = lines[index]!;
				if (!value.startsWith("+")) throw new Error(`Invalid Add File line: ${value}`);
				newLines.push(value.slice(1));
				index += 1;
			}
			actions.push({ type: "add", path, newFile: newLines.length === 0 ? "" : `${newLines.join("\n")}\n` });
			continue;
		}
		if (line.startsWith("*** Delete File: ")) {
			const path = normalizePatchPath(line.slice("*** Delete File: ".length));
			checkDuplicatePath(seenPaths, path, "Delete File");
			actions.push({ type: "delete", path });
			index += 1;
			continue;
		}
		if (line.startsWith("*** Update File: ")) {
			const path = normalizePatchPath(line.slice("*** Update File: ".length));
			checkDuplicatePath(seenPaths, path, "Update File");
			index += 1;
			let movePath: string | undefined;
			if (index < lines.length - 1 && lines[index]!.startsWith("*** Move to: ")) {
				movePath = normalizePatchPath(lines[index]!.slice("*** Move to: ".length));
				index += 1;
			}
			const bodyStart = index;
			while (index < lines.length - 1 && !isActionHeader(lines[index]!)) index += 1;
			const bodyLines = lines.slice(bodyStart, index);
			if (bodyLines.length === 0) throw new Error(`Update file hunk for '${path}' is empty`);
			actions.push({ type: "update", path, movePath, lines: bodyLines });
			continue;
		}
		throw new Error(`Invalid patch hunk: ${line}`);
	}
	if (actions.length === 0) throw new Error("No files were modified.");
	return actions;
}

function isActionHeader(line: string): boolean {
	return line.startsWith("*** Add File: ") || line.startsWith("*** Delete File: ") || line.startsWith("*** Update File: ");
}

function checkDuplicatePath(seenPaths: Set<string>, path: string, action: string): void {
	if (seenPaths.has(path)) throw new Error(`${action} Error: Duplicate Path: ${path}`);
	seenPaths.add(path);
}

function normalizePatchPath(path: string): string {
	const trimmed = path.trim();
	const withoutAt = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
	return withoutAt.replace(/^['"]|['"]$/g, "");
}

function resolvePatchPath(cwd: string, patchPath: string): string {
	const normalized = normalizePatchPath(patchPath);
	if (!normalized) throw new Error("Patch path cannot be empty");
	return isAbsolute(normalized) ? normalized : resolve(cwd, normalized);
}

function buildSuccessSummary(result: ExecutePatchResult): string {
	return [
		"Applied patch successfully.",
		`Changed files: ${result.changedFiles.length}`,
		`Created files: ${result.createdFiles.length}`,
		`Deleted files: ${result.deletedFiles.length}`,
		`Moved files: ${result.movedFiles.length}`,
		`Fuzz: ${result.fuzz}`,
	].join("\n");
}

function hasPartialSuccess(result: ExecutePatchResult): boolean {
	return result.changedFiles.length > 0 || result.createdFiles.length > 0 || result.deletedFiles.length > 0 || result.movedFiles.length > 0 || result.fuzz > 0;
}

function failedTargetsForError(cwd: string, patchText: string, error: string, result: ExecutePatchResult): string[] {
	const actions = safeParseActions(patchText);
	const explicit = actions.filter((action) => errorMentionsAction(cwd, error, action)).map((action) => formatPatchTarget(action.path, action.movePath, cwd));
	if (explicit.length > 0) return uniqueStrings(explicit);
	return uniqueStrings(actions.filter((action) => !actionAppearsApplied(action, result, cwd)).map((action) => formatPatchTarget(action.path, action.movePath, cwd)));
}

function failedFilesForError(cwd: string, patchText: string, error: string, result: ExecutePatchResult): string[] {
	const actions = safeParseActions(patchText);
	const failedActions = actions.filter((action) => errorMentionsAction(cwd, error, action));
	const inferred = failedActions.length > 0 ? failedActions : actions.filter((action) => !actionAppearsApplied(action, result, cwd));
	return uniqueStrings(inferred.flatMap((action) => [displayPath(action.path, cwd), action.movePath ? displayPath(action.movePath, cwd) : undefined]));
}

function actionAppearsApplied(action: ParsedPatchAction, result: ExecutePatchResult, cwd: string): boolean {
	const applied = new Set([...result.changedFiles, ...result.createdFiles, ...result.deletedFiles, ...result.movedFiles].map((path) => displayPath(path, cwd)));
	return applied.has(displayPath(action.path, cwd)) || Boolean(action.movePath && applied.has(displayPath(action.movePath, cwd)));
}

function errorMentionsAction(cwd: string, error: string, action: ParsedPatchAction): boolean {
	const candidates = [action.path, resolvePatchPath(cwd, action.path), action.movePath, action.movePath ? resolvePatchPath(cwd, action.movePath) : undefined].filter((value): value is string => Boolean(value));
	return candidates.some((candidate) => error.includes(candidate));
}

function appliedFilesFromResult(result: ExecutePatchResult, failedFiles: string[]): string[] {
	const failed = new Set(failedFiles);
	return uniqueStrings([...result.changedFiles, ...result.createdFiles, ...result.deletedFiles, ...result.movedFiles].filter((path) => !failed.has(path)));
}

function buildPartialFailureMessage(error: string, result: ExecutePatchResult, failedTargets: string[], failedFiles: string[], appliedFiles: string[]): string {
	const lines = [`apply_patch partially failed after ${summarizePatchCounts(result)}: ${error}`];
	if (failedTargets.length > 0) lines.push(`Failed target${failedTargets.length === 1 ? "" : "s"}: ${failedTargets.join(", ")}`);
	if (failedFiles.length > 0) lines.push(`Recovery: MUST read ${failedFiles.join(", ")} before retrying.`);
	else lines.push("Recovery: MUST read every target file whose state may affect the failed patch before retrying.");
	if (appliedFiles.length > 0) {
		lines.push("Earlier file actions in this patch were already applied.");
		lines.push(`Recovery: MUST NOT reread or reapply already-applied files unless a specific dependency requires it: ${appliedFiles.join(", ")}`);
	}
	return lines.join("\n");
}

function summarizePatchCounts(result: ExecutePatchResult): string {
	return [
		`changed ${result.changedFiles.length} file${result.changedFiles.length === 1 ? "" : "s"}`,
		`created ${result.createdFiles.length}`,
		`deleted ${result.deletedFiles.length}`,
		`moved ${result.movedFiles.length}`,
	].join(", ");
}

function renderApplyPatchCall(args: { input?: unknown }, theme: { fg(role: string, text: string): string; bold(text: string): string }, context?: { toolCallId?: string; cwd?: string; expanded?: boolean; argsComplete?: boolean }): string {
	if (context?.argsComplete === false) return theme.bold("Patching");
	const patchText = typeof args.input === "string" ? args.input : "";
	if (patchText.trim().length === 0) return theme.bold("Patching");
	const cached = context?.toolCallId ? renderStates.get(context.toolCallId) : undefined;
	const cwd = context?.cwd ?? cached?.cwd ?? process.cwd();
	const base = context?.expanded ? formatApplyPatchPreview(cached?.patchText ?? patchText, cwd) : formatApplyPatchSummary(cached?.patchText ?? patchText, cwd);
	if (!base) {
		if (cached?.status === "failed") return theme.fg("error", "Edit failed");
		return theme.bold("Patching");
	}
	if (cached?.status === "partial_failure") return renderFailureCall(base, theme, "warning", "Edit partially failed", cached.failedTargets);
	if (cached?.status === "failed") return renderFailureCall(base, theme, "error", "Edit failed", cached.failedTargets);
	return base;
}

function renderFailureCall(base: string, theme: { fg(role: string, text: string): string }, role: "warning" | "error", title: string, failedTargets?: string[]): string {
	const lines = base.split("\n");
	const firstLineWithoutVerb = lines[0]!.replace(/^(?:•\s*)?(Added|Deleted|Moved)\b\s*/, "");
	lines[0] = `${title} ${firstLineWithoutVerb}`.trimEnd();
	return lines
		.map((line, index) => {
			const isFailed = failedTargets?.some((target) => line.includes(target));
			if (index === 0 || isFailed) return theme.fg(role, line);
			return line;
		})
		.join("\n");
}

function formatApplyPatchSummary(patchText: string, cwd: string): string {
	const files = buildFilePreviews(patchText, cwd);
	return formatApplyPatchSummaryFromFiles(files, cwd);
}

type FilePreview = { verb: "Added" | "Deleted" | "update" | "Moved"; path: string; movePath?: string; added: number; removed: number; lines: string[] };

function formatApplyPatchSummaryFromFiles(files: FilePreview[], cwd: string): string {
	if (files.length === 0) return "";
	const totals = files.reduce((acc, file) => ({ added: acc.added + file.added, removed: acc.removed + file.removed }), { added: 0, removed: 0 });
	if (files.length === 1) {
		const file = files[0]!;
		if (file.verb === "update") return withCounts(formatPatchTarget(file.path, file.movePath, cwd), file.added, file.removed);
		return withCounts(bulletHeader(file.verb, formatPatchTarget(file.path, file.movePath, cwd)), file.added, file.removed);
	}
	return [withCounts(`${files.length} files`, totals.added, totals.removed), ...files.map((file) => `  └ ${withCounts(formatPatchTarget(file.path, file.movePath, cwd), file.added, file.removed)}`)].join("\n");
}

function formatApplyPatchPreview(patchText: string, cwd: string): string {
	const files = buildFilePreviews(patchText, cwd);
	if (files.length === 0) return "";
	const summary = formatApplyPatchSummary(patchText, cwd).split("\n");
	const lines = [...summary];
	for (const file of files) {
		if (files.length > 1) lines.push("");
		for (const line of file.lines.slice(0, 80)) lines.push(`    ${line}`);
		if (file.lines.length > 80) lines.push(`    ... (${file.lines.length - 80} more lines)`);
	}
	return lines.join("\n");
}

function formatApplyPatchDiff(patchText: string, cwd: string): string {
	const files = buildFilePreviews(patchText, cwd);
	return formatApplyPatchDiffFromFiles(files, cwd);
}

function formatApplyPatchDiffFromFiles(files: FilePreview[], cwd: string): string {
	if (files.length === 0) return "";
	const lines: string[] = [];
	const filesWithChanges = files.filter((file) => file.lines.length > 0);
	for (const [index, file] of filesWithChanges.entries()) {
		if (index > 0) lines.push("");
		if (files.length > 1) lines.push(withCounts(formatPatchTarget(file.path, file.movePath, cwd), file.added, file.removed));
		lines.push(...file.lines);
	}
	return lines.join("\n");
}

function buildFilePreviews(patchText: string, cwd: string): FilePreview[] {
	try {
		return parsePatchActions(patchText).map((action) => {
			if (action.type === "add") {
				const lines = splitFileLines(action.newFile ?? "");
				return { verb: "Added", path: action.path, added: lines.length, removed: 0, lines: formatNumberedDiffLines(lines.map((text, index) => ({ marker: "+", lineNumber: index + 1, text }))) };
			}
			if (action.type === "delete") {
				const lines = readFileLines(cwd, action.path);
				return { verb: "Deleted", path: action.path, added: 0, removed: lines.length, lines: formatNumberedDiffLines(lines.map((text, index) => ({ marker: "-", lineNumber: index + 1, text }))) };
			}
			const body = action.lines ?? [];
			const numbered = numberUpdateDiffLines(readFileLines(cwd, action.path), body);
			const updatePreview = buildUpdatePreview(numbered, Boolean(action.movePath));
			return { verb: updatePreview.pureMove ? "Moved" : "update", path: action.path, movePath: action.movePath, ...updatePreview };
		});
	} catch {
		return [];
	}
}

function readFileLines(cwd: string, path: string): string[] {
	try {
		return splitFileLines(readFileSync(resolvePatchPath(cwd, path), "utf8"));
	} catch {
		return [];
	}
}

function splitFileLines(text: string): string[] {
	if (text.length === 0) return [];
	const lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines;
}

function bulletHeader(verb: string, label: string): string {
	return `${verb} ${label}`;
}

function withCounts(label: string, added: number, removed: number): string {
	const counts = renderCounts(added, removed);
	return counts ? `${label} ${counts}` : label;
}

function renderCounts(added: number, removed: number): string {
	if (added === 0 && removed === 0) return "";
	return `+${added} -${removed}`;
}

function formatPatchTarget(path: string, movePath: string | undefined, cwd: string): string {
	const from = displayPath(path, cwd);
	return movePath ? `${from} → ${displayPath(movePath, cwd)}` : from;
}

function displayPath(path: string, cwd: string): string {
	if (!isAbsolute(path)) return path;
	const relativePath = relative(cwd, path);
	return relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath) ? relativePath : path;
}

function safeParseActions(patchText: string): ParsedPatchAction[] {
	try {
		return parsePatchActions(patchText);
	} catch {
		return [];
	}
}

function uniqueStrings(values: Array<string | undefined>): string[] {
	return Array.from(new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0)));
}

function isApplyPatchToolDetails(details: unknown): details is ApplyPatchToolDetails {
	return typeof details === "object" && details !== null && "status" in details && "result" in details;
}
