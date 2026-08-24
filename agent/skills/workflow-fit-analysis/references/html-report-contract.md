# HTML report contract

Build a decision report, not an alphabetical catalog with decoration.

## Required sections

1. **Verdict.** One direct recommendation and its main limitation.
2. **Scope.** Foreign source, exact revision, target boundary, Pond evidence window, and privacy treatment.
3. **Observed workflow.** A small set of measured signals with source and confidence.
4. **Decision path.** Show which mechanisms apply at which phase or task type.
5. **Recommendations.** `Adopt now`, `Pilot`, `Borrow principle only`, and `Skip`.
6. **Full inventory.** Every top-level foreign unit with adoption and compatibility status.
7. **Evidence ledger.** FACT beside INTERPRETATION and CAVEAT; show INCONCLUSIVE cases.
8. **Adapter gaps.** Tools, models, MCPs, repository host, transcript layout, autonomy, and external writes.
9. **Bounded rollout.** At most five changes with measurements and rollback conditions.
10. **Method and limits.** Search method, sample method, heuristic categories, unavailable sources, and checks run.

## Useful interactions

Choose only interactions that answer a follow-up question:

- task-type selector that returns a short mechanism sequence;
- filters for adoption, compatibility, cost, platform, or category;
- comparison of up to three units;
- expandable evidence and methodology;
- print of the active selection.

Every control must work with keyboard input and preserve a visible selected state. Essential facts remain visible without hover.

## Data rules

- Use exact counts only when the method supports them.
- Label text-derived categories as heuristic.
- Do not turn recurrence counts into a numerical fit score.
- Keep status color separate from decorative color and repeat every status in text.
- Link to the pinned source path, not a moving default branch.
- Keep private evidence aggregated or paraphrased.

## Verification

Before delivery verify:

- HTML parser accepts the document;
- inline JavaScript passes syntax checking;
- the initial state contains real recommendations;
- filters, reset, comparison, and disclosures work when present;
- no console error remains;
- wide and narrow layouts have no accidental page overflow;
- focus is visible and contrast is accessible;
- print preserves verdict, active route, recommendation table, evidence, and caveats.
