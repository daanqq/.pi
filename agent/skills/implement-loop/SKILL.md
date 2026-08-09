---
name: implement-loop
description: Implements a task with repeated independent reviews until no findings remain.
disable-model-invocation: true
---

# Implement Loop

## Hard subagent budget

An invocation may create at most six subagent sessions in total, including
failed, cancelled, retried, or replacement sessions. Reserve that entire budget
for three review rounds of exactly two parallel reviewers: Standards and Spec.
Do not spawn scouts, workers, completion reviewers, final reviewers, or any
other auxiliary subagents. Never exceed the cap to obtain a clean review; stop
and report remaining findings instead.

Every reviewer must use `harness: "pi"`,
`model: "cliproxy/gpt-5.6-luna"`, and `reasoning_effort: "xhigh"`.

1. Pin the current `HEAD` as the review fixed point and treat the described task as the spec.
2. Implement the task, then run the relevant deterministic checks.
3. Invoke `code-review` against the fixed point and spec. Spawn its fresh, parallel Standards and Spec reviewers with `subagent_spawn` using `harness: "pi"`, `model: "cliproxy/gpt-5.6-luna"`, and `reasoning_effort: "xhigh"`; wait for both.
4. Deduplicate and verify their findings. If none remain and all checks pass, finish. Otherwise, fix every valid finding, rerun the checks, and return to step 3.

Stop after three review rounds, after six total subagent spawns, or when the same
unresolved findings survive two rounds, whichever happens first. Findings from
the third round must be reported as blockers rather than triggering repairs and
a seventh review session. Never finish successfully unless a review round after
the last repair returns no findings and all checks pass.
