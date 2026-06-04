# Codex Usage Extension

`codex-usage` is the unified Codex quota and OAuth profile usage extension for Pi.

It combines two responsibilities that used to be split across `codex-quotas.ts` and `codex-rotation/`:

1. show current Codex subscription quota;
2. rotate the `openai-codex` OAuth credential across saved `ca` profiles when quota is low or a profile is rate-limited.

## Purpose

The extension keeps Codex usable without restarting Pi or manually editing auth files.

It:

- fetches and displays Codex 5h and 7d quota windows;
- tracks last known quota per saved profile;
- rotates away from a profile whose weakest quota window is almost exhausted;
- chooses the best saved profile by score: `min(5hRemaining, weeklyRemaining)`;
- avoids switching auth while a provider request is in flight;
- reacts to HTTP `429` by cooling down the current profile and trying another one;
- synchronizes usage/rotation state across multiple Pi processes;
- writes audit entries into the Pi session.

## Requirements

Profile rotation expects a `ca` command with JSON APIs:

```bash
ca list --json
ca token <profile> --json
```

`ca token <profile> --json` must return the profile credential **without changing global active auth**.

Optional fallback APIs:

```bash
ca restore <profile> --json
ca current --json
```

If `ca` is not an executable in `PATH`, the wrapper can fall back to the `ca` zsh function from `~/.pi/agent/zshrc` when available.

The quota viewer can still query the currently configured `openai-codex` auth directly from Pi auth storage, with a fallback account id from `~/.codex/auth.json`.

## Rotation rules

Defaults:

```ts
rotateBelowPercent = 5;
eligibleAbovePercent = 10;
```

Current profile is considered low when:

```text
min(5hRemaining, 7dRemaining) <= 5
```

A candidate is eligible when:

```text
quota fetch succeeds
AND min(5hRemaining, 7dRemaining) >= 10
AND profile is not in cooldown
```

The selected profile is the eligible candidate with the highest score:

```text
score = min(5hRemaining, 7dRemaining)
```

## When rotation runs

To avoid slowing down prompt submission, the extension does **not** perform quota scans in `before_agent_start`.

Rotation/checks happen at safer boundaries:

- `turn_end` — between provider calls inside a long-running agent loop;
- `agent_end` — after an agent run, preparing for the next prompt;
- `session_start` / `model_select` — asynchronous status refresh;
- `after_provider_response` on `429` — emergency cooldown + rotation attempt;
- manual commands.

## Global state

State is stored at:

```text
~/.pi/agent/codex-usage-state.json
```

For migration, the extension can read the legacy state file if the new one does not exist:

```text
~/.pi/agent/codex-rotation-state.json
```

The state file records:

- whether auto rotation is enabled;
- active profile/account/email;
- last rotation time;
- profile cooldowns;
- last known quota per profile.

A global lock is used during commit:

```text
~/.pi/agent/codex-usage.lock
```

Other Pi processes watch the state file and reload auth when `activeProfile` changes.

## Commands

### `/codex:quotas`

Shows current Codex subscription quota for the active `openai-codex` credential.

Output includes:

- subscription email when available;
- 5h remaining percentage and reset time;
- 7d remaining percentage and reset time.

This command is the migrated command-only behavior from the old `codex-quotas.ts` extension.

### `/codex:rotate status`

Shows current usage/rotation state:

- auto enabled/disabled;
- active profile;
- active account/email;
- current or last known quota;
- active cooldowns.

### `/codex:rotate now`

Forces a scan of saved profiles and switches to the best eligible profile.

Use this when you want immediate rotation instead of waiting for `turn_end` or `agent_end`.

### `/codex:rotate on`

Enables automatic rotation persistently.

### `/codex:rotate off`

Disables automatic rotation persistently.

Manual commands like `now` and `profile <name>` still work.

### `/codex:rotate profile <name>`

Manually switches Codex auth to a specific saved `ca` profile.

Example:

```text
/codex:rotate profile alt1
```

Before switching, the extension fetches the profile token and verifies quota is available.

### `/codex:rotate scan`

Scans all saved `ca` profiles and displays:

- profile name/email;
- 5h and 7d quota;
- score;
- whether the profile is eligible;
- skip reason for ineligible profiles.

## Footer

Compact status format shows the active profile, time until each window resets, and remaining percentage. It intentionally omits the leading `codex` label:

```text
main 3h12m:84% 5d4h:42%
```

Low quota example:

```text
main low 12m:4% 5d4h:42%
```

## Audit trail

Successful rotations append session audit entries with custom type:

```text
codex-usage
```

429 events append:

```text
codex-usage-429
```

Skipped rotation attempts may append:

```text
codex-usage-skip
```
