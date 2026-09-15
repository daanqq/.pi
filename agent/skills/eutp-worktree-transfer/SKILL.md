---
name: eutp-worktree-transfer
description: Transfer completed EUTP worktree branches and uncommitted changes back to their original repository checkouts for local builds. Use after EUTP implementation in one or more worktrees when the user asks to move the work to the original repositories.
---

# EUTP worktree transfer

For every affected repository:

1. Identify the task worktree, its branch, and the original checkout. Verify they belong to the same repository and EUTP ticket.
2. Require the original checkout to have no user changes that could be overwritten. Stop and ask if it is not clean.
3. Back up `git diff --binary HEAD` and all non-ignored untracked files to a task-specific temporary directory. Verify the backup before removing anything.
4. Remove only the matching task worktree, switch the original checkout to the same branch, then apply the tracked patch and restore untracked files without overwriting existing files. Preserve changes as uncommitted unless the user requested commits.
5. Run `git diff --check` and report the branch and `git status --short` for every original checkout. Delete only temporary backups created by this run after successful verification.

If switching, applying, or restoring cannot finish without conflicts, preserve the backup, stop this workflow, and explicitly propose continuing with the [`fix-merge-conflicts`](../fix-merge-conflicts/SKILL.md) skill. Do not resolve conflicts ad hoc.

Complete only when every affected original checkout is on the worktree branch and contains all tracked and untracked task changes.
