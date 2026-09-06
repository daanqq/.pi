import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import applyPatch, { previewPatch } from "../extensions/apply-patch/index.ts";
import { MAX_PREVIEW_BYTES, PreviewBudget, PreviewLimitError } from "../extensions/apply-patch/preview-budget.ts";
import { formatNumberedDiffLines, numberUpdateDiffLines } from "../extensions/apply-patch/diff-lines.ts";

function workspace(t: { after(fn: () => void): void }) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-patch-preview-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

const patch = (body: string) => `*** Begin Patch\n*** Update File: file.txt\n@@\n${body}\n*** End Patch`;

test("small previews retain counts and line numbers", (t) => {
  const cwd = workspace(t);
  writeFileSync(join(cwd, "file.txt"), "one\ntwo\n");
  assert.deepEqual(previewPatch(patch(" one\n-two\n+second"), cwd), {
    summary: "file.txt +1 -1",
    diff: " 1 one\n-2 two\n+2 second",
  });
});

test("large files and oversized patches produce an explicitly omitted preview", (t) => {
  const cwd = workspace(t);
  writeFileSync(join(cwd, "file.txt"), "x".repeat(MAX_PREVIEW_BYTES + 1));
  for (const text of [patch("-x\n+y"), patch(`+${"y".repeat(MAX_PREVIEW_BYTES)}`)]) {
    const preview = previewPatch(text, cwd);
    assert.ok("diff" in preview);
    assert.match(preview.diff, /Preview omitted:/);
    assert.match(preview.diff, /execution is unchanged/);
  }
});

test("repetitive unmatched hunks have a deterministic search bound", (t) => {
  const cwd = workspace(t);
  const original = Array.from({ length: 2_000 }, () => "x");
  const body = [...Array.from({ length: 200 }, () => " x"), "-missing", "+replacement"];
  assert.throws(() => numberUpdateDiffLines(original, body), PreviewLimitError);
  writeFileSync(join(cwd, "file.txt"), original.join("\n"));
  const preview = previewPatch(patch(body.join("\n")), cwd);
  assert.ok("diff" in preview);
  assert.match(preview.diff, /hunk search budget exceeded/);
});

test("all files share one preview byte budget", (t) => {
  const cwd = workspace(t);
  const budget = new PreviewBudget();
  writeFileSync(join(cwd, "file.txt"), "x".repeat(MAX_PREVIEW_BYTES / 2));
  budget.consumeText("patch text");
  budget.readFile(join(cwd, "file.txt"));
  assert.throws(() => budget.readFile(join(cwd, "file.txt")), PreviewLimitError);
});

test("very many short lines are bounded before building a preview", (t) => {
  const cwd = workspace(t);
  writeFileSync(join(cwd, "file.txt"), "x\n".repeat(10_000));
  const preview = previewPatch(patch("-x\n+y"), cwd);
  assert.ok("diff" in preview);
  assert.match(preview.diff, /line budget exceeded/);
});

test("all files share one preview line budget", () => {
  const budget = new PreviewBudget();
  budget.consumeText("x\n".repeat(2_000));
  assert.throws(() => budget.consumeText("x\n".repeat(2_000)), PreviewLimitError);
});

test("formatting 150000 lines does not overflow the argument stack", () => {
  const lines = Array.from({ length: 150_000 }, (_, index) => ({ marker: "+" as const, lineNumber: index + 1, text: "x" }));
  const formatted = formatNumberedDiffLines(lines);
  assert.equal(formatted.length, lines.length);
  assert.equal(formatted.at(-1), "+150000 x");
});

test("omitting a large preview does not prevent actual patch execution", async (t) => {
  const cwd = workspace(t);
  const text = "x".repeat(MAX_PREVIEW_BYTES + 1);
  const input = `*** Begin Patch\n*** Add File: large.txt\n+${text}\n*** End Patch`;
  const preview = previewPatch(input, cwd);
  assert.ok("diff" in preview);
  assert.match(preview.diff, /Preview omitted/);
  let tool: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;
  applyPatch({ on() {}, registerTool(next: Parameters<ExtensionAPI["registerTool"]>[0]) { tool = next; } } as unknown as ExtensionAPI);
  assert.ok(tool);
  await tool.execute("large-patch-test", { input }, undefined, undefined, { cwd } as never);
  assert.equal(readFileSync(join(cwd, "large.txt"), "utf8"), `${text}\n`);
});

test("failed and partially applied patches keep independent row-local status", async (t) => {
  initTheme("dark", false);
  const cwd = workspace(t);
  writeFileSync(join(cwd, "file.txt"), "original\n");
  let tool: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;
  applyPatch({ on() {}, registerTool(next: Parameters<ExtensionAPI["registerTool"]>[0]) { tool = next; } } as unknown as ExtensionAPI);
  assert.ok(tool?.renderCall && tool.renderResult);
  const theme = { fg: (_role: string, text: string) => text, bg: (_role: string, text: string) => text, bold: (text: string) => text };
  const input = patch("-missing\n+replacement");
  const context = { args: { input }, state: {}, cwd, argsComplete: true, isPartial: true, isError: false, expanded: false };
  const row = tool.renderCall({ input }, theme as never, context as never);
  assert.ok(row);
  await assert.rejects(tool.execute("failed", { input }, undefined, undefined, { cwd } as never), /apply_patch failed/);
  context.isPartial = false;
  context.isError = true;
  const failed = tool.renderCall({ input }, theme as never, { ...context, lastComponent: row } as never);
  assert.ok(failed && "settledStatus" in failed);
  assert.equal(failed.settledStatus, "failed");
  tool.renderResult({ content: [{ type: "text", text: "apply_patch failed while patching file.txt" }], details: undefined }, { isPartial: false, expanded: false }, theme as never, context as never);
  assert.ok("failedTargets" in failed);
  assert.deepEqual(failed.failedTargets, ["file.txt"]);

  const partialInput = `*** Begin Patch\n*** Add File: created.txt\n+created\n*** Update File: file.txt\n@@\n-missing\n+replacement\n*** End Patch`;
  const partialContext = { ...context, args: { input: partialInput }, state: {}, isPartial: true, isError: false };
  const partialRow = tool.renderCall(partialContext.args, theme as never, partialContext as never);
  const result = await tool.execute("partial", partialContext.args, undefined, undefined, { cwd } as never);
  tool.renderResult(result, { isPartial: false, expanded: false }, theme as never, partialContext as never);
  assert.ok(partialRow && "settledStatus" in partialRow && "failedTargets" in partialRow);
  assert.equal(partialRow.settledStatus, "partial_failure");
  assert.deepEqual(partialRow.failedTargets, ["file.txt"]);
  assert.equal(failed.settledStatus, "failed");
  assert.equal(readFileSync(join(cwd, "created.txt"), "utf8"), "created\n");
  assert.equal(readFileSync(join(cwd, "file.txt"), "utf8"), "original\n");
});
