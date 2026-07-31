---
name: prompt-ab-experiment
description: Controlled A/B experiment for measuring the effect of a prompt fragment or skill. Use when the user wants to test whether instructions change model behavior, compare a prompt or skill against a baseline, or quantify prompt compliance.
disable-model-invocation: true
---

# Prompt A/B Experiment

Run a controlled experiment: hold the model, task distribution, resources, and evaluation fixed; vary only the intervention. Predictability means repeating this process, not forcing identical outputs.

Never edit the user's live prompt, `AGENTS.md`, or skill during the experiment. Copy the intervention into the experiment directory and record its hash.

## 1. Lock the brief

Infer the experiment format from the request and current configuration. Ask the user one compact set of questions only when any choice below is unresolved and materially changes cost or interpretation:

- exact intervention: text, file, prompt section, or skill path;
- for a skill, whether to test natural invocation, the loaded body, or both;
- target behavior or claims the intervention is supposed to change;
- model, thinking level, repeats, budget, or prompt population when the defaults are unsuitable;
- requested deliverables beyond the standard artifact set.

State proposed defaults in the question so the user can approve them with one reply. Do not ask for information already evident from the request or local configuration.

Use these defaults for an exploratory run:

- current default model and thinking level;
- 8 prompt families, 2 repeats, randomized execution order;
- one blind judge using the generation model;
- raw responses, machine-readable results, and a Markdown report;
- HTML and a local server only when requested.

