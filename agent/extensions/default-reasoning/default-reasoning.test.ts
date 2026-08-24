import assert from "node:assert/strict";
import test from "node:test";
import defaultReasoningExtension from "../default-reasoning.ts";

function createHarness() {
  let thinkingLevel = "low";
  const handlers = new Map<string, (event: any) => unknown>();
  const pi = {
    on(name: string, handler: (event: any) => unknown) {
      handlers.set(name, handler);
    },
    getThinkingLevel() {
      return thinkingLevel;
    },
    setThinkingLevel(level: string) {
      thinkingLevel = level;
    },
  };
  defaultReasoningExtension(pi as any);
  return {
    selectModel(event: any) {
      handlers.get("model_select")?.(event);
    },
    getThinkingLevel: () => thinkingLevel,
  };
}

test("applies default thinking levels on model select", () => {
  const pi = createHarness();

  pi.selectModel({ source: "user", model: { provider: "deepseek", id: "deepseek-v4-flash", reasoning: true } });
  assert.equal(pi.getThinkingLevel(), "max");

  pi.selectModel({ source: "user", model: { provider: "cliproxy", id: "gpt-5.6-luna", reasoning: true } });
  assert.equal(pi.getThinkingLevel(), "low");
});

test("disables thinking for models without reasoning", () => {
  const pi = createHarness();

  pi.selectModel({ source: "user", model: { provider: "deepseek", id: "deepseek-v4-flash", reasoning: true } });
  pi.selectModel({ source: "user", model: { provider: "other", id: "plain-model", reasoning: false } });
  assert.equal(pi.getThinkingLevel(), "off");
});

test("does not override thinking level on session restore", () => {
  const pi = createHarness();

  pi.selectModel({ source: "user", model: { provider: "deepseek", id: "deepseek-v4-flash", reasoning: true } });
  pi.selectModel({ source: "restore", model: { provider: "deepseek", id: "deepseek-v4-flash", reasoning: true } });
  assert.equal(pi.getThinkingLevel(), "max");
});
