export interface NumberedDiffLine {
	marker: "+" | "-" | " ";
	lineNumber?: number;
	text: string;
}

export function formatPatchSummaryCounts(
	summary: string,
	formatAdded: (text: string) => string,
	formatRemoved: (text: string) => string,
	formatMuted: (text: string) => string,
): string {
	return summary
		.split("\n")
		.map((line) => {
			const counts = line.match(/^(.*?)(\+\d+)(\s+)(-\d+)$/);
			if (!counts) return formatMuted(line);
			return `${formatMuted(counts[1]!)}${formatAdded(counts[2]!)}${formatMuted(counts[3]!)}${formatRemoved(counts[4]!)}`;
		})
		.join(formatMuted("\n"));
}

export function formatNumberedDiffLines(lines: NumberedDiffLine[]): string[] {
	const width = Math.max(1, ...lines.map(({ lineNumber }) => lineNumber === undefined ? 0 : String(lineNumber).length));
	return lines.map(({ marker, lineNumber, text }) => {
		const gutter = lineNumber === undefined ? "".padStart(width) : String(lineNumber).padStart(width);
		return `${marker}${gutter} ${text}`;
	});
}

export function buildUpdatePreview(numbered: NumberedDiffLine[], hasMovePath: boolean): { added: number; removed: number; lines: string[]; pureMove: boolean } {
	const added = numbered.filter((line) => line.marker === "+").length;
	const removed = numbered.filter((line) => line.marker === "-").length;
	const pureMove = hasMovePath && added === 0 && removed === 0;
	return { added, removed, lines: pureMove ? [] : formatNumberedDiffLines(numbered), pureMove };
}

export function numberUpdateDiffLines(original: string[], body: string[]): NumberedDiffLine[] {
	const result: NumberedDiffLine[] = [];
	let searchFrom = 0;
	let lineDelta = 0;

	for (const hunk of splitHunks(body)) {
		const oldPattern = hunk.lines
			.filter((line) => line[0] === " " || line[0] === "-")
			.map((line) => line.slice(1));
		const anchorFrom = findAnchor(original, hunk.header, searchFrom);
		const oldStart = findSequence(original, oldPattern, anchorFrom) ?? findSequence(original, oldPattern, searchFrom) ?? searchFrom;
		if (result.length > 0 && oldStart > searchFrom) {
			result.push({ marker: " ", text: "⋮" });
		}
		let oldLine = oldStart + 1;
		let newLine = oldStart + 1 + lineDelta;
		let added = 0;
		let removed = 0;

		for (const line of hunk.lines) {
			const marker = line[0];
			if (marker !== "+" && marker !== "-" && marker !== " ") continue;
			if (marker === "-") {
				result.push({ marker, lineNumber: oldLine, text: line.slice(1) });
				oldLine += 1;
				removed += 1;
			} else if (marker === "+") {
				result.push({ marker, lineNumber: newLine, text: line.slice(1) });
				newLine += 1;
				added += 1;
			} else {
				result.push({ marker, lineNumber: newLine, text: line.slice(1) });
				oldLine += 1;
				newLine += 1;
			}
		}
		searchFrom = oldLine - 1;
		lineDelta += added - removed;
	}

	return result;
}

function splitHunks(body: string[]): Array<{ header?: string; lines: string[] }> {
	const hunks: Array<{ header?: string; lines: string[] }> = [];
	let current: { header?: string; lines: string[] } = { lines: [] };
	for (const line of body) {
		if (line.startsWith("@@")) {
			if (current.lines.length > 0) hunks.push(current);
			const header = line.slice(2).trim();
			current = { ...(header ? { header } : {}), lines: [] };
		} else if (line !== "*** End of File") {
			current.lines.push(line);
		}
	}
	if (current.lines.length > 0) hunks.push(current);
	return hunks;
}

function findAnchor(lines: string[], header: string | undefined, from: number): number {
	if (!header) return from;
	const exact = lines.indexOf(header, from);
	if (exact !== -1) return exact + 1;
	const trimmed = header.trim();
	const fuzzy = lines.findIndex((line, index) => index >= from && line.trim() === trimmed);
	return fuzzy === -1 ? from : fuzzy + 1;
}

function findSequence(lines: string[], sequence: string[], from: number): number | undefined {
	if (sequence.length === 0) return from;
	for (let index = from; index <= lines.length - sequence.length; index += 1) {
		if (sequence.every((line, offset) => lines[index + offset] === line)) return index;
	}
	for (let index = from; index <= lines.length - sequence.length; index += 1) {
		if (sequence.every((line, offset) => lines[index + offset]!.trim() === line.trim())) return index;
	}
	return undefined;
}
