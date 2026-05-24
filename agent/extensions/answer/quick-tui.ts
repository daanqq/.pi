import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { ExtractedQuestion } from "./utils";

export interface QuickAnswerResult {
	answer: string;
	selectedOptionIndex?: number;
	wasCustom: boolean;
}

export async function collectQuickAnswer(
	ctx: ExtensionContext,
	question: ExtractedQuestion & { required?: boolean; multiline?: boolean },
): Promise<QuickAnswerResult | null> {
	return await ctx.ui.custom<QuickAnswerResult | null>((tui, theme, _kb, done) => {
		const options = question.options ?? [];
		const otherIndex = options.length;
		let selectedIndex = 0;
		let editing = options.length === 0;
		let hint = "";
		let cachedLines: string[] | undefined;

		const editorTheme: EditorTheme = {
			borderColor: (s) => theme.fg("accent", s),
			selectList: {},
		};
		const editor = new Editor(tui, editorTheme);
		editor.disableSubmit = true;

		function refresh() {
			cachedLines = undefined;
			tui.requestRender();
		}

		function submitCustom() {
			const answer = editor.getText();
			if (question.required !== false && answer.trim().length === 0) {
				hint = "Введите ответ";
				refresh();
				return;
			}
			done({ answer, selectedOptionIndex: options.length > 0 ? otherIndex : undefined, wasCustom: true });
		}

		function submitSelected() {
			if (selectedIndex === otherIndex) {
				editing = true;
				refresh();
				return;
			}
			const selected = options[selectedIndex];
			if (!selected) return;
			done({ answer: selected.label, selectedOptionIndex: selectedIndex, wasCustom: false });
		}

		function handleInput(data: string) {
			hint = "";
			if (matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.escape)) {
				done(null);
				return;
			}

			if (editing) {
				if (matchesKey(data, Key.enter)) {
					submitCustom();
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			if (/^[1-9]$/.test(data)) {
				const next = Number(data) - 1;
				if (next <= otherIndex) {
					selectedIndex = next;
					refresh();
				}
				return;
			}
			if (matchesKey(data, Key.up)) {
				selectedIndex = Math.max(0, selectedIndex - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				selectedIndex = Math.min(otherIndex, selectedIndex + 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.enter)) {
				submitSelected();
				return;
			}

			if (data.length > 0 && !data.startsWith("\u001b")) {
				selectedIndex = otherIndex;
				editing = true;
				editor.handleInput(data);
				refresh();
			}
		}

		function render(width: number): string[] {
			if (cachedLines) return cachedLines;
			const lines: string[] = [];
			const add = (line: string = "") => lines.push(truncateToWidth(line, width));

			add(theme.fg("accent", "─".repeat(width)));
			if (question.header) add(theme.bold(theme.fg("text", question.header)));
			add(theme.fg("text", question.question));
			if (question.context) add(theme.fg("muted", question.context));
			add();

			if (options.length > 0) {
				for (let i = 0; i <= otherIndex; i++) {
					const selected = i === selectedIndex;
					const label = i === otherIndex ? "Other / custom answer" : options[i]?.label ?? "";
					const prefix = selected ? theme.fg("accent", "> ") : "  ";
					add(prefix + (selected ? theme.fg("accent", `${i + 1}. ${label}`) : theme.fg("text", `${i + 1}. ${label}`)));
					const desc = i === otherIndex ? "" : options[i]?.description;
					if (desc) add(`    ${theme.fg("muted", desc)}`);
				}
				add();
			}

			if (editing) {
				add(theme.fg("muted", "Your answer:"));
				for (const line of editor.render(Math.max(10, width - 2))) add(` ${line}`);
				add();
			}

			if (hint) add(theme.fg("warning", hint));
			add(theme.fg("dim", options.length > 0 && !editing ? "↑↓/1-9 select • Enter submit • type for custom • Esc cancel" : "Enter submit • Shift+Enter newline • Esc cancel"));
			add(theme.fg("accent", "─".repeat(width)));
			cachedLines = lines;
			return lines;
		}

		return { render, handleInput, invalidate: () => (cachedLines = undefined) };
	});
}
