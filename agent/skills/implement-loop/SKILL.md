---
name: implement-loop
description: Implements a task with repeated independent reviews until no findings remain.
disable-model-invocation: true
---

# Implement Loop

1. Pin the current `HEAD` as the review fixed point and treat the described task as the spec.
2. Implement the task, then run the relevant deterministic checks.
3. Invoke `code-review` against the fixed point and spec. Spawn its fresh, parallel Standards and Spec reviewers with `subagent_spawn` using `harness: "pi"`, `model: "openai-codex/gpt-5.6-luna"`, and `reasoning_effort: "high"`; wait for both.
4. Deduplicate and verify their findings. If none remain and all checks pass, finish. Otherwise, fix every valid finding, rerun the checks, and return to step 3.

Stop after three review rounds or when the same unresolved findings survive two rounds. Report the blockers without claiming success. Never finish successfully unless a review round after the last repair returns no findings and all checks pass.
