#!/usr/bin/env python3

import argparse
import json
import subprocess
import sys
from typing import Any
from urllib.parse import quote, urlparse


def glab_api(host: str, endpoint: str) -> Any:
    result = subprocess.run(
        ["glab", "api", "--hostname", host, endpoint],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode:
        print(result.stderr.strip() or "glab api failed", file=sys.stderr)
        raise SystemExit(result.returncode)

    return json.loads(result.stdout)


def parse_mr_url(url: str) -> tuple[str, str, int]:
    parsed = urlparse(url)
    marker = "/-/merge_requests/"
    if parsed.scheme not in {"http", "https"} or marker not in parsed.path:
        raise SystemExit("Expected a GitLab merge request URL")

    project_path, iid_part = parsed.path.strip("/").split(marker, 1)
    try:
        iid = int(iid_part.split("/", 1)[0])
    except ValueError as error:
        raise SystemExit("Merge request IID is not a number") from error

    return parsed.hostname or "", project_path, iid


def fetch_discussions(host: str, project_id: str, iid: int) -> list[dict[str, Any]]:
    discussions: list[dict[str, Any]] = []
    page = 1

    while True:
        batch = glab_api(
            host,
            f"projects/{project_id}/merge_requests/{iid}/discussions"
            f"?per_page=100&page={page}",
        )
        discussions.extend(batch)
        if len(batch) < 100:
            return discussions
        page += 1


def is_resolved(notes: list[dict[str, Any]]) -> bool:
    resolvable = [note for note in notes if note.get("resolvable")]
    return bool(resolvable) and all(note.get("resolved") for note in resolvable)


def normalize_discussion(
    discussion: dict[str, Any], mr_url: str
) -> dict[str, Any] | None:
    notes = [note for note in discussion.get("notes", []) if not note.get("system")]
    if not notes or is_resolved(notes):
        return None

    root = notes[0]
    position = root.get("position") or {}
    path = position.get("new_path") or position.get("old_path")
    line = position.get("new_line") or position.get("old_line")

    return {
        "discussion_id": discussion.get("id"),
        "individual_note": discussion.get("individual_note", False),
        "path": path,
        "line": line,
        "note_url": f"{mr_url}#note_{root.get('id')}",
        "notes": [
            {
                "id": note.get("id"),
                "author": (note.get("author") or {}).get("username"),
                "body": note.get("body", ""),
                "created_at": note.get("created_at"),
            }
            for note in notes
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Fetch GitLab MR metadata and unresolved review discussions"
    )
    parser.add_argument("mr_url")
    args = parser.parse_args()

    host, project_path, iid = parse_mr_url(args.mr_url)
    project_id = quote(project_path, safe="")
    mr = glab_api(host, f"projects/{project_id}/merge_requests/{iid}")
    discussions = fetch_discussions(host, project_id, iid)

    unresolved = []
    for discussion in discussions:
        normalized = normalize_discussion(discussion, mr["web_url"])
        if normalized:
            unresolved.append(normalized)

    output = {
        "host": host,
        "project_path": project_path,
        "repo_name": project_path.rsplit("/", 1)[-1],
        "iid": iid,
        "title": mr.get("title"),
        "state": mr.get("state"),
        "source_branch": mr.get("source_branch"),
        "target_branch": mr.get("target_branch"),
        "web_url": mr.get("web_url"),
        "sha": mr.get("sha"),
        "diff_refs": mr.get("diff_refs"),
        "unresolved_discussions": unresolved,
    }
    json.dump(output, sys.stdout, ensure_ascii=False, indent=2)
    print()


if __name__ == "__main__":
    main()
