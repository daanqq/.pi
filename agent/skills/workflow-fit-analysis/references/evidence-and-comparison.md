# Evidence and comparison

Use this reference while inventorying and comparing a foreign workflow.

## Inventory fields

Account for each top-level unit with these fields:

| Field | Question |
| --- | --- |
| Unit | What is the stable name and pinned source path? |
| Trigger | What distinct branch causes the unit to run? |
| Job | What decision, artifact, or state does it produce? |
| Process | What ordered steps does it require? |
| Done | What observable condition ends the process? |
| Dependencies | Which tools, models, agents, MCPs, files, services, or sibling units are required? |
| Writes | Which local or external state can it change? |
| Cost | Low, medium, high, or very high, with the reason. |
| Composition | Is it a leaf method, router, reviewer, generator, or maintenance loop? |
| Assumptions | Which platform, repository host, transcript format, model API, or autonomy policy does it assume? |
| Failure modes | How can it waste time, duplicate work, hide uncertainty, or violate policy? |

Do not judge a router as if it independently solves the work. Expand enough of its branches to identify where the real mechanisms live.

## Evidence classes

- **FACT.** Directly supported by the pinned foreign source, current configuration, Pond aggregate, session transcript, or live repository state.
- **INTERPRETATION.** A conclusion drawn from one or more facts. State the inference chain.
- **CAVEAT.** A source, method, privacy, compatibility, or measurement limitation that changes how a fact should be used.
- **INCONCLUSIVE.** Evidence needed for the decision is unavailable or contradictory. This is a result, not a failure to write confidently.

Frequency proves recurrence, not value. Tool usage proves an operation occurred, not that it improved the outcome. A long session proves elapsed span, not context loss. A green proxy proves only the layer it exercises.

## Adoption status

### Adopt now

The mechanism addresses repeated evidence, fits current policy, has bounded cost, and does not duplicate an existing owner.

### Pilot

The mechanism is plausible but expensive, weakly evidenced, or sensitive to task shape. Give it an eligibility trigger, a measurement, and a rollback condition.

### Borrow principle only

The useful part is one rule that belongs in an existing skill, AGENTS policy, check, or script. A separate skill would add name collision or another router.

### Skip

The mechanism is redundant, conflicts with policy, assumes unavailable infrastructure, or costs more than the observed problem justifies.

## Compatibility status

### Drop-in

The unit's process, paths, tools, and safety model work in Pi with at most local link fixes.

### Port needed

The mechanism is useful, but tools, transcript paths, model parameters, platform integration, storage, or policy must change.

### Redundant

An installed owner already produces the same result. Record only the missing rule worth merging.

### Conflict

Literal adoption would violate current safety policy, read-only behavior, subagent budget, review budget, privacy, or platform constraints.

## Recommendation chain

Every positive recommendation must answer all seven parts:

1. **Observed problem.** What repeated or high-cost issue exists in the user's workflow?
2. **Mechanism.** What exact behavior in the foreign workflow addresses it?
3. **Benefit.** What should change for the user or maintainer?
4. **Cost and risk.** What latency, context, fan-out, setup, writes, or false confidence does it add?
5. **Trigger.** Which tasks earn that cost?
6. **Anti-trigger.** Which adjacent tasks should stay on the simpler path?
7. **Adaptation.** What must change for Pi, Pond, the repository host, and the user's policy?

Reject a recommendation when one of these parts cannot be answered without invention.

## Skeptical review

The critic checks:

- counts treated as proof of effectiveness;
- Cursor or cloud assumptions presented as Pi capabilities;
- multi-agent panels recommended without measured payoff;
- new skills that duplicate installed owners;
- external writes hidden inside a verification, shipping, or maintenance step;
- strict rules applied outside their real trigger;
- a polished report that hides `INCONCLUSIVE` evidence;
- a rollout that cannot be reversed cheaply.
