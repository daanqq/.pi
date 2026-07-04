# User preferences

Always answer in Russian by default unless I explicitly request another language.

# Skill preferences

For code changes, use the `coding-discipline` skill.

# Tool usage preferences

- `ffgrep`/`fffind` path constraints must be relative to the current workspace. Do not pass absolute paths to these tools.
- For files outside the workspace, use `read` for inspection or `bash` with tools like `rg`/`grep` instead of `ffgrep`/`fffind`.
- When using `ffgrep` with regex alternation, pass the pattern without slash delimiters, e.g. `foo|bar`, not `/foo|bar/`.
