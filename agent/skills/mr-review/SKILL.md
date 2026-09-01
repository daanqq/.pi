---
name: mr-review
description: Review committed or uncommitted changes from GitLab merge requests and local Git branches, including multi-repository EChat changes, task requirements, contracts, compatibility, and maintainability. Use when the user asks to review MR links or their local work before pushing it.
disable-model-invocation: true
---

# Change Review

Review the targets described by the review context passed in the skill arguments. A target may be a GitLab MR fetched into an isolated repository under `/home/user/echat/reviews`, or a local working repository under `/home/user/echat` containing unpushed, staged, unstaged, or untracked changes.

## Scope rules

- Treat the review context in the user request as the source of truth for repository paths, refs, merge bases, scope, task context, and related tasks.
- Work across every target in the request. For a multi-repository task, evaluate them as one logical change rather than isolated diffs.
- Read local targets directly at their absolute paths. Do not expect their branches or working-tree changes to exist in the review clones.
- Run every Git command with an explicit repository path: `git -C <repoDir> ...`.
- Derive the diff only from each target's `Path`, `Merge base`, `Head`, and `Scope`. Do not choose another base branch or inspect a sibling checkout.
- For `branch`, review committed changes with `git -C <repoDir> diff <mergeBase>..<headRef>`.
- For `working-tree`, review staged, unstaged, and listed untracked files.
- For `all`, combine branch, staged, unstaged, and untracked changes without reporting the same issue twice.
- If the request lists untracked files, read them explicitly because `git diff` does not include them.
- Establish an in-scope changed-file and changed-line set before reviewing. Files outside it may be read only as supporting context; do not report a finding unless its cause is an in-scope changed line.
- Do not assume tests were run; execute focused checks when practical and state exactly what was or was not run.

## Workflow

1. Read the complete review context included in the user request.
2. Load and read the complete `thermo-nuclear-code-quality-review` skill from `~/.pi/agent/skills/thermo-nuclear-code-quality-review/SKILL.md`. Apply it as the mandatory quality bar unless the user explicitly opts out.
3. Build and run the minimal diff commands from each target's path, merge base, head, and scope. Record the changed files and hunks as the hard review boundary; inspect repository status only for local working-tree scopes.
4. Read every changed file needed to understand the implementation, plus immediate callers, consumers, tests, schemas, mappers, and canonical helpers.
5. Build the end-to-end flow before judging individual fragments. For protocol or API changes, inspect producers and consumers on both sides.
6. Compare the implementation with the primary task, additional information, and related tasks from the request.
7. For multi-repository changes, identify changed contracts and verify deployment order, rollback, defaults, nullability, migrations, feature flags, and graceful degradation.
8. Run focused tests, type checks, or lint checks when they materially increase confidence.
9. Report only actionable, high-confidence findings. Do not add cosmetic nits to make the review look populated.

## Follow-up implementation

If the user asks to implement fixes after the review, keep the review checkout read-only and do the work in a persistent task worktree:

1. Create or reuse `/home/user/echat/worktrees/<repo>-<TASK_ID>`, for example `/home/user/echat/worktrees/tidy-client-EUTP-123123`. For a multi-repository task, use one task worktree per repository.
2. Prefer the task branch from the normal source repository under `/home/user/echat`, including its remote-tracking branch when needed. Use the MR head only when no task branch is available, and state that fallback.
3. Apply and verify changes only in the task worktree. Do not modify generated review workspaces or repositories under `/home/user/echat/reviews`.

Before reusing an existing path, verify its repository, branch, and working-tree state. Preserve unrelated local changes.

## Review standard

Use `thermo-nuclear-code-quality-review` as the single source of truth for maintainability, structural simplification, abstraction quality, file size, type boundaries, canonical ownership, and the approval bar. In addition, prioritize correctness, security, data loss, races, compatibility, regressions, and task compliance.

Severity means:

- **Blocker**: data loss, security issue, unrecoverable deployment failure, or change that cannot safely merge.
- **Major**: user-visible regression, broken contract, race, substantial missing requirement, or design that will predictably cause incorrect behavior.
- **Minor**: bounded maintainability or correctness issue worth fixing in this change, with concrete impact.

## Output

Respond in Russian unless the user requested another language. State the actual repository paths checked.

For each finding include:

- severity and concise title;
- repository and `path:line`;
- problem and the mechanism that causes it;
- concrete impact;
- suggested correction.

For a cross-repository finding, cite both the changed contract and the mismatched producer or consumer.

Use this structure, omitting empty finding sections:

```md
Проверял изменения в `<paths>`.

## Задача
- **ID**: ...
- **Суть**: ...

## Общая карта изменения
- **Flow**: ...
- **Изменённые контракты**: ...
- **Deploy/rollback риски**: ...

## Findings

### Blocker / Major / Minor: <краткий заголовок>

- **Репозиторий**: `<repo>`
- **Файл**: `<path>:<line>`
- **Проблема**: ...
- **Влияние**: ...
- **Предложение**: ...

## Сверка с задачей

| Пункт задачи | Статус | Комментарий |
|-------------|--------|-------------|
| ... | Готово / Частично / Не готово | ... |

Примечания: какие проверки запускались, что не удалось проверить, загружена ли задача.
```

If there are no findings, explicitly say that no blocker, major, or minor issues were found, but still provide task verification and note the checks performed. Use plain text statuses in tables; do not use emoji because their glyph widths can break rendered borders.
