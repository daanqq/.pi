/**
 * Agent Status Extension
 *
 * Terminal-level status signals for pi agent activity:
 * - owns the terminal title while loaded;
 * - shows working/tool/done/error states;
 * - rings the terminal bell when an agent turn finishes.
 *
 * Do not enable together with other extensions that continuously call ctx.ui.setTitle().
 */

import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 120;
const DONE_HOLD_MS = 8000;
const MAX_SESSION_LENGTH = 36;
const MAX_CWD_LENGTH = 24;

function truncate(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	if (maxLength <= 1) return value.slice(0, maxLength);
	return `${value.slice(0, maxLength - 1)}…`;
}

function cwdLabel(ctx?: ExtensionContext): string {
	const cwd = ctx?.cwd ?? process.cwd();
	return truncate(path.basename(cwd) || cwd, MAX_CWD_LENGTH);
}

function contextLabel(pi: ExtensionAPI, ctx?: ExtensionContext): string {
	const session = pi.getSessionName();
	const cwd = cwdLabel(ctx);
	if (!session) return cwd;
	return `${truncate(session, MAX_SESSION_LENGTH)} - ${cwd}`;
}

function ringBell() {
	process.stdout.write("\x07");
}

export default function (pi: ExtensionAPI) {
	let spinnerTimer: ReturnType<typeof setInterval> | null = null;
	let doneTimer: ReturnType<typeof setTimeout> | null = null;
	let frameIndex = 0;
	let hadToolError = false;
	let lastToolName: string | undefined;
	const activeTools = new Set<string>();

	function clearSpinner() {
		if (spinnerTimer) {
			clearInterval(spinnerTimer);
			spinnerTimer = null;
		}
		frameIndex = 0;
	}

	function clearDoneTimer() {
		if (doneTimer) {
			clearTimeout(doneTimer);
			doneTimer = null;
		}
	}

	function setIdleTitle(ctx: ExtensionContext) {
		ctx.ui.setTitle(`π ${contextLabel(pi, ctx)}`);
	}

	function setDoneTitle(ctx: ExtensionContext) {
		const state = hadToolError ? "✗ π error" : "✓ π done";
		ctx.ui.setTitle(`${state} - ${contextLabel(pi, ctx)}`);
	}

	function renderActiveTitle(ctx: ExtensionContext) {
		if (activeTools.size > 0 && lastToolName) {
			const extraTools = activeTools.size - 1;
			const suffix = extraTools > 0 ? ` +${extraTools}` : "";
			ctx.ui.setTitle(`⚙ π ${lastToolName}${suffix} - ${contextLabel(pi, ctx)}`);
			return;
		}

		const frame = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length];
		ctx.ui.setTitle(`${frame} π working - ${contextLabel(pi, ctx)}`);
		frameIndex++;
	}

	function startWorking(ctx: ExtensionContext) {
		clearSpinner();
		clearDoneTimer();
		hadToolError = false;
		lastToolName = undefined;
		activeTools.clear();
		renderActiveTitle(ctx);
		spinnerTimer = setInterval(() => renderActiveTitle(ctx), SPINNER_INTERVAL_MS);
	}

	function finishWorking(ctx: ExtensionContext) {
		clearSpinner();
		clearDoneTimer();
		activeTools.clear();
		lastToolName = undefined;
		setDoneTitle(ctx);
		ringBell();
		doneTimer = setTimeout(() => {
			setIdleTitle(ctx);
			doneTimer = null;
		}, DONE_HOLD_MS);
	}

	function resetToIdle(ctx: ExtensionContext) {
		clearSpinner();
		clearDoneTimer();
		activeTools.clear();
		lastToolName = undefined;
		hadToolError = false;
		setIdleTitle(ctx);
	}

	pi.on("session_start", async (_event, ctx) => {
		resetToIdle(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		startWorking(ctx);
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		activeTools.add(event.toolCallId);
		lastToolName = event.toolName;
		renderActiveTitle(ctx);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		activeTools.delete(event.toolCallId);
		if (event.isError) hadToolError = true;
		if (activeTools.size === 0) lastToolName = undefined;
		renderActiveTitle(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		finishWorking(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		resetToIdle(ctx);
	});
}
