---
name: eutp-worktree
description: Prepare dedicated git worktrees for implementing an EUTP ticket. Use if user asks to use worktrees, or initial repo has changes.
---

# EUTP worktree

Do not implement an EUTP ticket in the original checkout. Create a dedicated worktree under `~/echat/worktrees/` unless the user specifies another location.

Name it `<repository>-EUTP-<digits>`, using the repository name and ticket ID. For example, for 'tidy-client' repo:

```text
~/echat/worktrees/tidy-client-EUTP-123123
```

Create one worktree per affected repository. Make new branch named 'task-EUTP-123123' if task needs one repo changes, or 'feature/EUTP-123123' if multiple repos. Reuse an existing matching worktree after verifying that it belongs to the same ticket and repository; do not overwrite or remove it.

Perform the requested implementation and its checks from the worktree.
