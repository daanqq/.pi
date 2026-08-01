import assert from "node:assert/strict";
import test from "node:test";
import { buildReplacementPreview, buildUpdatePreview, formatNumberedDiffLines, formatPatchSummaryCounts, numberUpdateDiffLines } from "./diff-lines.ts";

test("colors only trailing patch counts in a summary", () => {
	const rendered = formatPatchSummaryCounts(
		"../tidy-client-EUIP-159592/file.ts +5 -22",
		(text) => `<added>${text}</added>`,
		(text) => `<removed>${text}</removed>`,
		(text) => `<muted>${text}</muted>`,
	);
	assert.equal(rendered, "<muted>../tidy-client-EUIP-159592/file.ts </muted><added>+5</added><muted> </muted><removed>-22</removed>");
});

test("hides context-only preview lines for a pure move", () => {
	assert.deepEqual(buildUpdatePreview([
		{ marker: " ", lineNumber: 2, text: "name: example" },
	], true), { added: 0, removed: 0, lines: [], pureMove: true });
});

test("renders a delete-add replacement as one full-file diff", () => {
	assert.deepEqual(buildReplacementPreview(["old one", "old two"], ["new"]), {
		added: 1,
		removed: 2,
		lines: ["-1 old one", "-2 old two", "+1 new"],
	});
});

test("keeps the diff body aligned across line-number digit boundaries", () => {
	const rendered = formatNumberedDiffLines([
		{ marker: "+", lineNumber: 9, text: "nine" },
		{ marker: "+", lineNumber: 10, text: "ten" },
		{ marker: "+", lineNumber: 999, text: "nine-nine-nine" },
		{ marker: "+", lineNumber: 1000, text: "one-thousand" },
	]);
	const bodyColumns = rendered.map((line, index) => line.indexOf(["nine", "ten", "nine-nine-nine", "one-thousand"][index]!));
	assert.deepEqual(bodyColumns, [6, 6, 6, 6]);
});

test("tracks old and new line numbers through update hunks", () => {
	const original = Array.from({ length: 105 }, (_, index) => `line ${index + 1}`);
	const numbered = numberUpdateDiffLines(original, [
		"@@",
		" line 99",
		"-line 100",
		"+replacement 100",
		"+inserted 101",
		" line 101",
	]);
	assert.deepEqual(numbered.map(({ marker, lineNumber }) => [marker, lineNumber]), [
		[" ", 99],
		["-", 100],
		["+", 100],
		["+", 101],
		[" ", 102],
	]);
	const rendered = formatNumberedDiffLines(numbered);
	assert.ok(rendered.every((line) => line.slice(4).length > 0));
});

test("uses named hunk anchors and keeps later hunks monotonic", () => {
	const original = ["start", "function first() {", "a", "}", "function second() {", "b", "}"];
	const numbered = numberUpdateDiffLines(original, [
		"@@ function second() {",
		"-b",
		"+changed",
	]);
	assert.deepEqual(numbered.map(({ marker, lineNumber }) => [marker, lineNumber]), [["-", 6], ["+", 6]]);
});

test("carries line-number shifts into subsequent hunks", () => {
	const original = ["a", "b", "c", "d"];
	const numbered = numberUpdateDiffLines(original, [
		"@@",
		" a",
		"+inserted",
		"@@",
		" d",
	]);
	assert.deepEqual(numbered.map(({ marker, lineNumber }) => [marker, lineNumber]), [
		[" ", 1],
		["+", 2],
		[" ", undefined],
		[" ", 5],
	]);
	assert.equal(numbered[2]?.text, "⋮");
});

test("separates distant update hunks without separating adjacent ones", () => {
	const original = ["one", "two", "three", "four", "five", "six"];
	const numbered = numberUpdateDiffLines(original, [
		"@@",
		" one",
		"-two",
		"+second",
		"@@",
		" three",
		"@@",
		" six",
	]);
	const rendered = formatNumberedDiffLines(numbered);
	assert.equal(rendered.filter((line) => line.includes("⋮")).length, 1);
	assert.ok(rendered.some((line) => line.trim() === "⋮"));
});
