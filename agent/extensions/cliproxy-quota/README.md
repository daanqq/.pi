# CLIProxyAPI quota footer

Shows the combined remaining Codex quota for enabled accounts exposed by the
CLIProxyAPI Management API while the selected Pi model uses provider
`cliproxy`. The extension obtains each account's current token through
`/v0/management/api-call`; it does not read OAuth files directly.

The two subscriptions are assumed to have equal capacity, so the pool
percentage is the arithmetic mean of their remaining percentages. Individual
reset times are available through:

```text
/cliproxy:quota
/statuses
```

The footer is cleared immediately when another provider is selected. Quota is
refreshed once per minute only while a `cliproxy` model is active.

The extension does not track which subscription served an individual request.
This avoids running journal queries after provider responses when routing is
not session-affine.

The footer includes `next`, the time until the nearest future quota reset among
all available subscriptions and windows.

Configuration:

```sh
export CLIPROXY_MANAGEMENT_URL="http://127.0.0.1:8317"
export CLIPROXY_MANAGEMENT_KEY=""
```

`CLIPROXY_MANAGEMENT_KEY` must contain the original plaintext management key,
not the bcrypt hash stored in CLIProxyAPI's `config.yaml`.

Persistent management settings are read from `~/.pi/agent/secrets/cliproxy-management.json`
with string fields `managementUrl` and `managementKey`. Keep this file mode `0600`.
When present, this file takes precedence over the environment. Without the file,
the extension uses `CLIPROXY_MANAGEMENT_URL` and `CLIPROXY_MANAGEMENT_KEY`.
The local persistent SSH tunnel exposes the remote server on port `8319`.
