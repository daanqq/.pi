import assert from "node:assert/strict";
import test from "node:test";
import {
  analysisExitCode,
  buildAnalyzePrompt,
  extractCompletedSection,
  herdrAgentName,
  herdrWorkspaceLabel,
  hasReadyMr,
  launchHerdrAnalysis,
  parseArguments,
  parseHerdrOutput,
  prepareHerdrWorkspace
} from "../bin/runanalyses";

test("extractCompletedSection stops at the next peer heading", () => {
  const markdown = `## Что надо сделать?
Работа

## Что было сделано?
Текст
### Детали
Подробности

## Как я тестировал?
Проверка`;

  assert.equal(
    extractCompletedSection(markdown),
    "Текст\n### Детали\nПодробности"
  );
});

test("hasReadyMr only checks the completed section", () => {
  const mr = "https://git.esoft.tech/tidy/miniapp/-/merge_requests/58";

  assert.equal(
    hasReadyMr({ textMd: `## Проблематика\n${mr}\n\n## Что было сделано?\nПока ничего` }),
    false
  );
  assert.equal(
    hasReadyMr({ textMd: `## Что было сделано?\n${mr}\n\n## Как я тестировал?\nЛокально` }),
    true
  );
  assert.equal(
    hasReadyMr({ description: `## Что было сделано?\n${mr.replace("merge_requests", "merge\\_requests")}` }),
    true
  );
});

test("parseArguments canonicalizes URS links and deduplicates tasks", () => {
  assert.deepEqual(
    parseArguments([
      "''",
      "https://youtrack.esoft.tech/issue/eutp-42",
      "https://urs.esoft.tech/issue/EUTP-42",
      "https://urs.esoft.tech/issue/EUTP-43"
    ], { PORA_SESSION: "secret" }),
    {
      help: false,
      concurrency: 4,
      dryRun: false,
      mode: "headless",
      token: "secret",
      tasks: [
        { id: "EUTP-42", url: "https://urs.esoft.tech/issue/EUTP-42" },
        { id: "EUTP-43", url: "https://urs.esoft.tech/issue/EUTP-43" }
      ]
    }
  );
});

test("parseArguments selects Herdr mode explicitly", () => {
  const parsed = parseArguments([
    "--herdr",
    "secret",
    "https://urs.esoft.tech/issue/EUTP-42"
  ], {});

  assert.equal(parsed.mode, "herdr");
  assert.throws(
    () => parseArguments([
      "--herdr",
      "--headless",
      "secret",
      "https://urs.esoft.tech/issue/EUTP-42"
    ], {}),
    /только один режим/
  );
});

test("buildAnalyzePrompt activates analyze-eutp without embedding the session", () => {
  const prompt = buildAnalyzePrompt({
    id: "EUTP-42",
    url: "https://urs.esoft.tech/issue/EUTP-42"
  });

  assert.match(prompt, /^\$analyze-eutp/);
  assert.match(prompt, /https:\/\/urs\.esoft\.tech\/issue\/EUTP-42/);
  assert.doesNotMatch(prompt, /secret/);
});

test("analysisExitCode rejects empty output and extension errors", () => {
  assert.equal(analysisExitCode(0, "analysis complete"), 0);
  assert.equal(analysisExitCode(0, ""), 1);
  assert.equal(analysisExitCode(0, "Extension error: failed"), 1);
  assert.equal(analysisExitCode(2, "analysis complete"), 2);
});

test("Herdr names are valid and workspace labels include the batch time", () => {
  const agentName = herdrAgentName("EUTP-173661", "Batch-ABC12345");

  assert.match(agentName, /^[a-z][a-z0-9_-]{0,31}$/);
  assert.equal(agentName, "eutp-173661-abc12345");
  assert.equal(
    herdrWorkspaceLabel(new Date("2026-09-03T09:45:00.000Z")),
    "EUTP analyses 2026-09-03 09:45"
  );
});

test("parseHerdrOutput rejects API errors and malformed output", () => {
  assert.deepEqual(
    parseHerdrOutput('{"result":{"type":"ok"}}', "test"),
    { result: { type: "ok" } }
  );
  assert.throws(
    () => parseHerdrOutput('{"error":{"message":"busy"}}', "agent start"),
    /agent start: busy/
  );
  assert.throws(() => parseHerdrOutput("not-json", "tab create"), /некорректный JSON/);
});

test("prepareHerdrWorkspace creates one Space and one tab per task", async () => {
  const calls = [];
  const tasks = [
    { id: "EUTP-42", url: "https://urs.esoft.tech/issue/EUTP-42" },
    { id: "EUTP-43", url: "https://urs.esoft.tech/issue/EUTP-43" }
  ];
  const runHerdr = async (args) => {
    calls.push(args);
    if (args[0] === "workspace") {
      return {
        result: {
          workspace: { workspace_id: "wA" },
          tab: { tab_id: "wA:t1" },
          root_pane: { pane_id: "wA:p1" }
        }
      };
    }
    if (args[1] === "rename") return { result: { type: "tab_info" } };
    return {
      result: {
        tab: { tab_id: "wA:t2" },
        root_pane: { pane_id: "wA:p2" }
      }
    };
  };

  const prepared = await prepareHerdrWorkspace(tasks, {
    cwd: "/home/user/echat",
    token: "secret",
    workspaceLabel: "EUTP analyses test",
    runHerdr
  });

  assert.equal(prepared.workspaceId, "wA");
  assert.deepEqual(prepared.locations.map((location) => location.tabId), ["wA:t1", "wA:t2"]);
  assert.deepEqual(calls[1], ["tab", "rename", "wA:t1", "EUTP-42"]);
  assert.deepEqual(calls[2], [
    "tab",
    "create",
    "--workspace",
    "wA",
    "--cwd",
    "/home/user/echat",
    "--label",
    "EUTP-43",
    "--env",
    "PORA_SESSION=secret",
    "--no-focus"
  ]);
});

test("launchHerdrAnalysis starts interactive Pi and waits for completion", async () => {
  const calls = [];
  const runHerdr = async (args) => {
    calls.push(args);
    return args[1] === "prompt"
      ? { result: { agent: { agent_status: "done" } } }
      : { result: { agent: { agent_status: "idle" } } };
  };
  const task = { id: "EUTP-42", url: "https://urs.esoft.tech/issue/EUTP-42" };

  const result = await launchHerdrAnalysis({
    task,
    workspaceId: "wA",
    tabId: "wA:t1",
    paneId: "wA:p1"
  }, { batchId: "abc123", runHerdr });

  assert.equal(result.status, "analyzed");
  assert.deepEqual(calls[0].slice(0, 8), [
    "agent",
    "start",
    "eutp-42-abc123",
    "--kind",
    "pi",
    "--pane",
    "wA:p1",
    "--timeout"
  ]);
  assert.equal(calls[0].includes("-p"), false);
  assert.deepEqual(calls[0].slice(-3), ["--", "--name", "URS analysis EUTP-42"]);
  assert.deepEqual(calls[1].slice(-7), [
    "--wait",
    "--until",
    "idle",
    "--until",
    "done",
    "--until",
    "blocked"
  ]);
});
