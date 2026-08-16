"""Resolve and download model weights from the Hugging Face Hub.

The repo ids in config/models.yaml are candidates, not verified facts, so this
module never assumes one exists. It probes each candidate, falls back to
discovering repos under the configured org, prints the real remote file tree,
and only then downloads. `--list` stops after the tree so you can confirm what
you are about to pull before spending an hour on it.
"""

from __future__ import annotations

import argparse
import fnmatch
import os
import re
import sys
from dataclasses import dataclass, field
from typing import Any

import requests
import yaml

HF_API = "https://huggingface.co/api"
TIMEOUT = 30


def _headers() -> dict[str, str]:
    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    return {"Authorization": f"Bearer {token}"} if token else {}


@dataclass
class RepoSpec:
    """One resolved download unit."""

    repo_id: str
    target: str
    include: list[str] = field(default_factory=list)
    exclude: list[str] = field(default_factory=list)
    optional: bool = False


class ResolutionError(RuntimeError):
    pass


def repo_exists(repo_id: str) -> dict[str, Any] | None:
    """Return repo metadata, or None if it is absent/inaccessible."""
    try:
        resp = requests.get(f"{HF_API}/models/{repo_id}", headers=_headers(), timeout=TIMEOUT)
    except requests.RequestException as exc:
        raise ResolutionError(f"network error talking to HF: {exc}") from exc
    if resp.status_code == 200:
        return resp.json()
    if resp.status_code in (401, 403):
        print(
            f"  ! {repo_id} exists but is gated/private ({resp.status_code}). "
            "Accept its licence on the model page and set HF_TOKEN.",
            file=sys.stderr,
        )
        return None
    return None


def discover(author: str, pattern: str, prefer_order: list[str]) -> list[str]:
    """List repos under `author` matching `pattern`, best candidate first."""
    try:
        resp = requests.get(
            f"{HF_API}/models",
            params={"author": author, "limit": 200, "full": "false", "sort": "lastModified", "direction": -1},
            headers=_headers(),
            timeout=TIMEOUT,
        )
        resp.raise_for_status()
    except requests.RequestException as exc:
        raise ResolutionError(f"could not list repos for org '{author}': {exc}") from exc

    rx = re.compile(pattern)
    matches = [m["id"] for m in resp.json() if rx.match(m["id"])]

    def rank(repo_id: str) -> tuple[int, str]:
        for i, pref in enumerate(prefer_order or []):
            if re.search(pref, repo_id):
                return (i, repo_id)
        return (len(prefer_order or []), repo_id)

    return sorted(matches, key=rank)


def resolve_repo(name: str, spec: dict[str, Any]) -> str:
    """Pick the repo id to actually use for a family."""
    for cand in spec.get("candidates", []):
        print(f"  probing {cand} ...", end=" ", flush=True)
        if repo_exists(cand):
            print("found")
            return cand
        print("no")

    author = spec.get("author")
    pattern = spec.get("discover")
    if author and pattern:
        print(f"  no candidate resolved; discovering under org '{author}'")
        found = discover(author, pattern, spec.get("prefer_order", []))
        if found:
            print("  candidates discovered: " + ", ".join(found[:10]))
            return found[0]

    raise ResolutionError(
        f"could not resolve a repo for family '{name}'.\n"
        f"    Tried candidates: {spec.get('candidates', [])}\n"
        f"    Browse https://huggingface.co/{author} and put the correct id in "
        f"config/models.yaml under families.{name}.candidates"
    )


def list_files(repo_id: str) -> list[tuple[str, int]]:
    """Remote file tree as (path, size_bytes)."""
    out: list[tuple[str, int]] = []
    try:
        resp = requests.get(
            f"{HF_API}/models/{repo_id}/tree/main",
            params={"recursive": "true"},
            headers=_headers(),
            timeout=TIMEOUT,
        )
        resp.raise_for_status()
    except requests.RequestException as exc:
        raise ResolutionError(f"could not list files in {repo_id}: {exc}") from exc

    for entry in resp.json():
        if entry.get("type") != "file":
            continue
        size = entry.get("size") or (entry.get("lfs") or {}).get("size") or 0
        out.append((entry["path"], size))
    return sorted(out)


def select(files: list[tuple[str, int]], include: list[str], exclude: list[str]) -> list[tuple[str, int]]:
    def matches(path: str, pats: list[str]) -> bool:
        name = path.rsplit("/", 1)[-1]
        return any(fnmatch.fnmatch(path, p) or fnmatch.fnmatch(name, p) for p in pats)

    picked = [f for f in files if (not include or matches(f[0], include))]
    if exclude:
        picked = [f for f in picked if not matches(f[0], exclude)]
    return picked


def human(n: int) -> str:
    x = float(n)
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if x < 1024 or unit == "TiB":
            return f"{x:.1f}{unit}"
        x /= 1024
    return f"{x:.1f}TiB"


