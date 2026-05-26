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

const DEFAULT_CHARACTERS = ["·", "✢", "✳", "✶", "✻", "✽"] as const;
const SPINNER_FRAMES = [...DEFAULT_CHARACTERS, ...[...DEFAULT_CHARACTERS].reverse()];

type ThinkingColorKey =
	| "thinkingOff"
	| "thinkingMinimal"
	| "thinkingLow"
	| "thinkingMedium"
	| "thinkingHigh"
	| "thinkingXhigh";

type ColorFn = (text: string) => string;

function getThinkingColorKey(level: string): ThinkingColorKey {
	switch (level) {
		case "off":
			return "thinkingOff";
		case "minimal":
			return "thinkingMinimal";
		case "low":
			return "thinkingLow";
		case "high":
			return "thinkingHigh";
		case "xhigh":
			return "thinkingXhigh";
		case "medium":
		default:
			return "thinkingMedium";
	}
}

function sampleVerb(): string {
	return SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)] ?? "Thinking";
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

function renderGlyph(elapsedMs: number, base: ColorFn): string {
	const frame = SPINNER_FRAMES[Math.floor(elapsedMs / 120) % SPINNER_FRAMES.length] ?? "✻";
	return base(frame);
}

function renderShimmeredMessage(message: string, elapsedMs: number, base: ColorFn, bright: ColorFn): string {
	const chars = Array.from(message);
	const shimmerCenter = Math.floor(elapsedMs / 50) % (chars.length + 4);
	return chars
		.map((char, index) => {
			const distance = Math.abs(index - shimmerCenter);
			return distance <= 1 ? bright(char) : base(char);
		})
		.join("");
}

function getElapsedMs(startTime: number, totalPausedMs: number, pauseStartTime: number | null): number {
	const now = Date.now();
	if (pauseStartTime !== null) return pauseStartTime - startTime - totalPausedMs;
	return now - startTime - totalPausedMs;
}

function renderLine(
	message: string,
	startTime: number,
	totalPausedMs: number,
	pauseStartTime: number | null,
	base: ColorFn,
	bright: ColorFn,
): string {
	const elapsedMs = getElapsedMs(startTime, totalPausedMs, pauseStartTime);
	return `${renderGlyph(elapsedMs, base)} ${renderShimmeredMessage(message, elapsedMs, base, bright)} ${base(formatElapsed(elapsedMs))}`;
}

function renderFinalLine(finalElapsedMs: number, base: ColorFn): string {
	return `${base("✻")} ${base(formatFinalDuration(finalElapsedMs))}`;
}

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | null = null;
	let finalTimer: ReturnType<typeof setTimeout> | null = null;
	let message = "Thinking…";
	let startTime = 0;
	let totalPausedMs = 0;
	let pauseStartTime: number | null = null;
	let active = false;
	// Do not call pi.getThinkingLevel() during extension loading: action methods
	// are only available after the runtime is initialized. The real value is
	// captured on agent_start.
	let frozenThinkingColorKey: ThinkingColorKey = "thinkingLow";

	function setThemedWidget(ctx: ExtensionContext, renderLineWithColors: (base: ColorFn, bright: ColorFn) => string) {
		const colorKey = frozenThinkingColorKey;
		ctx.ui.setWidget(
			"thinking-shimmer",
			(_tui, theme) => ({
				render: () => {
					const base = (text: string) => theme.fg(colorKey, text);
					// Use the same thinking-level hue for shimmer as requested; bold gives a subtle glimmer
					// without switching to a different color family.
					const bright = (text: string) => theme.bold(theme.fg(colorKey, text));
					return [renderLineWithColors(base, bright)];
				},
				invalidate: () => {},
			}),
			{ placement: "aboveEditor" },
		);
	}

	function render(ctx: ExtensionContext) {
		setThemedWidget(ctx, (base, bright) => renderLine(message, startTime, totalPausedMs, pauseStartTime, base, bright));
	}

	function renderFinal(ctx: ExtensionContext, finalElapsedMs: number) {
		setThemedWidget(ctx, (base) => renderFinalLine(finalElapsedMs, base));
	}

	function stop(ctx: ExtensionContext) {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		if (finalTimer) {
			clearTimeout(finalTimer);
			finalTimer = null;
		}
		active = false;
		pauseStartTime = null;
		totalPausedMs = 0;
		ctx.ui.setWidget("thinking-shimmer", undefined);
		ctx.ui.setWorkingVisible(true);
	}

	function stopActiveTimerOnly() {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		active = false;
	}

	function pauseElapsed() {
		if (!timer || pauseStartTime !== null) return;
		pauseStartTime = Date.now();
	}

	function resumeElapsed() {
		if (pauseStartTime === null) return;
		totalPausedMs += Date.now() - pauseStartTime;
		pauseStartTime = null;
	}

	function start(ctx: ExtensionContext) {
		stop(ctx);
		message = `${sampleVerb()}…`;
		startTime = Date.now();
		totalPausedMs = 0;
		pauseStartTime = null;
		active = true;
		// Freeze the thinking-level color for this whole model response.
		// If the user changes thinking level mid-response, the loader keeps this color
		// until the next agent_start.
		frozenThinkingColorKey = getThinkingColorKey(pi.getThinkingLevel());
		ctx.ui.setWorkingVisible(false);
		render(ctx);
		timer = setInterval(() => render(ctx), 50);
	}

	pi.on("agent_start", async (_event, ctx) => {
		start(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!active) {
			stop(ctx);
			return;
		}

		const finalElapsedMs = getElapsedMs(startTime, totalPausedMs, pauseStartTime);
		stopActiveTimerOnly();
		pauseStartTime = null;
		totalPausedMs = 0;
		renderFinal(ctx, finalElapsedMs);
		ctx.ui.setWorkingVisible(true);
		finalTimer = setTimeout(() => {
			finalTimer = null;
			ctx.ui.setWidget("thinking-shimmer", undefined);
		}, 5000);
	});

	pi.on("tool_execution_start", async (event) => {
		if (event.toolName === "answer_questions") pauseElapsed();
	});

	pi.on("tool_execution_end", async (event) => {
		if (event.toolName === "answer_questions") resumeElapsed();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stop(ctx);
	});
}
