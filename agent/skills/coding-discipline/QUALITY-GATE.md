# Quality Gate

Use before finalizing any non-trivial code change. Review the diff as if it will receive a strict maintainability review.

Completion criterion: every question is checked against the actual diff; any structural regression is fixed or reported as a risk.

Ask:

1. Is there a code-judo move that would make this simpler by deleting branches, modes, helpers, or concepts?
2. Did the change add ad-hoc conditionals, flags, nullable modes, or special cases into an already busy flow?
3. Is the logic in the canonical owning layer/module, or did feature-specific behavior leak into shared plumbing?
4. Did I introduce a helper, wrapper, abstraction, or generic mechanism that does not clearly reduce complexity?
5. Did I duplicate an existing utility or pattern instead of reusing the canonical one?
6. Did I make type boundaries worse with `any`, `unknown`, casts, unnecessary optionality, or silent fallback?
7. Did a file/component grow toward or past a size boundary, especially 1000 lines?
8. Are independent async steps serialized unnecessarily, or can related state updates become partially applied?
9. Would a reviewer reasonably say this works but makes the surrounding code more spaghetti?

If any answer indicates structural regression, fix the structure before claiming the implementation is done.
