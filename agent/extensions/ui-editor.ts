import {
	CustomEditor,
	type ExtensionAPI,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const SKILL_AUTOCOMPLETE_CONTEXT = /(?:^|[\s([{])\$[a-z0-9-]*$/;
// Keep the custom editor status border visually connected. A plain ASCII dash
// has side bearings in most terminal fonts, while the heavy box-drawing glyph
// tends to stay continuous and reads better in dim "thinking off" themes.
const EDITOR_BORDER_CHAR = "―";

function fitBorder(
	left: string,
	right: string,
	width: number,
	border: (text: string) => string,
	fill: (text: string) => string = border,
): string {
	if (width <= 0) return "";
	if (width === 1) return border(EDITOR_BORDER_CHAR);

	let leftText = left;
	let rightText = right;
	const fixedWidth = 2;
	const minimumGap = 3;

	while (fixedWidth + visibleWidth(leftText) + visibleWidth(rightText) + minimumGap > width && visibleWidth(rightText) > 0) {
		rightText = truncateToWidth(rightText, Math.max(0, visibleWidth(rightText) - 1), "");
	}
	while (fixedWidth + visibleWidth(leftText) + visibleWidth(rightText) + minimumGap > width && visibleWidth(leftText) > 0) {
		leftText = truncateToWidth(leftText, Math.max(0, visibleWidth(leftText) - 1), "");
	}

	const gapWidth = Math.max(0, width - fixedWidth - visibleWidth(leftText) - visibleWidth(rightText));
	return `${border(EDITOR_BORDER_CHAR)}${leftText}${fill(EDITOR_BORDER_CHAR.repeat(gapWidth))}${rightText}${border(EDITOR_BORDER_CHAR)}`;
}

function formatProjectLabel(cwd: string, branch: string | undefined) {
	const home = process.env.HOME || process.env.USERPROFILE;
	let project = cwd;
	if (home && project.startsWith(home)) project = `~${project.slice(home.length)}`;
	return `${project}${branch ? ` (${branch})` : ""}`;
}

function formatModelLabel(modelId: string | undefined, reasoning: boolean | undefined, thinkingLevel: string) {
	const modelName = modelId || "no-model";
	if (!reasoning) return modelName;
	return thinkingLevel === "off" ? `${modelName} thinking off` : `${modelName} ${thinkingLevel}`;
}

function stripAnsi(text: string) {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function isEditorBorderLine(line: string) {
	const plain = stripAnsi(line);
	return /^[─━═╌┄┈―—_▔▁-]+$/.test(plain) || /^[─━═╌┄┈―—_▔▁-]{3} [↑↓] \d+ more [─━═╌┄┈―—_▔▁-]*$/.test(plain);
}

function findBottomBorderIndex(lines: string[]) {
	for (let index = lines.length - 1; index >= 0; index--) {
		if (isEditorBorderLine(lines[index] ?? "")) return index;
	}
	return -1;
}

function restyleBorderLine(line: string, color: (text: string) => string) {
	const plain = stripAnsi(line);
	if (!isEditorBorderLine(plain)) return line;
	return color(plain.replace(/[─━═╌┄┈―—_▔▁-]/g, EDITOR_BORDER_CHAR));
}

class PiConfigEditor extends CustomEditor {
	private autocompleteRequestVersion = 0;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		private readonly getProjectLabel: () => string,
		private readonly getModelLabel: () => string,
	) {
		super(tui, theme, keybindings);
	}

	override handleInput(data: string): void {
		const wasShowingAutocomplete = this.isShowingAutocomplete();
		this.autocompleteRequestVersion++;
		super.handleInput(data);

		// If autocomplete handled this key (e.g. Enter selected `$tdd`), do not
		// immediately reopen it for completed `$tdd`. Otherwise next Space fights
		// stale completion state and can fall through to file completion.
		if (wasShowingAutocomplete) return;

		// Pi's built-in editor auto-opens completion for `/`, `@`, and `#` only.
		// Do not trust `data` here: terminals with enhanced keyboard protocols can
		// send shifted printable keys (like `$`) as escape sequences. Inspect the
		// editor state after the base editor has handled the input instead.
		if (this.isShowingAutocomplete()) return;

		const cursor = this.getCursor();
		const line = this.getLines()[cursor.line] ?? "";
		const beforeCursor = line.slice(0, cursor.col);
		if (!SKILL_AUTOCOMPLETE_CONTEXT.test(beforeCursor)) return;

		const requestVersion = this.autocompleteRequestVersion;
		queueMicrotask(() => {
			if (requestVersion !== this.autocompleteRequestVersion) return;
			if (this.isShowingAutocomplete()) return;
			(this as unknown as { tryTriggerAutocomplete(): void }).tryTriggerAutocomplete();
		});
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length < 2) return lines;

		const leftLabel = this.getProjectLabel();
		const rightLabel = this.getModelLabel();
		if (!leftLabel && !rightLabel) return lines;

		const bottomBorderIndex = findBottomBorderIndex(lines);
		if (bottomBorderIndex < 0) return lines;

		const borderColor = (text: string) => this.borderColor(text);
		for (let index = 0; index < lines.length; index++) {
			if (index === bottomBorderIndex) continue;
			lines[index] = restyleBorderLine(lines[index] ?? "", borderColor);
		}
		lines[bottomBorderIndex] = fitBorder(leftLabel, rightLabel, width, borderColor);
		return lines;
	}
}

export default function editorUiExtension(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;

		let branch: string | undefined;
		let requestRender: (() => void) | undefined;
		const refreshBranch = async () => {
			const result = await pi.exec("git", ["branch", "--show-current"], { cwd: ctx.cwd }).catch(() => undefined);
			const stdout = result?.stdout.trim();
			branch = stdout && stdout.length > 0 ? stdout : undefined;
			requestRender?.();
		};
		void refreshBranch();

		ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
			requestRender = () => tui.requestRender();
			let editor: PiConfigEditor;
			editor = new PiConfigEditor(
				tui,
				editorTheme,
				keybindings,
				() => editor.borderColor(` ${formatProjectLabel(ctx.cwd, branch)} `),
				() => editor.borderColor(` ${formatModelLabel(ctx.model?.id, ctx.model?.reasoning, pi.getThinkingLevel())} `),
			);
			return editor;
		});
	});

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setEditorComponent(undefined);
	});
}
