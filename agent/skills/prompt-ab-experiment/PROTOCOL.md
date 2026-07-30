# Prompt A/B Experiment Protocol

This is mandatory reference for the matching steps in [`SKILL.md`](SKILL.md). It fixes artifact names, command boundaries, judge output, and report shape so separate runs remain comparable.

## Experiment manifest

Write `manifest.json` before generation:

```json
{
  "experiment_id": "YYYYMMDD-short-name",
  "question": "What influence is being tested?",
  "intervention": {
    "type": "prompt|skill",
    "mode": "system-append|natural-invocation|body-efficacy|both",
    "source": "/original/path/or/user-text",
    "frozen_path": "intervention/...",
    "sha256": "...",
    "files": [{"path": "SKILL.md", "sha256": "..."}]
  },
  "hypotheses": ["observable directional claim"],
  "model": "provider/model",
  "thinking": "off|minimal|low|medium|high|xhigh|max",
  "judge_model": "provider/model",
  "prompt_families": 8,
  "repeats": 2,
  "arms": ["baseline", "treatment"],
  "execution_seed": 0,
  "blinding_seed": 0,
  "tools": [],
  "defaults_accepted": true
}
```

For one file, `sha256` is its content hash and `files` may be omitted. For a directory, sort `files` by normalized relative path, serialize the array as compact UTF-8 JSON, and use that byte string's SHA-256 as the intervention hash. Add fields rather than overloading existing ones when the experiment needs provider limits, multiple judges, task repositories, or outcome-specific settings.

## Command patterns

Send the user prompt through stdin. This avoids shell quoting differences and argument-length failures.

### Prompt intervention

Baseline:

```bash
printf '%s' "$PROMPT" | pi -p --no-session -nc --no-tools \
  --no-extensions --no-skills --no-prompt-templates --no-themes \
  --model "$MODEL" --thinking "$THINKING"
```

Treatment adds one argument before the prompt arrives on stdin:

```bash
--append-system-prompt "$(cat intervention/prompt.md)"
```

### Natural skill invocation

Keep the same tool allowlist in both arms. Baseline uses `--no-skills`; treatment adds:

```bash
--no-skills --skill intervention/skill/SKILL.md
```

Do not add `--no-tools` when the skill needs `read` to load its body or tools to execute its behavior. Prefer an explicit identical allowlist such as `--tools read,grep,find` in both arms.

### Body efficacy

Use the prompt-intervention pattern, but inject a clearly delimited packet containing `SKILL.md` and every file reached by a mandatory context pointer. Resolve relative links before freezing; label each included file:

```text
Follow the skill below for this request.
<skill>
--- FILE: SKILL.md ---
...frozen SKILL.md...
--- FILE: PROTOCOL.md ---
...mandatory disclosed reference...
</skill>
```

This is an efficacy test, not an invocation test; label it accordingly in every artifact. If references must remain tool-loaded, give both arms the same `read` allowlist and frozen directory visibility instead of disabling tools.

### Judge isolation

Send the complete blinded packet through stdin using a fresh command with no discoverable resources:

```bash
printf '%s' "$JUDGE_PACKET" | pi -p --no-session -nc --no-tools \
  --no-extensions --no-skills --no-prompt-templates --no-themes \
  --model "$JUDGE_MODEL" --thinking "$JUDGE_THINKING"
```

The packet itself contains the judge contract, rubric, original prompts, and blinded answers. It must not contain the intervention, arm mapping, source paths, or treatment labels.

### Tool-event traces

When the registered outcomes include agent actions, replace print mode with `--mode json` and save stdout as `traces/<prompt-id>/<arm>-<repeat>.jsonl`. Extract the final assistant answer into the normal `outputs/` path, so judging and action metrics use separate artifacts.

## Judge contract

The judge prompt must state:

1. judge the answer against the original user prompt and registered rubric;
2. technical correctness outranks style compliance;
3. do not infer which answer is treatment;
4. do not reward headings, bullets, brevity, or length without task-specific reason;
5. return JSON only.

Required schema:

```json
{
  "pairs": [
    {
      "pair_id": "comparison-prompt-id-repeat",
      "winner": "A|B|tie",
      "A_score": 0,
      "B_score": 0,
      "confidence": 0.0,
      "reason": "One concrete sentence tied to the rubric."
    }
  ]
}
```

For a two-arm run, `comparison` may be `treatment-vs-baseline`; for three arms, use distinct prefixes such as `natural-vs-baseline` and `explicit-vs-baseline`. Validate pair coverage, enum values, score bounds, and unique IDs before unblinding. Keep `blind-pairs.json`, `blind-mapping.json`, `judge-raw.txt`, and `judgments.json` as separate artifacts.

## Artifact tree

```text
experiment/
├── manifest.json
├── intervention/
├── prompts.json
├── rubric.md
├── outputs/<prompt-id>/<arm>-<repeat>.md
├── traces/<prompt-id>/<arm>-<repeat>.jsonl  # when actions are measured
├── results.json
├── blind-pairs.json
├── blind-mapping.json
├── judge-raw.txt
├── judgments.json
├── report.md
├── index.html              # optional
├── server.pid              # optional
└── server.log              # optional
```

The harness source belongs beside these artifacts. It must have a reuse/resume mode that skips generation only after validating the expected output cell.

## Report format

Use these sections in order:

1. **Verdict** — answer whether behavior changed, then whether quality improved, with the central caveat.
2. **Experiment** — intervention, baseline, model, thinking, prompt families, repeats, arms, and judge.
3. **Aggregate results** — wins, losses, ties, average registered scores, and confidence distribution.
4. **Mechanical metrics** — treatment and baseline side by side, including variance or ranges where useful.
5. **Characteristic differences** — behaviors repeatedly associated with each arm and why they matter.
6. **Pairwise evidence** — every pair's unblinded winner, scores, and judge reason.
7. **Representative answers** — at least one treatment win and any baseline win or tie that exists.
8. **Validation** — artifact counts, hashes, parsing checks, and failures/retries.
9. **Limitations** — sample size, stochasticity, judge dependence, prompt-population limits, and any post-hoc analysis.
10. **Reproduction** — exact command and artifact paths.

Do not hide adverse or null results. A prompt can clearly influence form while failing to improve correctness; report both conclusions.
