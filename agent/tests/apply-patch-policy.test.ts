import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import applyPatch from "../extensions/apply-patch/index.ts";

type Model = { provider: string; id: string };

function harness(initial: string[] = ["read", "edit", "write", "bash", "apply_patch"]) {
  let active = [...initial];
  const handlers = new Map<string, (event: { model: Model }, ctx: { model: Model }) => void>();
  applyPatch({
    on(name: string, handler: (event: { model: Model }, ctx: { model: Model }) => void) { handlers.set(name, handler); },
    registerTool() {},
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => { active = names; },
  } as unknown as ExtensionAPI);
  return {
    active: () => active,
    emit(name: string, model: Model) { handlers.get(name)!({ model }, { model }); },
  };
}

for (const id of ["astra", "luna", "sol", "gpt-5.4"]) {
  test(`${id} enables patch and hides edit/write on startup and model switch`, () => {
    for (const event of ["session_start", "model_select"]) {
      const h = harness();
      h.emit(event, { provider: "cliproxy", id });
      assert.deepEqual(h.active(), ["read", "bash", "apply_patch"]);
      h.emit("model_select", { provider: "cliproxy", id: "luna" });
      assert.deepEqual(h.active(), ["read", "bash", "apply_patch"]);
      h.emit("model_select", { provider: "anthropic", id: "claude-sonnet" });
      assert.equal(h.active().includes("edit"), true);
      assert.equal(h.active().includes("write"), true);
      assert.equal(h.active().includes("apply_patch"), false);
    }
  });
}

test("aliases are exact and scoped to CLIProxy", () => {
  for (const model of [{ provider: "other", id: "sol" }, { provider: "cliproxy", id: "solar" }]) {
    const h = harness();
    h.emit("session_start", model);
    assert.deepEqual(h.active(), ["read", "edit", "write", "bash"]);
  }
});

test("switching away does not enable edit/write that were already disabled", () => {
  const h = harness(["read", "bash"]);
  h.emit("session_start", { provider: "cliproxy", id: "astra" });
  assert.deepEqual(h.active(), ["read", "bash", "apply_patch"]);
  h.emit("model_select", { provider: "anthropic", id: "claude-sonnet" });
  assert.deepEqual(h.active(), ["read", "bash"]);
});