Read [`PROTOCOL.md`](PROTOCOL.md#experiment-manifest) when filling the manifest. This step is complete when every manifest field is either fixed or explicitly marked as a default, and treatment differs from baseline in exactly one named variable.

## 2. Freeze the intervention

Create a new experiment directory outside the intervention's owning directory. Copy the exact treatment text or skill into it, preserve the original formatting, and record the source path plus content hash in `manifest.json`. Keep the copy as the immutable treatment for the entire run.

For a section of a larger prompt, extract only that section. For a skill, copy the complete skill directory when its body points to sibling files; a partial copy can silently change its behavior.

For a skill directory, record sorted per-file SHA-256 values and hash that canonical file list; do not invent a platform-dependent directory hash.

This step is complete when a diff shows the frozen copy matches the intended source and its reproducible hash is present in the manifest.

## 3. Build the prompt suite

Design prompts before generating any response. Cover 6–10 families that expose distinct claims made by the intervention. Include a negative control when the intervention has a clear non-trigger domain; do not force an artificial control into a general writing experiment.

For a general writing instruction, use the stable eight-family suite:

1. short yes/no answer;
2. constrained technology choice;
3. causal technical explanation;
4. ordered diagnosis;
5. parallel enumeration;
6. multi-part architecture design;
7. a prompt that invites unnecessary verbosity;
8. a decision with a condition for reconsideration.

For a specialized prompt or skill, replace these with its real branches while retaining variation in answer shape and difficulty. Prompts must not mention the desired treatment behavior or reveal which arm they belong to. Put language requirements directly into every prompt when a disabled global context would otherwise change language.

Save stable IDs, family names, and exact text in `prompts.json`. This step is complete when every claimed behavior is exercised by at least one prompt, every in-scope skill branch is represented, and any applicable negative control is identified.

## 4. Pre-register the rubric

Derive observable criteria from the intervention before seeing outputs. Separate:

- **influence:** measurable changes in response form or behavior;
- **quality:** whether those changes improve compliance and usefulness;
- **correctness:** factual and technical validity, which outranks cosmetic compliance.

Score each criterion 0–2 and cap the total at a fixed value. Add intervention-independent mechanical metrics when applicable: words, paragraphs, headings, bullets, numbered steps, opening form, tool calls, files touched, tests run, or task success.

Save the rubric and verdict thresholds in `rubric.md`. Do not change them after generation; record any post-hoc observation separately. This step is complete when a blind judge can score either answer without knowing the arm and every reported claim maps to a rubric item or metric.

## 5. Isolate both arms

Use fresh one-shot processes with `--no-session`. Keep provider, model, thinking, equivalent cwd snapshot, prompt, tools, resource flags, and environment identical.

For prompt text or an `AGENTS.md` section:

- baseline: disable context discovery with `-nc`;
- treatment: also use `-nc`, then inject only the frozen text with `--append-system-prompt`;
- disable unrelated extensions, skills, templates, themes, and tools in both arms.

For a skill, choose one mode:

- **Natural invocation:** baseline uses `--no-skills`; treatment uses `--no-skills --skill <frozen-path>`. Give both arms the same tools, including `read` and every tool the skill needs. This measures discovery plus execution.
- **Body efficacy:** baseline omits the skill body; treatment injects the frozen body and every mandatory disclosed reference explicitly at the same system-prompt position. This measures instruction efficacy without invocation variance.
- **Both:** run baseline, natural invocation, and explicit body as three arms. Use this when failure to invoke must be separated from failure of the instructions.

User-invoked skills cannot be tested for natural invocation; use body efficacy unless the harness supports an actual skill command. Never disable a resource only in one arm unless that resource is the intervention.

Read [`PROTOCOL.md`](PROTOCOL.md#command-patterns) for command patterns. This step is complete when a serialized command diff confirms that only the intervention flag or content differs between arms.

## 6. Generate randomized samples

Build the full matrix of prompt × arm × repeat, shuffle it with a recorded seed, then execute with concurrency no greater than four unless the provider limit is known. Send large prompts through stdin rather than command arguments to avoid `ARG_MAX` failures.

When any arm can mutate files or persistent services, give every cell a separate pristine worktree, copy, container, or equivalent sandbox. Dispose of it after the cell; concurrency must never let one sample observe another sample's changes.

Write each response immediately to `outputs/<prompt-id>/<arm>-<repeat>.md`; never hold the only copy in memory until the batch ends. If registered metrics include tool calls, changed files, commands, or tests, run in JSON mode and save a per-cell event trace under `traces/`. On process failure, log the failed attempt and retry the same cell without silently counting the retry as an additional sample. Support a reuse mode so judging can resume without regenerating completed cells.

This step is complete when every planned matrix cell has exactly one accepted output, failures and retries are recorded, and no output from one arm entered another arm's context.

## 7. Measure before judging

Compute the pre-registered mechanical metrics for every response and aggregate them by arm. Preserve per-sample values in `results.json`; averages alone hide variance and outliers.

Check that changes point in the direction predicted by the intervention, but do not call them improvements yet. This step is complete when every mechanical claim intended for the report can be recomputed from `results.json`.

## 8. Blind the judge

Pair outputs from the same prompt and repeat. Randomize their labels as A/B with a second recorded seed, store the secret mapping separately, and send the judge the prompt, rubric, and answers without arm names or intervention text. Run the judge in a fresh process with context files, skills, extensions, templates, themes, and tools disabled so it cannot discover the intervention outside the blinded packet.

Require strict JSON with pair ID, winner (`A`, `B`, or `tie`), both scores, confidence, and one concrete reason. Tell the judge not to infer the treatment and not to reward formatting mechanically. Save both raw judge output and parsed judgments.

Use an independent judge model when the user requests stronger evidence; otherwise use the generation model and disclose the limitation. For three-arm experiments, compare baseline against each treatment independently rather than asking for a three-way ranking, and prefix pair IDs with the comparison name.

Read [`PROTOCOL.md`](PROTOCOL.md#judge-contract) for the exact contract. This step is complete when every pair has one valid judgment, labels map back unambiguously, and scores fall within the registered range.

## 9. Validate the experiment

Before interpreting results, verify:

- output count equals prompts × arms × repeats;
- frozen intervention hash still matches the manifest;
- model and thinking level are identical across arms;
- all JSON artifacts parse and pair IDs are unique;
- no unresolved placeholders remain in generated reports;
- recorded commands and any required traces for a random sample from each arm show the expected intervention boundary and no cross-arm contamination.

Fail loud if any check fails. Repair the harness and reuse valid outputs where possible; do not present a partial batch as a completed experiment. You may write `partial-report.md` without a verdict to diagnose unrecoverable cells, but `report.md` remains blocked. This step is complete only when every check passes.

## 10. Report fixed evidence

Write `report.md` in the stable format from [`PROTOCOL.md`](PROTOCOL.md#report-format). Always distinguish “the intervention changed behavior” from “the intervention improved quality.” Include representative pairs where treatment won, baseline won, and the judge tied when those outcomes exist.

For an exploratory two-repeat run, describe evidence as “clear in this sample,” “mixed,” or “inconclusive”; do not claim statistical significance. State that a same-model judge measures that model's stable preference rather than universal human quality.

This step is complete when the verdict follows from displayed counts and metrics, the limitations can change how a reader interprets it, and every number links back to a machine-readable artifact.

## 11. Add optional presentation

When requested, build a dependency-free HTML page from saved artifacts rather than copying numbers by hand. Include methodology, aggregate comparison, characteristic differences, selectable real answer pairs, and limitations. Verify it in a headless browser at desktop and narrow widths.

If remote viewing over SSH is requested, bind the server to `127.0.0.1`, record its PID and log, verify it with `curl`, and provide a client-side tunnel command:

```bash
ssh -N -L <local-port>:127.0.0.1:<server-port> user@host
```

Do not claim to have created the client-side tunnel from the remote host. This step is complete when the local HTTP endpoint responds, the page renders, and the exact URL, tunnel command, PID, and stop command are reported.
