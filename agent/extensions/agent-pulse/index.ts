/**
 * Agent Pulse Extension
 *
 * Unified pi agent activity signals:
 * - replaces the built-in working indicator with a themed thinking shimmer;
 * - owns the terminal title while loaded;
 * - shows working/tool/done states;
 * - rings the terminal bell when an agent turn finishes.
 *
 * Do not enable together with other extensions that continuously call ctx.ui.setTitle()
 * or replace the built-in working indicator.
 */

import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const SPINNER_VERBS = [
	"Accomplishing",
	"Actioning",
	"Actualizing",
	"Architecting",
	"Baking",
	"Beaming",
	"Beboppin'",
	"Befuddling",
	"Billowing",
	"Blanching",
	"Bloviating",
	"Boogieing",
	"Boondoggling",
	"Booping",
	"Bootstrapping",
	"Brewing",
	"Bunning",
	"Burrowing",
	"Calculating",
	"Canoodling",
	"Caramelizing",
	"Cascading",
	"Catapulting",
	"Cerebrating",
	"Channeling",
	"Channelling",
	"Choreographing",
	"Churning",
	"Clauding",
	"Coalescing",
	"Cogitating",
	"Combobulating",
	"Composing",
	"Computing",
	"Concocting",
	"Considering",
	"Contemplating",
	"Cooking",
	"Crafting",
	"Creating",
	"Crunching",
	"Crystallizing",
	"Cultivating",
	"Deciphering",
	"Deliberating",
	"Determining",
	"Dilly-dallying",
	"Discombobulating",
	"Doing",
	"Doodling",
	"Drizzling",
	"Ebbing",
	"Effecting",
	"Elucidating",
	"Embellishing",
	"Enchanting",
	"Envisioning",
	"Evaporating",
	"Fermenting",
	"Fiddle-faddling",
	"Finagling",
	"Flambéing",
	"Flibbertigibbeting",
	"Flowing",
	"Flummoxing",
	"Fluttering",
	"Forging",
	"Forming",
	"Frolicking",
	"Frosting",
	"Gallivanting",
	"Galloping",
	"Garnishing",
	"Generating",
	"Gesticulating",
	"Germinating",
	"Gitifying",
	"Grooving",
	"Gusting",
	"Harmonizing",
	"Hashing",
	"Hatching",
	"Herding",
	"Honking",
	"Hullaballooing",
	"Hyperspacing",
	"Ideating",
	"Imagining",
	"Improvising",
	"Incubating",
	"Inferring",
	"Infusing",
	"Ionizing",
	"Jitterbugging",
	"Julienning",
	"Kneading",
	"Leavening",
	"Levitating",
	"Lollygagging",
	"Manifesting",
	"Marinating",
	"Meandering",
	"Metamorphosing",
	"Misting",
	"Moonwalking",
	"Moseying",
	"Mulling",
	"Mustering",
	"Musing",
	"Nebulizing",
	"Nesting",
	"Newspapering",
	"Noodling",
	"Nucleating",
	"Orbiting",
	"Orchestrating",
	"Osmosing",
	"Perambulating",
	"Percolating",
	"Perusing",
	"Philosophising",
	"Photosynthesizing",
	"Pollinating",
	"Pondering",
	"Pontificating",
	"Pouncing",
	"Precipitating",
	"Prestidigitating",
	"Processing",
	"Proofing",
	"Propagating",
	"Puttering",
	"Puzzling",
	"Quantumizing",
	"Razzle-dazzling",
	"Razzmatazzing",
	"Recombobulating",
	"Reticulating",
	"Roosting",
	"Ruminating",
	"Sautéing",
	"Scampering",
	"Schlepping",
	"Scurrying",
	"Seasoning",
	"Shenaniganing",
	"Shimmying",
	"Simmering",
	"Skedaddling",
	"Sketching",
	"Slithering",
	"Smooshing",
	"Sock-hopping",
	"Spelunking",
	"Spinning",
	"Sprouting",
	"Stewing",
	"Sublimating",
	"Swirling",
	"Swooping",
	"Symbioting",
	"Synthesizing",
	"Tempering",
	"Thinking",
	"Thundering",
	"Tinkering",
	"Tomfoolering",
	"Topsy-turvying",
	"Transfiguring",
	"Transmuting",
	"Twisting",
	"Undulating",
	"Unfurling",
	"Unravelling",
	"Vibing",
	"Waddling",
	"Wandering",
	"Warping",
	"Whatchamacalliting",
	"Whirlpooling",
	"Whirring",
	"Whisking",
	"Wibbling",
	"Working",
	"Wrangling",
	"Zesting",
	"Zigzagging",
] as const;