def free_bytes(path: str) -> int:
    st = os.statvfs(path)
    return st.f_bavail * st.f_frsize


def download(spec: RepoSpec, dest_root: str) -> str:
    from huggingface_hub import snapshot_download

    local_dir = os.path.join(dest_root, spec.target)
    os.makedirs(local_dir, exist_ok=True)
    print(f"  downloading {spec.repo_id} -> {local_dir}")
    return snapshot_download(
        repo_id=spec.repo_id,
        local_dir=local_dir,
        allow_patterns=spec.include or None,
        ignore_patterns=spec.exclude or None,
        max_workers=8,
        token=os.environ.get("HF_TOKEN") or None,
    )


def plan_family(name: str, spec: dict[str, Any]) -> list[tuple[RepoSpec, list[tuple[str, int]]]]:
    """Resolve a family (and its companions) into concrete download units."""
    print(f"\n=== {name}: {spec.get('label', name)}")
    plans: list[tuple[RepoSpec, list[tuple[str, int]]]] = []

    repo_id = resolve_repo(name, spec)
    units = [
        RepoSpec(
            repo_id=repo_id,
            target=spec["target"],
            include=spec.get("include", []),
            exclude=spec.get("exclude", []),
            optional=bool(spec.get("optional")),
        )
    ]
    for comp in spec.get("companions", []):
        if repo_exists(comp["repo"]):
            units.append(
                RepoSpec(
                    repo_id=comp["repo"],
                    target=comp["target"],
                    include=comp.get("include", []),
                    exclude=comp.get("exclude", []),
                    optional=bool(comp.get("optional")),
                )
            )
        elif not comp.get("optional"):
            raise ResolutionError(f"required companion {comp['repo']} not reachable")
        else:
            print(f"  skipping optional companion {comp['repo']} (not reachable)")

    for unit in units:
        files = list_files(unit.repo_id)
        picked = select(files, unit.include, unit.exclude)
        total = sum(s for _, s in picked)
        print(f"\n  {unit.repo_id}  ({len(files)} files remote, {len(picked)} selected, {human(total)})")
        for path, size in picked:
            print(f"    {human(size):>10}  {path}")
        if len(files) > len(picked):
            print(f"    ... {len(files) - len(picked)} file(s) filtered out by include/exclude")
        plans.append((unit, picked))

    return plans


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--config", required=True)
    ap.add_argument("--dest", required=True)
    ap.add_argument("--model", required=True, help="family name from models.yaml, or 'all'")
    ap.add_argument("--list", action="store_true", help="resolve and print the plan, download nothing")
    args = ap.parse_args(argv)

    with open(args.config) as fh:
        cfg = yaml.safe_load(fh)
    families: dict[str, Any] = cfg["families"]

    if args.model == "all":
        names = list(families)
    elif args.model in families:
        names = [args.model]
    else:
        print(f"unknown model '{args.model}'. Known: {', '.join(families)}", file=sys.stderr)
        return 2

    os.makedirs(args.dest, exist_ok=True)
    all_plans: list[tuple[RepoSpec, list[tuple[str, int]]]] = []
    failures: list[str] = []

    for name in names:
        try:
            all_plans.extend(plan_family(name, families[name]))
        except ResolutionError as exc:
            if families[name].get("optional"):
                print(f"  skipping optional family '{name}': {exc}", file=sys.stderr)
            else:
                failures.append(f"{name}: {exc}")

    grand_total = sum(sum(s for _, s in files) for _, files in all_plans)
    avail = free_bytes(args.dest)
    print(f"\n--- total to download: {human(grand_total)}; free at {args.dest}: {human(avail)}")
    # Snapshot downloads stage into the HF cache before linking, so headroom
    # beyond the raw payload matters.
    if grand_total and avail < grand_total * 1.15:
        print(
            "  ! not enough headroom (need ~15% over the payload for cache staging). "
            "Point B200_WORKDIR/HF_HOME at a larger volume.",
            file=sys.stderr,
        )
        if not args.list:
            failures.append("insufficient disk space")

    if failures:
        print("\nFAILED:", file=sys.stderr)
        for f in failures:
            print(f"  - {f}", file=sys.stderr)
        return 1

    if args.list:
        print("\n(--list: nothing downloaded)")
        return 0

    for unit, _files in all_plans:
        try:
            path = download(unit, args.dest)
            print(f"  done: {path}")
        except Exception as exc:  # noqa: BLE001 — one bad repo must not abort the rest
            msg = f"{unit.repo_id}: {exc}"
            if unit.optional:
                print(f"  optional download failed, continuing: {msg}", file=sys.stderr)
            else:
                failures.append(msg)

    if failures:
        print("\nFAILED:", file=sys.stderr)
        for f in failures:
            print(f"  - {f}", file=sys.stderr)
        return 1

    print("\nall downloads complete")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
