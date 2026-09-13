---
name: web-search
description: "Runs a concise internet search through OpenAI Codex native web search. Use when current or external information is needed: web research, documentation lookup, checking latest versions, verifying facts, or finding online sources."
---

# Native Web Search

Use this skill when current information from the internet is needed.
Run multiple parallel searches if needed.

Run it from the current skill directory:

```bash
node search.mjs "<query>"
```

Additional options:
- `--purpose "<why you need this>"` - default `general research support` - explain
  how the research will be used.
- `--model <model-id>` - default `gpt-5.6-luna` - override the model, only when
  user explicitly asks.
- `--timeout <milliseconds>` - default `120000ms` - set the maximum request time.
- `--json` - return a JSON object containing the provider, model, query, purpose,
  and search result.

Examples:

```bash
node search.mjs "latest Python release" --purpose "update dependency notes"
node search.mjs "Vite 7 breaking changes" --json
```

Search runs exclusively through the `openai-codex` provider.
It uses native web search and returns a concise research summary
with 3–7 key findings, full canonical source URLs, noted
disagreements between sources, and a short recommendation.

The request is routed through CLIProxyAPI. Set `CLIPROXY_API_KEY` to the
CLIProxy API key; the default endpoint is
`http://127.0.0.1:8317/backend-api`. Override it with `CLIPROXY_BASE_URL` when
the proxy uses another address.
