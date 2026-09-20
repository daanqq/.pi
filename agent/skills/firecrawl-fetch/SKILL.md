---
name: firecrawl-fetch
description: Fetches a specific public URL through Firecrawl as readable Markdown. Use when you need web page retrieval. Do not use for authenticated, private, or internal URLs.
---

# Firecrawl Fetch

Run from this skill directory:

```bash
node fetch.mjs "<https-url>"
```

The command requires `FIRECRAWL_API_KEY`. If the output is truncated, read the task-owned temporary file named by the command only when more content is needed.
