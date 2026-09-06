import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import pulse from "../extensions/agent-pulse.ts";
import editor from "../extensions/00-ui-editor.ts";
import footer from "../extensions/00-ui-footer.ts";
import header from "../extensions/00-ui-header.ts";

type Handler = (event: any, ctx: ExtensionContext) => unknown;

for (const mode of ["print", "json", "rpc"] as const) {
  test(`${mode} children leave parent UI globals and timers untouched`, (t) => {
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
    const parentLine = () => "parent pulse";
    let renders = 0;
    const parentRender = () => { renders++; };
    globalThis.__piAgentPulseEditorLine = parentLine;
    globalThis.__piAgentPulseRequestRender = parentRender;
    t.after(() => {
      delete globalThis.__piAgentPulseEditorLine;
      delete globalThis.__piAgentPulseRequestRender;
    });
    const handlers = new Map<string, Handler[]>();
    const pi = {
      on(name: string, handler: Handler) {
        handlers.set(name, [...handlers.get(name) ?? [], handler]);
      },
      getSessionName: () => "child",
    } as unknown as ExtensionAPI;
    for (const install of [pulse, editor, footer, header]) install(pi);
    // Any UI/session access is a failure. RPC hasUI=true must also be excluded.
    const unavailable = new Proxy({}, { get() { throw new Error("headless UI/history access"); } });
    const ctx = { mode, hasUI: mode === "rpc", ui: unavailable, sessionManager: unavailable } as ExtensionContext;
    for (const name of ["session_start", "agent_start", "session_info_changed", "tool_execution_start", "tool_execution_end", "message_update", "message_end", "model_select", "thinking_level_select", "session_compact", "session_tree", "agent_end", "session_shutdown"]) {
      for (const handler of handlers.get(name) ?? []) handler({}, ctx);
    }
    t.mock.timers.tick(60_000);
    assert.equal(globalThis.__piAgentPulseEditorLine, parentLine);
    assert.equal(globalThis.__piAgentPulseRequestRender, parentRender);
    assert.equal(renders, 0);
  });
}

test("footer context is cached across pulse frames and invalidated by history changes", () => {
  const handlers = new Map<string, Handler>();
  let component: { render(width: number): string[] } | undefined;
  let reads = 0;
  let tokens = 100;
  const ctx = {
    mode: "tui", cwd: "/tmp",
    sessionManager: { getEntries: () => [] },
    getContextUsage: () => { reads++; return { tokens, contextWindow: 1000, percent: tokens / 10 }; },
    ui: { setFooter(factory: NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]>) {
      component = factory(
        { requestRender() {} } as never,
        { fg: (_color: string, text: string) => text } as never,
        { onBranchChange: () => () => {}, getGitBranch: () => null, getExtensionStatuses: () => new Map() } as never,
      );
    } },
  } as unknown as ExtensionContext;
  footer({ on: (name: string, handler: Handler) => handlers.set(name, handler), getThinkingLevel: () => "off" } as unknown as ExtensionAPI);
  handlers.get("session_start")!({}, ctx);
  assert.ok(component);
  for (let i = 0; i < 100; i++) component.render(100);
  assert.equal(reads, 1);
  for (const event of ["message_end", "session_compact", "session_tree", "model_select"]) {
    tokens += 100;
    handlers.get(event)!({ message: { role: "toolResult" } }, ctx);
    const before: number = reads;
    const lines = component.render(100);
    component.render(100);
    assert.equal(reads, before + 1);
    assert.ok(lines.join("\n").includes(`${tokens}/1.0k`));
  }
});

test("static header is cached until theme invalidation", () => {
  const handlers = new Map<string, Handler>();
  let component: { render(width: number): string[]; invalidate(): void } | undefined;
  let paletteReads = 0;
  const ctx = {
    mode: "tui",
    ui: { setHeader(factory: NonNullable<Parameters<ExtensionContext["ui"]["setHeader"]>[0]>) {
      component = factory({ requestRender() {} } as never, {
        fg: (_color: string, text: string) => text,
        getFgAnsi: () => { paletteReads++; return "\\x1b[38;2;10;20;30m"; },
      } as never);
    } },
  } as unknown as ExtensionContext;
  header({ on: (name: string, handler: Handler) => handlers.set(name, handler), getThinkingLevel: () => "off" } as unknown as ExtensionAPI);
  handlers.get("session_start")!({}, ctx);
  assert.ok(component);
  const lines = component.render(100);
  for (let i = 0; i < 100; i++) assert.equal(component.render(100), lines);
  assert.equal(paletteReads, 1);
  component.invalidate();
  assert.notEqual(component.render(100), lines);
  assert.equal(paletteReads, 2);
});

test("TUI pulse still animates and stops on shutdown", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const handlers = new Map<string, Handler>();
  let renders = 0;
  globalThis.__piAgentPulseRequestRender = () => { renders++; };
  t.after(() => {
    delete globalThis.__piAgentPulseEditorLine;
    delete globalThis.__piAgentPulseRequestRender;
  });
  pulse({ on: (name: string, handler: Handler) => handlers.set(name, handler), getSessionName: () => "test" } as unknown as ExtensionAPI);
  const ctx = { mode: "tui", cwd: "/tmp", ui: { setTitle() {}, setWorkingVisible() {} } } as unknown as ExtensionContext;
  handlers.get("session_start")!({}, ctx);
  handlers.get("agent_start")!({}, ctx);
  const before = renders;
  t.mock.timers.tick(240);
  assert.equal(renders, before + 2);
  assert.equal(typeof globalThis.__piAgentPulseEditorLine, "function");
  handlers.get("session_shutdown")!({}, ctx);
  const stopped = renders;
  t.mock.timers.tick(60_000);
  assert.equal(renders, stopped);
  assert.equal(globalThis.__piAgentPulseEditorLine, undefined);
});
