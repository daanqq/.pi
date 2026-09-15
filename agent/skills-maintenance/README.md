# Skill maintenance

This directory separates upstream skill updates from local intent.

- [`manifest.json`](manifest.json) is the inventory and source lock. `exact` means the installed directory must equal the locked upstream directory. `overlay` means the installed directory intentionally differs and names a semantic overlay. `local` means there is no authoritative update source.
- [`overlays/`](overlays/) records additions, removals, replacements, and invariants in words. These are not textual patches: an updater applies their intent to the new upstream version and may rewrite an overlay when upstream absorbs part of it.
- [`check.py`](check.py) validates the inventory, frontmatter names, recorded installed hashes, locked source paths, and exact upstream copies.
- [`../skills/update-skills/SKILL.md`](../skills/update-skills/SKILL.md) is the executable agent workflow.

## Rules

1. Never infer an upstream from a matching skill name alone. Add a source only when provenance is supported by installation metadata, embedded metadata, or an exact content match to a known repository.
2. Preserve unexplained local differences until their origin is known. Classify and document them before updating.
3. An overlay describes behavior and harness compatibility, not line numbers or copied diff hunks.
4. Keep one overlay per customized upstream skill. Exact and local skills do not need empty overlay files.
5. After an accepted edit, refresh installed hashes and run the source check. A hash is a drift detector, not a substitute for the semantic overlay.

## Commands

```bash
cd ~/.pi
python3 agent/skills-maintenance/check.py
python3 agent/skills-maintenance/check.py --check-sources
python3 agent/skills-maintenance/check.py --refresh-installed-hashes
```
