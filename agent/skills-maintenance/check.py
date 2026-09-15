#!/usr/bin/env python3
"""Validate the installed skill inventory and its locked upstream sources."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import stat
import subprocess
import sys
import tarfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MAINTENANCE = Path(__file__).resolve().parent
MANIFEST = MAINTENANCE / "manifest.json"
SKILLS = ROOT / "agent" / "skills"
NAME_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
MARKDOWN_LINK_RE = re.compile(r"\[[^\]]*\]\(([^)]+)\)")


def entries_hash(entries: list[tuple[str, str, int, bytes]]) -> str:
    digest = hashlib.sha256()
    for path, kind, mode, payload in sorted(entries):
        digest.update(path.encode())
        digest.update(b"\0")
        digest.update(kind.encode())
        digest.update(b"\0")
        digest.update(f"{mode:o}".encode())
        digest.update(b"\0")
        digest.update(payload)
        digest.update(b"\0")
    return digest.hexdigest()


def directory_hash(root: Path) -> str:
    entries: list[tuple[str, str, int, bytes]] = []
    for path in sorted(root.rglob("*")):
        if path.is_dir() or "__pycache__" in path.parts:
            continue
        relative = path.relative_to(root).as_posix()
        mode = stat.S_IMODE(path.lstat().st_mode)
        if path.is_symlink():
            entries.append((relative, "link", mode, os.readlink(path).encode()))
        else:
            entries.append((relative, "file", mode, path.read_bytes()))
    return entries_hash(entries)


def archive_hash(repo: Path, revision: str, source_path: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), "archive", "--format=tar", revision, source_path],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    prefix = source_path.rstrip("/") + "/"
    entries: list[tuple[str, str, int, bytes]] = []
    with tarfile.open(fileobj=io.BytesIO(result.stdout), mode="r:") as archive:
        for member in archive.getmembers():
            if member.isdir() or not member.name.startswith(prefix):
                continue
            relative = member.name[len(prefix) :]
            if not relative:
                continue
            if member.issym():
                entries.append((relative, "link", member.mode, member.linkname.encode()))
            elif member.isfile():
                extracted = archive.extractfile(member)
                assert extracted is not None
                entries.append((relative, "file", member.mode, extracted.read()))
    return entries_hash(entries)


def frontmatter(skill_file: Path) -> dict[str, str]:
    text = skill_file.read_text(encoding="utf-8")
    if not text.startswith("---\n"):
        return {}
    end = text.find("\n---\n", 4)
    if end < 0:
        return {}
    fields: dict[str, str] = {}
    for line in text[4:end].splitlines():
        match = re.match(r"^([a-z][a-z0-9-]*):\s*(.*?)\s*$", line)
        if not match:
            continue
        value = match.group(2)
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        fields[match.group(1)] = value
    return fields


def missing_relative_links(skill_dir: Path) -> list[tuple[Path, str]]:
    missing: list[tuple[Path, str]] = []
    for markdown in skill_dir.rglob("*.md"):
        for raw_target in MARKDOWN_LINK_RE.findall(markdown.read_text(encoding="utf-8")):
            target = raw_target.split("#", 1)[0].strip()
            if (
                not target
                or "://" in target
                or target.startswith(("mailto:", "<"))
                or any(character in target for character in "{}*")
            ):
                continue
            resolved = (markdown.parent / target.replace("%20", " ")).resolve()
            if not resolved.exists():
                missing.append((markdown, target))
    return missing


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check-sources", action="store_true")
    parser.add_argument("--refresh-installed-hashes", action="store_true")
    args = parser.parse_args()

    data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    repositories = data.get("repositories", {})
    declared = data.get("skills", {})
    actual = {path.name for path in SKILLS.iterdir() if (path / "SKILL.md").is_file()}
    errors: list[str] = []

    if set(declared) != actual:
        missing = sorted(actual - set(declared))
        stale = sorted(set(declared) - actual)
        if missing:
            errors.append(f"skills missing from manifest: {', '.join(missing)}")
        if stale:
            errors.append(f"manifest entries without installed skills: {', '.join(stale)}")

    for name, skill in declared.items():
        skill_dir = SKILLS / name
        skill_file = skill_dir / "SKILL.md"
        if not skill_file.is_file():
            continue
        fields = frontmatter(skill_file)
        declared_name = fields.get("name")
        if declared_name != name:
            errors.append(f"{name}: frontmatter name is {declared_name!r}")
        if not NAME_RE.fullmatch(name) or len(name) > 64:
            errors.append(f"{name}: invalid Agent Skills name")
        description = fields.get("description", "")
        if not description:
            errors.append(f"{name}: missing frontmatter description")
        elif len(description) > 1024:
            errors.append(f"{name}: description exceeds 1024 characters")
        compatibility = fields.get("compatibility")
        if compatibility and len(compatibility) > 500:
            errors.append(f"{name}: compatibility exceeds 500 characters")
        for markdown, target in missing_relative_links(skill_dir):
            relative_markdown = markdown.relative_to(ROOT)
            errors.append(f"{name}: broken link {target!r} in {relative_markdown}")

        tracking = skill.get("tracking")
        if tracking not in {"local", "exact", "overlay"}:
            errors.append(f"{name}: invalid tracking mode {tracking!r}")
            continue
        if tracking == "local":
            if any(key in skill for key in ("repository", "path", "overlay")):
                errors.append(f"{name}: local skill must not declare upstream fields")
        else:
            repository_name = skill.get("repository")
            source_path = skill.get("path")
            if repository_name not in repositories or not source_path:
                errors.append(f"{name}: incomplete upstream declaration")
                continue
            if tracking == "overlay":
                overlay = skill.get("overlay")
                if not overlay or not (MAINTENANCE / overlay).is_file():
                    errors.append(f"{name}: missing semantic overlay")
            elif "overlay" in skill:
                errors.append(f"{name}: exact skill must not declare an overlay")

        installed_hash = directory_hash(skill_dir)
        recorded_hash = skill.get("installed_hash")
        if args.refresh_installed_hashes:
            skill["installed_hash"] = installed_hash
        elif recorded_hash != installed_hash:
            errors.append(f"{name}: installed hash drift ({installed_hash})")

        if args.check_sources and tracking in {"exact", "overlay"}:
            repository = repositories[skill["repository"]]
            repo = Path.home() / ".cache" / "checkouts" / repository["cache"]
            revision = repository["revision"]
            if not (repo / ".git").exists():
                errors.append(f"{name}: missing cached repository {repo}")
                continue
            try:
                source_hash = archive_hash(repo, revision, skill["path"])
            except subprocess.CalledProcessError as error:
                detail = error.stderr.decode(errors="replace").strip()
                errors.append(f"{name}: cannot read locked source: {detail}")
                continue
            if tracking == "exact" and source_hash != installed_hash:
                errors.append(f"{name}: exact copy differs from locked upstream")

    if args.refresh_installed_hashes:
        MANIFEST.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    if errors:
        print("Skill maintenance check failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print(f"Skill maintenance check passed for {len(declared)} skills.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
