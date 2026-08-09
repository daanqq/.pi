# CLIProxyAPI quota footer

Shows the combined remaining Codex quota for enabled accounts from
`~/.cli-proxy-api` while the selected Pi model uses provider `cliproxy`.

The two subscriptions are assumed to have equal capacity, so the pool
percentage is the arithmetic mean of their remaining percentages. Individual
reset times are available through:

```text
/cliproxy:quota
/statuses
```

The footer is cleared immediately when another provider is selected. Quota is
refreshed once per minute only while a `cliproxy` model is active.

The footer includes `cur`, the weakest remaining quota window of the OAuth
subscription selected for the current model/session binding. The extension
correlates `X-CPA-TRACE-ID` with the CLIProxyAPI systemd journal. Before the
first provider response, or when journald is unavailable, it displays `cur:?`.

Set `CLIPROXY_AUTH_DIR` to override the default auth directory.
