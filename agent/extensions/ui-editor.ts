import {
	CustomEditor,
	type ExtensionAPI,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";

const SKILL_AUTOCOMPLETE_CONTEXT = /(?:^|[\s([{])\$[a-z0-9-]*$/;

function stripAnsi(text: string) {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}


class PiConfigEditor extends CustomEditor {
	private autocompleteRequestVersion = 0;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
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
		return super.render(width).filter((line) => {
			const plain = stripAnsi(line).trim();
			return !/^─{3,}(?: [↑↓] \d+ more ─*)?$/.test(plain);
		});
	}
}

export default function editorUiExtension(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;

		ctx.ui.setEditorComponent((tui, editorTheme, keybindings) =>
			new PiConfigEditor(tui, editorTheme, keybindings),
		);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setEditorComponent(undefined);
	});
}
