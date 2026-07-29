---
name: fix-gitlab-mr-review
description: Fix unresolved GitLab merge request review comments in an isolated worktree.
compatibility: Requires git, glab, Python 3, SSH access to GitLab, and repositories normally located under ~/echat.
disable-model-invocation: true
---

# Fix GitLab MR review

Treat the MR as the index: derive the project, source branch, target branch, and every unresolved discussion from it instead of asking the user to restate them.

## 1. Fetch the review

1. Parse the host from the MR URL and run `glab auth status --hostname <host>`.
2. Resolve `scripts/fetch_mr_review.py` relative to this `SKILL.md`, then run:

   ```bash
   python3 <skill-dir>/scripts/fetch_mr_review.py '<mr-url>' > /tmp/mr-review.json
   ```

3. If `glab` is not authenticated, source `~/.zshrc` only inside a shell subprocess and use an explicitly named GitLab token if one exists; never print token values. If no valid credential is available, ask the user to authenticate `glab`.
4. Stop if the MR metadata cannot be fetched. Do not scrape the HTML page as a silent fallback because truncated or hidden discussions make the review incomplete.

**Completion criterion:** `/tmp/mr-review.json` contains the MR source branch, target branch, current SHA, and every unresolved non-system discussion, including replies.

## 2. Isolate the branch

Repositories for this workflow normally live under `~/echat`.

1. Prefer `~/echat/<repo-name>`. Verify its `origin` matches the MR host and project path; do not trust a matching directory name alone.
2. If it is absent, clone with SSH, never HTTPS:

   ```bash
   git clone git@<host>:<project-path>.git ~/echat/<repo-name>
   ```

3. Fetch the source and target branches without altering the existing checkout.
4. Create a dedicated worktree at `~/echat/worktrees/<repo-name>-mr-<iid>` on a temporary branch `mr-review-<iid>` based on `origin/<source-branch>`. This avoids conflicts when the source branch is already checked out elsewhere:

   ```bash
   git -C ~/echat/<repo-name> worktree add \
     -b mr-review-<iid> \
     ~/echat/worktrees/<repo-name>-mr-<iid> \
     origin/<source-branch>
   ```

5. If that worktree or temporary branch already exists, reuse it only when it points at the same project/MR and is clean. Never reset, clean, switch, stash, or overwrite another worktree to make room.
6. Read applicable `AGENTS.md` files from `~/echat` through the worktree repository before editing.

**Completion criterion:** all work happens in a clean dedicated worktree whose base is the fetched source-branch SHA; unrelated checkouts and user changes are untouched.

## 3. Triage every discussion

For each unresolved discussion, read all replies, the positioned file context, and the MR diff against the target branch. Classify it as exactly one of:

- **Mechanical and valid:** one behavior-preserving interpretation is evident from code and repository conventions. Examples: remove duplication, name a magic value, fix imports/types/formatting, use an established wrapper without changing semantics.
- **Business:** it can change validation, permissions, persisted data, API/protocol/schema contracts, error codes or user-visible errors, ordering, transaction behavior, or product behavior.
- **Ambiguous:** more than one reasonable implementation exists or the reviewer proposes a direction without enough context. Treat this as business.
- **Outdated or invalid:** current source already addresses it, its premise is false, or the proposed change would regress documented behavior.

Do not classify from the comment text alone. A review suggestion becomes mechanical only after the current code and local conventions establish a single behavior-preserving fix.

**Completion criterion:** every unresolved discussion has a classification, evidence from current code, and either a concrete fix or a concrete question.

## 4. Apply safe fixes and stop at product decisions

1. Apply all valid mechanical fixes surgically. Search broadly before deleting or declaring anything unused.
2. Do not change business or ambiguous behavior. Ask the user one batched question containing:
   - the discussion URL and reviewer request;
   - the current behavior;
   - the plausible options and their consequences;
   - your recommended option.
3. After the user decides, implement only the selected behavior.
4. Do not resolve threads, post replies, commit, push, rebase, or force-update unless the user explicitly requests that external write.

**Completion criterion:** every valid mechanical discussion is fixed, every business/ambiguous discussion has an explicit user decision before implementation, and outdated/invalid discussions are documented rather than changed.

## 5. Verify the repair

Run the narrowest relevant checks from repository instructions, then the broader typecheck/lint/test suite justified by the touched files. Always run `git diff --check` and inspect the complete diff against `origin/<source-branch>` for unrelated changes.

Map each discussion to one of: fixed, awaiting decision, or no change with reason. A passing build does not compensate for an unaccounted discussion.

**Completion criterion:** every discussion is accounted for, relevant checks have known results, the diff contains only review-driven changes, and skipped checks are reported with the exact reason.

## 6. Report and optionally publish

Report the worktree path, source branch, changed files, discussion-to-fix mapping, validation results, and remaining decisions.

When the user explicitly asks to publish:

1. Fetch `origin/<source-branch>` again and ensure it has not advanced unexpectedly.
2. Commit with the requested message.
3. Push the temporary worktree branch to the MR source branch with a normal fast-forward push:

   ```bash
   git push origin HEAD:<source-branch>
   ```

4. Use `--force-with-lease` only when the user explicitly asks for history replacement.

**Completion criterion:** local-only runs leave publication untouched; authorized publication reports the resulting commit SHA and confirms local HEAD matches the remote source branch.
