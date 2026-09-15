# `show-me-your-work` semantic overlay

## Preserve

- Keep one compact append-only TSV decision trail for long-running, delegated, multi-phase, or unattended work.
- Use evidence pointers and concrete result states; log decisions, pivots, blockers, and checkpoints rather than routine actions.
- Keep logs local by default and commit them only when reviewability requires it.
- Preserve safe cell handling in `scripts/log.sh`, the bundled license, and Pi metadata.
- Audit the trail against available task evidence without reading unrelated private transcripts.

## Replace or omit from upstream

- Remove hard dependencies on Cursor transcript locations, Cursor-only skills, and mandatory cross-model review.
- Use the active harness's actual transcript/evidence facilities when available; if they are unavailable, audit against the artifacts and session evidence that can be read safely.

## Acceptance

Every retained row maps to a real decision and resolvable evidence; invented, aspirational, or padded rows are absent.
