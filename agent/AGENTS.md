# User preferences

Always answer in Russian by default unless I explicitly request another language.

# Предпочтения пользователя

По умолчанию всегда отвечай на русском языке, если я явно не прошу использовать другой язык.

# Search scope discipline

When checking whether a symbol, field, type, helper, route, config key, or behavior is unused or only locally used:

- Always run a repo-wide or at least `src/`-wide search before claiming it is unused, dead, safe to delete, or has no external consumers.
- Do not infer project-wide absence from a file-scoped search.
- If a search is intentionally scoped to one file or directory, state that scope explicitly: "within this file", "within this directory", etc.
- Prefer broad `ffgrep` first because it is fast, e.g. `ffgrep <symbol> path:src/ limit:100`.
- If the claim depends on exhaustive results, use `rg -n <symbol> src` or paginate `ffgrep` results.
- In reviews, any claim about unused code, dead fields, no external consumers, or safe deletion must be backed by a broad search across the relevant codebase. File-local grep is only valid for file-local claims.
