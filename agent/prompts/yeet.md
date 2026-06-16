---
description: Add, commit, and push the current repo changes
argument-hint: "[instructions]"
---
Commit and push the current repository changes.

Steps:
1. Add all unstaged changes with `git add -A`.
2. Inspect the staged changes and write a concise commit message that accurately summarizes them.
3. Commit the changes with that message.
4. Push the commit to the current branch's remote.
   - If the current branch does not have an upstream remote branch, create one by pushing with upstream tracking.
   - If this repository has no git remotes configured, do not push.
5. After pushing, output the remote URL for what was pushed if the repository has a remote.
   - If the current branch is `main` or `master`, output the normal remote repository URL.
   - If the current branch is neither `main` nor `master`, output a URL to create a pull request from the pushed branch into `main` or `master`.
   - Convert SSH git remotes like `git@github.com:owner/repo.git` to HTTPS URLs when printing.

Keep the commit message concise.

Additional instructions from the user:
$ARGUMENTS
