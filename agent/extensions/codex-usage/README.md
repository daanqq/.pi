# Codex Usage Extension

`codex-usage` is the unified Codex quota and native OAuth profile usage extension for Pi.

It:

1. shows current Codex subscription quota;
2. saves and switches `openai-codex` credentials as Pi-owned profiles;
3. rotates across saved profiles when quota is low or a profile is rate-limited.

## Purpose

The extension keeps Codex usable without restarting Pi or manually editing auth files.

It:

- fetches and displays Codex quota windows: 5h plus 7d/30d when present, or just 30d on accounts that expose only a monthly quota;
- refreshes the active footer quota every 60 seconds so remaining percentages do not stay stale during long idle sessions;
- stores named Codex profiles directly under Pi's agent directory;
- tracks last known quota per saved profile;
- rotates away from a profile whose weakest quota window is almost exhausted;
- chooses the best saved profile by score: the weakest remaining quota window;
- avoids switching auth while a provider request is in flight;
- reacts to HTTP `429` by cooling down the current profile and trying another one;
- synchronizes usage/rotation state and footer quota display across multiple Pi processes;
- treats async quota checks that outlive `/new`, `/resume`, `/fork`, or `/reload` as cancellation so stale extension contexts do not crash Pi;
- writes audit entries into the Pi session.

## Profile storage and security

Native profiles are stored as plaintext JSON at:

```text
~/.pi/agent/codex-usage-profiles/<name>.json
~/.pi/agent/codex-usage-profiles/.current
```

Profile files contain OAuth/API credentials for `openai-codex`. The extension writes them with best-effort `0600` permissions and keeps the directory private where the filesystem supports it, but there is no OS keychain or encryption layer.

Profiles are not imported automatically from legacy `~/.codex/auth-profiles`. If you used a previous shell-based auth-profile workflow, migrate those profiles once into this new store.

## Basic workflow

Save the currently configured Pi `openai-codex` auth as a named profile:

```text
/codex:profile save main
/codex:profile save alt
```

Inspect and switch profiles:

```text
/codex:profile status
/codex:profile list
/codex:profile use main
```

Scan or rotate:

```text
/codex:rotate scan
/codex:rotate now
/codex:rotate profile alt
```

`/codex:profile save <name>` overwrites an existing profile with the same name and makes it current. `/codex:profile use <name>` switches auth and updates profile state, but does not change whether automatic rotation is enabled.

## Rotation rules

Defaults:

```ts
rotateBelowPercent = 5;
eligibleAbovePercent = 10;
```

Current profile is considered low when:

```text
min(available remaining quota windows) <= 5
```

A candidate is eligible when:

```text
quota fetch succeeds
AND min(available remaining quota windows) >= 10
AND profile is not in cooldown
```

The selected profile is the eligible candidate with the highest score:

```text
score = min(available remaining quota windows)
```

## When rotation runs

To avoid slowing down prompt submission, the extension does **not** perform quota scans in `before_agent_start`.

Rotation/checks happen at safer boundaries:

- `turn_end` — between provider calls inside a long-running agent loop;
- `agent_end` — after an agent run, preparing for the next prompt;
- `session_start` / `model_select` — asynchronous status refresh;
- periodic footer refresh every 60 seconds — fetches the active profile quota and updates state/status without rotating;
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

Other Pi processes watch the state file, reload auth when `activeProfile` changes, and redraw their footer from the shared last-known quota whenever the state changes. This keeps quota display in multiple Pi windows synchronized without forcing every window to fetch quota immediately.

## Commands

### `/codex:quotas`

Shows current Codex subscription quota for the active `openai-codex` credential.

### `/codex:profile status`

Shows the current native profile marker, active state profile, current profile email when known, and saved profile count.

### `/codex:profile list`

Lists saved native profiles. The current profile is marked with `*`.

### `/codex:profile save <name>`

Saves the current Pi `openai-codex` credential to `<name>`, overwriting any existing profile with that name, and makes it active/current.

### `/codex:profile use <name>`

Switches Pi `openai-codex` auth to a saved profile and updates active profile state. This does not toggle automatic rotation.

### `/codex:profile delete <name>`

Deletes a saved native profile. If the deleted profile is current, `.current` and active profile state are cleared.

### `/codex:rotate status`

Shows current usage/rotation state:

- auto enabled/disabled;
- active profile;
- active account/email;
- current or last known quota;
- active cooldowns.

### `/codex:rotate now`

Forces a scan of saved profiles and switches to the best eligible profile.

### `/codex:rotate on`

Enables automatic rotation persistently.

### `/codex:rotate off`

Disables automatic rotation persistently.

Manual commands like `now` and `profile <name>` still work.

### `/codex:rotate profile <name>`

Manually switches Codex auth to a specific saved native profile after verifying quota is available.

### `/codex:rotate scan`

Scans all saved native profiles and displays:

- profile name/email;
- 5h and 7d/30d quota windows when present;
- score;
- whether the profile is eligible;
- skip reason for ineligible profiles.

## Footer

Compact status format shows the active profile, time until each window resets, and remaining percentage. While Pi is in TUI mode, the extension refetches the active quota once per minute and rewrites this footer status, even when automatic rotation is disabled. It intentionally omits the leading `codex` label:

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
