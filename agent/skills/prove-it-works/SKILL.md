---
name: prove-it-works
description: Verifies completed work against the real artifact and behavior rather than a build, cached representation, tool summary, or agent self-report. Use before declaring an implementation, fix, migration, generated artifact, configuration change, or delegated task complete.
license: LICENSE
metadata:
  source: https://github.com/cursor/plugins/tree/60c641e4fad674784b30abcf9f8915dea39df38d/pstack/skills/principle-prove-it-works
  adapted-for: pi
---

# Prove it works

Before declaring completion, identify the claim the user cares about and observe that claim as directly as the available environment allows.

## Evidence levels

1. **Static.** Diff, syntax, types, lint, schema, or source inspection.
2. **Artifact.** Clean build, generated output, packaged file, loaded module, effective configuration, or actual persisted value.
3. **Focused behavior.** A deterministic test or script exercises the owning interface and detects the requested behavior.
4. **Real path.** The matching UI, CLI, route, worker, service, or device path is exercised.
5. **Integration.** The full communication and side-effect chain is observed end to end.

Use the cheapest level that proves the actual claim. A higher level is not automatically better when a focused deterministic check reaches the complete behavior.

## Workflow

1. State the user-visible or maintainer-visible completion predicate.
2. List what the planned checks prove and what they do not prove.
3. Run the narrowest direct check. Prefer repository commands and existing harnesses before creating new code.
4. Inspect the real artifact: diff, file contents, generated output, runtime state, response, screenshot, trace, or side effect.
5. For delegated work, inspect the child artifact and rerun the relevant check. A summary is not evidence.
6. If the observation is surprising or passes too easily, verify the observation method before trusting the result.
7. Report the achieved evidence level, exact check, result, and remaining gap.

Use `VERIFIED` only when the evidence reaches the stated predicate. Use `NOT VERIFIED` when it fails and `INCONCLUSIVE` when the necessary runtime, permission, external system, or safe environment is unavailable.

## Guardrails

- A successful build proves compilation, not product behavior.
- A mocked frontend path does not prove the real backend path.
- A cached screenshot, file timestamp, or generated summary does not prove current state.
- Do not access production or a shared develop database. Ask before any permitted non-production database query.
- Do not perform external writes or destructive cleanup merely to obtain a stronger proof without the required confirmation.
- Keep a reusable proof script only when it will catch the same risk again. Otherwise place disposable scaffolding under `/tmp`, report its path, and ask before deleting it when deletion requires confirmation under the active AGENTS.md rules.

## Report

- Predicate.
- Evidence level reached.
- Command or interaction performed.
- Direct observation.
- Verdict: `VERIFIED`, `NOT VERIFIED`, or `INCONCLUSIVE`.
- Unchecked path and why it remains unchecked.
