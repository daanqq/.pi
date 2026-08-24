import assert from "node:assert/strict";
import test from "node:test";
import autoSessionNameExtension, { fallbackSessionName, sanitizeSessionName } from "./index.ts";

type Handler = (event: any, ctx: any) => unknown;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createHarness() {
  const handlers = new Map<string, Handler>();
  const notifications: Array<{ message: string; type: string }> = [];
  const completion = deferred<any>();
  let completionRequest: any;
  let completionCalls = 0;
  let name: string | undefined;
  let sessionId = "session-1";
  let sessionFile: string | undefined = "/tmp/session-1.jsonl";
  let branch: any[] = [];

  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    setSessionName(nextName: string) {
      name = nextName;
    },
  };

  const ctx = {
    mode: "tui",
    ui: {
      notify(message: string, type: string) {
        notifications.push({ message, type });
      },
    },
    sessionManager: {
      getBranch: () => branch,
      getSessionId: () => sessionId,
      getSessionFile: () => sessionFile,
      getSessionName: () => name,
    },
    modelRegistry: {
      find: () => ({ provider: "cliproxy", id: "gpt-5.6-luna" }),
      complete: (...args: any[]) => {
        completionCalls += 1;
        completionRequest = args;
        return completion.promise;
      },
    },
  };

  autoSessionNameExtension(pi as any);

  const emit = (event: string, payload: Record<string, unknown> = {}) => handlers.get(event)?.({ type: event, ...payload }, ctx);

  return {
    ctx,
    notifications,
    completion,
    emit,
    getCompletionCalls: () => completionCalls,
    getCompletionRequest: () => completionRequest,
    getName: () => name,
    setName(nextName: string | undefined) {
      name = nextName;
    },
    emitNameChange(nextName: string | undefined) {
      name = nextName;
      emit("session_info_changed", { name: nextName });
    },
    setSession(nextId: string, nextFile: string) {
      sessionId = nextId;
      sessionFile = nextFile;
    },
    setBranch(nextBranch: any[]) {
      branch = nextBranch;
    },
  };
}

async function startNaming(harness: ReturnType<typeof createHarness>) {
  harness.emit("session_start", { reason: "startup" });
  harness.emit("before_agent_start", { prompt: "Исправь обновление токена авторизации" });
  harness.emit("agent_end", {
    messages: [{ role: "assistant", content: [{ type: "text", text: "Нашёл гонку и исправил обновление токена." }] }],
  });
  harness.emit("agent_settled");
  await Promise.resolve();
}

test("sanitizes and limits generated names", () => {
  assert.equal(sanitizeSessionName('## "Исправление обновления токена."'), "Исправление обновления токена");
  assert.equal(sanitizeSessionName("Title: Короткое название\nЛишняя строка"), "Короткое название");
  assert.equal(sanitizeSessionName("```text\nИмя в блоке кода\n```"), "Имя в блоке кода");
  assert.equal(sanitizeSessionName("Разбор авторизации。"), "Разбор авторизации");
  assert.ok(sanitizeSessionName("Очень длинное название ".repeat(10)).length <= 60);
});

test("builds a deterministic fallback from the first meaningful line", () => {
  assert.equal(
    fallbackSessionName('<skill name="test">\nСлужебные инструкции навыка\n</skill>\nИсправь авторизацию в API'),
    "Исправь авторизацию в API",
  );
  assert.equal(fallbackSessionName("\n```\n"), "Новая сессия");
});

test("names a new session once after the first settled response", async () => {
  const harness = createHarness();
  await startNaming(harness);

  harness.completion.resolve({ content: [{ type: "text", text: "Исправление обновления токена" }] });
  await harness.emit("session_shutdown", { reason: "quit" });

  assert.equal(harness.getName(), "Исправление обновления токена");
  assert.equal(harness.getCompletionCalls(), 1);
  const [model, context, options] = harness.getCompletionRequest();
  assert.deepEqual(model, { provider: "cliproxy", id: "gpt-5.6-luna" });
  assert.match(context.messages[0].content[0].text, /Исправь обновление токена авторизации/);
  assert.match(context.messages[0].content[0].text, /Нашёл гонку и исправил обновление токена/);
  assert.equal(options.reasoningEffort, "low");
  assert.equal(options.maxTokens, 80);
  assert.equal(options.cacheRetention, "none");
  assert.equal(options.timeoutMs, 15_000);
  assert.equal(options.maxRetries, 0);
  assert.ok(options.signal instanceof AbortSignal);
  assert.deepEqual(harness.notifications, [{ message: "Session name: Исправление обновления токена", type: "info" }]);

  harness.emit("agent_settled");
  assert.equal(harness.getCompletionCalls(), 1);
});

