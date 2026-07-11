import {
	CustomEditor,
	type ExtensionAPI,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";

declare global {
	var __piAgentPulseEditorLine: ((width: number, borderColor: (text: string) => string) => string | undefined) | undefined;
	var __piAgentPulseRequestRender: (() => void) | undefined;
	var __piBeforeEditorSubmit: ((text: string) => boolean | Promise<boolean>) | undefined;
}

const SKILL_AUTOCOMPLETE_CONTEXT = /(?:^|[\s([{])\$[a-z0-9-]*$/;

function stripAnsi(text: string) {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}


class PiConfigEditor extends CustomEditor {
	private autocompleteRequestVersion = 0;
	private pulseBorderColor: (text: string) => string;
	private wrappedSubmit?: (text: string) => void;

	constructor(
		tui: TUI,
		private readonly editorTheme: EditorTheme,
		keybindings: KeybindingsManager,
	) {
		super(tui, editorTheme, keybindings);
		globalThis.__piAgentPulseRequestRender = () => tui.requestRender();
		delete (this as { onSubmit?: (text: string) => void }).onSubmit;
		this.pulseBorderColor = editorTheme.borderColor;
	}

	override get onSubmit(): ((text: string) => void) | undefined {
		return this.wrappedSubmit;
	}

	override set onSubmit(handler: ((text: string) => void) | undefined) {
		if (!handler) {
			this.wrappedSubmit = undefined;
			return;
		}

		this.wrappedSubmit = (text: string) => {
			const beforeSubmit = globalThis.__piBeforeEditorSubmit;
			if (!beforeSubmit) {
				handler(text);
				return;
			}

			void Promise.resolve(beforeSubmit(text.trim())).then((handled) => {
				if (handled) this.setText("");
				else handler(text);
			});
		};
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
		const lines = super.render(width).filter((line) => {
			const plain = stripAnsi(line).trim();
			return !/^─{3,}(?: [↑↓] \d+ more ─*)?$/.test(plain);
		});
		const editorText = this.getLines().join("\n").trimStart();
		if (!editorText.startsWith("!")) this.pulseBorderColor = this.borderColor;
		const pulseLine = globalThis.__piAgentPulseEditorLine?.(width, this.pulseBorderColor);
		return pulseLine ? [pulseLine, ...lines] : lines;
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
		globalThis.__piAgentPulseRequestRender = undefined;
		ctx.ui.setEditorComponent(undefined);
	});
}
