---
name: update-skills
description: Audit and update the installed Pi skills while preserving local and harness-specific changes through semantic overlays.
disable-model-invocation: true
compatibility: Requires Git, Python 3.10+, and network access for upstream refreshes.
---

# Update skills

Use the inventory in [`../../skills-maintenance/manifest.json`](../../skills-maintenance/manifest.json) and the policy in [`../../skills-maintenance/README.md`](../../skills-maintenance/README.md).

1. Run `python3 agent/skills-maintenance/check.py` from `~/.pi`. Stop if installed files have drifted from their recorded hashes: first classify the drift as an intentional customization, an incomplete prior update, or unrelated damage.
2. Refresh each unique upstream repository through the `librarian` skill. Record the inspected commit. Do not replace `local` skills from a guessed remote.
3. For every `exact` skill, compare the complete upstream directory at the old and new revisions. Sync the complete directory only after confirming that it has no local overlay.
4. For every `overlay` skill, read its semantic overlay before editing. Compare old upstream, installed result, and new upstream. Reconstruct the result from the new upstream while preserving the overlay's intent; do not replay a textual patch blindly. When upstream now satisfies an overlay requirement, remove that redundant requirement from the overlay.
5. Preserve Pi frontmatter, tool names, permission boundaries, local workflow constraints, and bundled license files named by an overlay. Treat unexplained installed differences as blockers until they are documented or reverted.
6. Update repository revisions in the manifest and any source revision embedded in skill metadata. Update an overlay whenever the accepted local delta changes.
7. Run `python3 agent/skills-maintenance/check.py --refresh-installed-hashes`, then run `python3 agent/skills-maintenance/check.py --check-sources`. Review `git diff --check` and the complete diff before reporting.

Completion: every installed skill is classified, every tracked source is reconciled to a recorded commit, every retained customization is described semantically, and both maintenance checks pass.