const SPINNER_CHARACTERS = ["·", "✢", "✶", "✻", "✽"] as const;
const SPINNER_FRAMES = [...SPINNER_CHARACTERS, ...[...SPINNER_CHARACTERS].reverse()];
const SPINNER_RENDER_INTERVAL_MS = 50;
const SPINNER_FRAME_MS = 120;
const SHIMMER_FRAME_MS = 50;
const SHIMMER_TRAILING_GAP = 4;
const TITLE_DONE_HOLD_MS = 8000;
const MAX_SESSION_LENGTH = 36;
const MAX_CWD_LENGTH = 24;
const WIDGET_ID = "agent-pulse";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

type ColorFn = (text: string) => string;

function normalizeThinkingLevel(level: string): ThinkingLevel {
	switch (level) {
		case "off":
		case "minimal":
		case "low":
		case "medium":
		case "high":
		case "xhigh":
			return level;
		default:
			return "medium";
	}
}

function sampleVerb(): string {
	return SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)] ?? "Thinking";
}

function spinnerFrame(elapsedMs: number): string {
	return SPINNER_FRAMES[Math.floor(elapsedMs / SPINNER_FRAME_MS) % SPINNER_FRAMES.length] ?? "✻";
}

function formatElapsed(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

function formatFinalDuration(ms: number): string {
	return `Worked for ${formatElapsed(ms)}`;
}

function renderShimmeredMessage(message: string, elapsedMs: number, base: ColorFn, bright: ColorFn): string {
	const chars = Array.from(message);
	const shimmerCenter = Math.floor(elapsedMs / SHIMMER_FRAME_MS) % (chars.length + SHIMMER_TRAILING_GAP);
	return chars
		.map((char, index) => {
			const distance = Math.abs(index - shimmerCenter);
			return distance <= 1 ? bright(char) : base(char);
		})
		.join("");
}

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
	let renderTimer: ReturnType<typeof setInterval> | null = null;
	let titleDoneTimer: ReturnType<typeof setTimeout> | null = null;
	let message = "Thinking…";
	let startTime = 0;
	let totalPausedMs = 0;
	let pauseStartTime: number | null = null;
	let active = false;
	let lastFrame = "✻";
	let lastToolName: string | undefined;
	const activeTools = new Set<string>();
	// Do not call pi.getThinkingLevel() during extension loading: action methods
	// are only available after the runtime is initialized. The real value is
	// captured on agent_start.
	let frozenThinkingLevel: ThinkingLevel = "low";

	function getElapsedMs(): number {
		if (pauseStartTime !== null) return pauseStartTime - startTime - totalPausedMs;
		return Date.now() - startTime - totalPausedMs;
	}

	function clearRenderTimer() {
		if (renderTimer) {
			clearInterval(renderTimer);
			renderTimer = null;
		}
	}

	function clearTitleDoneTimer() {
		if (titleDoneTimer) {
			clearTimeout(titleDoneTimer);
			titleDoneTimer = null;
		}
	}

	function setThemedWidget(ctx: ExtensionContext, renderLineWithColors: (base: ColorFn, bright: ColorFn) => string) {
		const level = frozenThinkingLevel;
		ctx.ui.setWidget(
			WIDGET_ID,
			(_tui, theme) => ({
				render: () => {
					// Use the same resolver as the editor border to avoid tiny shade differences
					// between the activity pulse and the input border/project label.
					const borderColor = theme.getThinkingBorderColor(level);
					// Keep the hue identical to the editor border, but make the shimmer band bold
					// so the message visibly pulses while staying in the same color family.
					const bright = (text: string) => theme.bold(borderColor(text));
					return [`  ${renderLineWithColors(borderColor, bright)}`];
				},
				invalidate: () => {},
			}),
			{ placement: "aboveEditor" },
		);
	}

	function renderWidget(ctx: ExtensionContext) {
		const elapsedMs = getElapsedMs();
		lastFrame = spinnerFrame(elapsedMs);
		setThemedWidget(ctx, (base, bright) => {
			const line = `${message} ${formatElapsed(elapsedMs)}`;
			return `${base(lastFrame)} ${renderShimmeredMessage(line, elapsedMs, base, bright)}`;
		});
	}

	function renderFinalWidget(ctx: ExtensionContext, finalElapsedMs: number) {
		setThemedWidget(ctx, (base) => `${base("✻")} ${base(formatFinalDuration(finalElapsedMs))}`);
	}

	function setIdleTitle(ctx: ExtensionContext) {
		ctx.ui.setTitle(contextLabel(pi, ctx));
	}

	function setDoneTitle(ctx: ExtensionContext) {
		ctx.ui.setTitle(`${lastFrame} done - ${contextLabel(pi, ctx)}`);
	}

	function renderTitle(ctx: ExtensionContext) {
		if (activeTools.size > 0 && lastToolName) {
			const extraTools = activeTools.size - 1;
			const suffix = extraTools > 0 ? ` +${extraTools}` : "";
			ctx.ui.setTitle(`⚙ ${lastToolName}${suffix} - ${contextLabel(pi, ctx)}`);
			return;
		}

		const elapsedMs = getElapsedMs();
		lastFrame = spinnerFrame(elapsedMs);
		ctx.ui.setTitle(`${lastFrame} ${message.replace(/…$/, "")} - ${contextLabel(pi, ctx)}`);
	}

	function renderActive(ctx: ExtensionContext) {
		renderWidget(ctx);
		renderTitle(ctx);
	}

	function stopActiveTimerOnly() {
		clearRenderTimer();
		active = false;
	}

	function resetRuntimeState() {
		active = false;
		pauseStartTime = null;
		totalPausedMs = 0;
		activeTools.clear();
		lastToolName = undefined;
	}

	function resetToIdle(ctx: ExtensionContext) {
		clearRenderTimer();
		clearTitleDoneTimer();
		resetRuntimeState();
		ctx.ui.setWidget(WIDGET_ID, undefined);
		ctx.ui.setWorkingVisible(true);
		setIdleTitle(ctx);
	}

	function pauseElapsed() {
		if (!renderTimer || pauseStartTime !== null) return;
		pauseStartTime = Date.now();
	}

	function resumeElapsed() {
		if (pauseStartTime === null) return;
		totalPausedMs += Date.now() - pauseStartTime;
		pauseStartTime = null;
	}

	function start(ctx: ExtensionContext) {
		resetToIdle(ctx);
		const verb = sampleVerb();
		message = `${verb}…`;
		startTime = Date.now();
		totalPausedMs = 0;
		pauseStartTime = null;
		active = true;
		lastFrame = spinnerFrame(0);
		// Freeze the thinking-level color for this whole model response.
		// If the user changes thinking level mid-response, the loader keeps this color
		// until the next agent_start.
		frozenThinkingLevel = normalizeThinkingLevel(pi.getThinkingLevel());
		ctx.ui.setWorkingVisible(false);
		renderActive(ctx);
		renderTimer = setInterval(() => renderActive(ctx), SPINNER_RENDER_INTERVAL_MS);
	}

	function finish(ctx: ExtensionContext) {
		if (!active) {
			resetToIdle(ctx);
			return;
		}

		const finalElapsedMs = getElapsedMs();
		stopActiveTimerOnly();
		pauseStartTime = null;
		totalPausedMs = 0;
		activeTools.clear();
		lastToolName = undefined;
		renderFinalWidget(ctx, finalElapsedMs);
		ctx.ui.setWorkingVisible(true);
		setDoneTitle(ctx);
		ringBell();

		clearTitleDoneTimer();
		titleDoneTimer = setTimeout(() => {
			setIdleTitle(ctx);
			titleDoneTimer = null;
		}, TITLE_DONE_HOLD_MS);
	}

	pi.on("session_start", async (_event, ctx) => {
		resetToIdle(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		start(ctx);
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		activeTools.add(event.toolCallId);
		lastToolName = event.toolName;
		if (event.toolName === "answer_questions") pauseElapsed();
		renderActive(ctx);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		activeTools.delete(event.toolCallId);
		if (activeTools.size === 0) lastToolName = undefined;
		if (event.toolName === "answer_questions") resumeElapsed();
		renderActive(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		finish(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		resetToIdle(ctx);
	});
}
