---
name: luna
description: Delegate an implementation task to a Luna-powered pi subagent.
disable-model-invocation: true
---

# GPT-5.6 Luna

Delegate the current implementation task to exactly one subagent.

1. Build a self-contained prompt from the user's request and relevant conversation context. Include the working directory, desired outcome, constraints, and acceptance criteria. Tell the subagent to inspect applicable `AGENTS.md` files, implement the change, run relevant non-destructive validation, and report changed files, checks, and blockers. Do not prescribe a solution the user did not request. The prompt is complete when the subagent can proceed without seeing this conversation or asking questions.
2. Spawn it with `harness: "pi"`, `model: "openai-codex/gpt-5.6-luna"`, `reasoning_effort: "xhigh"`, and the current trusted project as `working_dir`. Do not duplicate its implementation in the parent session.
3. Wait when its result is required to finish the request, then inspect its changes and report the outcome accurately. The task is complete only when the requested implementation and relevant validation are accounted for, or a concrete blocker is reported.