test("uses fallback when generation fails", async () => {
  const harness = createHarness();
  await startNaming(harness);

  harness.completion.reject(new Error("provider unavailable"));
  await harness.emit("session_shutdown", { reason: "quit" });

  assert.equal(harness.getName(), "Исправь обновление токена авторизации");
  assert.deepEqual(harness.notifications, [
    { message: "Session naming failed; using fallback.", type: "warning" },
    { message: "Session name: Исправь обновление токена авторизации", type: "info" },
  ]);
});

test("preserves a manual name set while generation is pending", async () => {
  const harness = createHarness();
  await startNaming(harness);

  harness.setName("Ручное имя");
  harness.completion.resolve({ content: [{ type: "text", text: "Автоматическое имя" }] });
  await harness.emit("session_shutdown", { reason: "quit" });

  assert.equal(harness.getName(), "Ручное имя");
  assert.deepEqual(harness.notifications, []);
});

test("does not show a fallback warning after a manual rename", async () => {
  const harness = createHarness();
  await startNaming(harness);

  harness.setName("Ручное имя");
  harness.completion.reject(new Error("provider unavailable"));
  await harness.emit("session_shutdown", { reason: "quit" });

  assert.equal(harness.getName(), "Ручное имя");
  assert.deepEqual(harness.notifications, []);
});

test("does not restore an automatic name after the user clears a manual name", async () => {
  const harness = createHarness();
  await startNaming(harness);

  harness.emitNameChange("Ручное имя");
  harness.emitNameChange(undefined);
  harness.completion.resolve({ content: [{ type: "text", text: "Автоматическое имя" }] });
  await harness.emit("session_shutdown", { reason: "quit" });

  assert.equal(harness.getName(), undefined);
  assert.deepEqual(harness.notifications, []);
});

test("does not write a generated name after the session changes", async () => {
  const harness = createHarness();
  await startNaming(harness);

  harness.setSession("session-2", "/tmp/session-2.jsonl");
  harness.completion.resolve({ content: [{ type: "text", text: "Устаревшее имя" }] });
  await harness.emit("session_shutdown", { reason: "resume" });

  assert.equal(harness.getName(), undefined);
  assert.deepEqual(harness.notifications, []);
});

test("ignores resumed sessions and sessions with message history", () => {
  const resumed = createHarness();
  resumed.emit("session_start", { reason: "resume" });
  resumed.emit("before_agent_start", { prompt: "Новый запрос" });
  resumed.emit("agent_end", { messages: [{ role: "assistant", content: "Ответ" }] });
  resumed.emit("agent_settled");
  assert.equal(resumed.getCompletionCalls(), 0);

  const existing = createHarness();
  existing.setBranch([{ type: "message", message: { role: "user", content: "Старый запрос" } }]);
  existing.emit("session_start", { reason: "startup" });
  existing.emit("before_agent_start", { prompt: "Новый запрос" });
  existing.emit("agent_end", { messages: [{ role: "assistant", content: "Ответ" }] });
  existing.emit("agent_settled");
  assert.equal(existing.getCompletionCalls(), 0);

  const emptyPersisted = createHarness();
  emptyPersisted.setSession("session-existing", "/etc/hosts");
  emptyPersisted.emit("session_start", { reason: "startup" });
  emptyPersisted.emit("before_agent_start", { prompt: "Новый запрос" });
  emptyPersisted.emit("agent_end", { messages: [{ role: "assistant", content: "Ответ" }] });
  emptyPersisted.emit("agent_settled");
  assert.equal(emptyPersisted.getCompletionCalls(), 0);
});
