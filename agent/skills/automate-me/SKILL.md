---
name: automate-me
description: Creates or refreshes a personal Pi mode skill from recurring working preferences found in Pond and the user's explicit choices. Use when asked to automate a working style, capture agent preferences, or create or update a personal mode skill. Requires repeated evidence and avoids overfitting one session.
license: LICENSE
metadata:
  source: https://github.com/cursor/plugins/tree/60c641e4fad674784b30abcf9f8915dea39df38d/pstack/skills/automate-me
  adapted-for: pi
---

# Automate me

Turn stable working conventions into one concise `-mode` skill. The output is an operational skill, not a biography or a copy of existing AGENTS.md rules.

Use [`../writing-for-agents/SKILL.md`](../writing-for-agents/SKILL.md) and its skill mechanics when drafting. Apply `unslop` to the final prose.

## Workflow

1. **Choose the target.** Search global and project Pi skill locations for an existing matching `*-mode/SKILL.md`. Update it when the user asked to refresh or continue an existing mode. For a new mode, ask for the handle and whether it should be global or project-local when that choice is not already explicit.
2. **Scope the evidence.** Lock the workspace, topic, and time window. For an update, start after the existing skill's last edit when git history is available.
3. **Mine Pond.** Search main sessions for recurring corrections and preferences. Use semantic search for candidate patterns, read relevant session tails, and use scoped SQL only when tool behavior matters. Exclude subagent sessions when inferring the user's style. Elevate a rule only when it appears in at least two independent sessions or the user states it directly.
4. **Fill the gaps.** Ask one concise round of questions only for choices history cannot reveal, such as global versus project scope, preferred autonomy on ambiguous product decisions, or whether a disputed pattern should become a rule.
5. **Cluster.** Keep only sections with non-default behavior. Common groups are response style, autonomy, understand-first, subagents, code discipline, verification, Git/MR process, and skill maintenance.
6. **Draft.** Write the smallest mode skill that changes agent behavior. Reference existing skills instead of copying their bodies. Use `disable-model-invocation: true` unless the user explicitly wants the mode loaded automatically.
7. **Validate.** Check frontmatter, links, paths, trigger description, duplication with AGENTS.md, and consistency with current confirmation rules. Read the complete draft once as a cold-start agent.
8. **Land locally.** Create or update the requested skill and report its path. Do not commit, push, open an MR, or alter external systems unless the user separately requested that action.

## Placement

- Global personal mode: `~/.pi/agent/skills/<handle>-mode/SKILL.md`.
- Project mode: `.pi/skills/<handle>-mode/SKILL.md` in the trusted repository.
- Preserve the existing location when updating a mode.

## Guardrails

- Do not codify a one-off correction, temporary workaround, or preference contradicted elsewhere.
- Keep global safety and confirmation rules in AGENTS.md as the source of truth. A mode may reference them but cannot weaken them.
- Write concrete instructions. Skip generic rules such as "communicate clearly" or "write quality code".
- Do not force symmetric sections. Sparse is correct when evidence is sparse.
- Prefer a lint, script, metadata flag, runtime check, or existing skill when it can enforce the lesson more reliably than prose.
- Mode skill changes are local writes with broad future effect. Keep the diff focused and show exactly what behavior changed.

## Report

- Evidence window and workspaces searched.
- High-confidence patterns included.
- Candidate patterns dropped and why.
- Questions answered directly by the user.
- Skill path and validation performed.
