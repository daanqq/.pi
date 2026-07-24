import assert from "node:assert/strict";
import test from "node:test";
import { extractMrUrls, extractTaskId, parseArguments, reviewExitCode } from "../bin/runreviews";

test("extractTaskId accepts URS and YouTrack-style values", () => {
  assert.equal(extractTaskId("https://urs.esoft.tech/issue/eutp-12345"), "EUTP-12345");
  assert.equal(extractTaskId("missing"), null);
});

test("extractMrUrls recursively scans task data and deduplicates links", () => {
  const first = "https://git.esoft.tech/tidy/tidy-client/-/merge_requests/2301";
  const second = "https://git.esoft.tech/tidy/tidy-rest/-/merge_requests/1693";
  assert.deepEqual(extractMrUrls({ textMd: `[client](${first})`, nested: [{ value: `${first} ${second}` }] }), [first, second]);
});

test("parseArguments supports env token and concurrency", () => {
  assert.deepEqual(
    parseArguments(["--concurrency=2", "''", "https://urs.esoft.tech/issue/EUTP-42"], { PORA_SESSION: "secret" }),
    {
      help: false,
      concurrency: 2,
      dryRun: false,
      token: "secret",
      tasks: [{ id: "EUTP-42", url: "https://urs.esoft.tech/issue/EUTP-42" }],
    },
  );
});

test("parseArguments rejects malformed task links", () => {
  assert.throws(() => parseArguments(["secret", "https://urs.esoft.tech/issue/no-id"], {}), /извлечь EUTP-ID/);
});

test("parseArguments deduplicates repeated task IDs", () => {
  const parsed = parseArguments([
    "secret",
    "https://urs.esoft.tech/issue/EUTP-42",
    "https://youtrack.esoft.tech/issue/EUTP-42",
  ], {});
  assert.deepEqual(parsed.tasks, [{ id: "EUTP-42", url: "https://urs.esoft.tech/issue/EUTP-42" }]);
});

test("reviewExitCode rejects empty output and extension command errors", () => {
  assert.equal(reviewExitCode(0, "review complete"), 0);
  assert.equal(reviewExitCode(0, ""), 1);
  assert.equal(reviewExitCode(0, "Extension error (command:mr-review): failed"), 1);
  assert.equal(reviewExitCode(2, "review complete"), 2);
});
