import assert from "node:assert/strict";
import test from "node:test";
import defaultReasoningExtension from "../default-reasoning.ts";

test("reasoning changes use footer status instead of chat notifications", async () => {
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  let thinkingLevel = "low";
  const pi = {
    on(name: string, handler: (event: any, ctx: any) => unknown) {
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

  const notifications: string[] = [];
  const statuses: Array<[string, string | undefined]> = [];
  const ctx = {
    model: { provider: "cliproxy", id: "gpt-5.6-luna", reasoning: true },
    sessionManager: {
      getEntries: () => [
        { type: "message", timestamp: Date.now(), message: { role: "assistant" } },
      ],
    },
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
      setStatus(id: string, text: string | undefined) {
        statuses.push([id, text]);
      },
      setWidget() {},
    },
  };

  await handlers.get("session_start")?.({}, ctx);
  thinkingLevel = "medium";
  await handlers.get("thinking_level_select")?.(
    { previousLevel: "low", level: "medium" },
    ctx,
  );
  await new Promise<void>((resolve) => queueMicrotask(resolve));

  assert.deepEqual(notifications, []);
  assert.deepEqual(statuses.at(-1), [
    "gpt-cache-warning",
    "Thinking level: medium • Context cache will be invalidated",
  ]);

  await handlers.get("before_agent_start")?.({}, ctx);
  assert.deepEqual(statuses.at(-1), ["gpt-cache-warning", undefined]);
});
