#!/usr/bin/env python3
"""Hermetic proof that the caged lane cannot exfiltrate host files via symlink.

Reproduces codex's P0 on PR #645: the model owns the cage, the driver is
trusted and holds every repo credential. If the model writes
`.lane-summary.md` as a symlink to a host secret, `rsync -a` recreates the
*link*, the driver reads it as the commit body, and pushes the secret.

Nothing here touches the network, sudo, git remotes, or a real secret — the
"secret" is a temp file with a sentinel string, and we assert that string
never reaches the commit body.

Run: python3 scripts/checks/cage-symlink-exfil-check.py
"""
from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
from pathlib import Path

SENTINEL = "SENTINEL-HOST-SECRET-b7f3e91a-DO-NOT-LEAK"

REPO = Path(__file__).resolve().parents[2]
WORKER = REPO / "scripts" / "codex-worker.py"


def load_worker():
    """Import codex-worker.py by path (hyphenated name, not importable)."""
    spec = importlib.util.spec_from_file_location("codex_worker", WORKER)
    mod = importlib.util.module_from_spec(spec)
    os.environ.setdefault("CODEX_AGENT_ID", "test")
    spec.loader.exec_module(mod)
    return mod


def case_summary_symlink_is_refused(w) -> None:
    """The exact P0: .lane-summary.md -> host secret must not be readable."""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        secret = tmp / "host-secret.token"
        secret.write_text(SENTINEL)

        worktree = tmp / "worktree"
        worktree.mkdir()
        (worktree / ".lane-summary.md").symlink_to(secret)

        try:
            got = w._read_summary(worktree / ".lane-summary.md")
        except w.HostileCageOutput:
            return  # refused — correct
        if SENTINEL in got:
            raise AssertionError(
                "EXFIL: _read_summary followed the symlink and returned the host "
                "secret — this content would land in a pushed commit body"
            )
        raise AssertionError(
            f"expected HostileCageOutput, got a silent read of {got!r}"
        )


def case_guard_rejects_symlink(w) -> None:
    """_reject_symlinks must catch the link before any read happens."""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        secret = tmp / "host-secret.token"
        secret.write_text(SENTINEL)
        worktree = tmp / "worktree"
        (worktree / "nested").mkdir(parents=True)
        (worktree / "nested" / "innocent.ts").symlink_to(secret)

        try:
            w._reject_symlinks(worktree)
        except w.HostileCageOutput:
            return
        raise AssertionError("_reject_symlinks did not reject a nested symlink")


def case_normal_summary_still_works(w) -> None:
    """The fix must not cripple the lane: a real summary reads normally."""
    with tempfile.TemporaryDirectory() as td:
        worktree = Path(td)
        (worktree / ".lane-summary.md").write_text("Fixed the parser.\n")
        got = w._read_summary(worktree / ".lane-summary.md")
        if got != "Fixed the parser.":
            raise AssertionError(f"regular summary broke: {got!r}")
        w._reject_symlinks(worktree)  # must not raise


def case_missing_summary_is_empty(w) -> None:
    """No summary is a normal outcome, not an error."""
    with tempfile.TemporaryDirectory() as td:
        got = w._read_summary(Path(td) / ".lane-summary.md")
        if got != "":
            raise AssertionError(f"expected '' for missing summary, got {got!r}")


def case_node_modules_link_allowed(w) -> None:
    """The driver's own node_modules link must survive the guard."""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        deps = tmp / "deps"
        deps.mkdir()
        worktree = tmp / "worktree"
        worktree.mkdir()
        (worktree / "node_modules").symlink_to(deps)
        w._reject_symlinks(worktree)  # must not raise


def case_secret_never_reaches_commit_body(w) -> None:
    """PROPERTY test — the one that must fail on vulnerable code.

    The cases above name helpers this fix introduced, so against the pre-fix
    worker they fail with AttributeError: they pin the mechanism, not the
    property, and a mechanism-pinned test defends the defect it was written
    for. This case names nothing version-specific. It drives the real
    delivery path (verify -> git commit) over a hostile worktree and asserts
    the only thing that actually matters: the host secret does not reach the
    commit body that would be pushed.
    """
    import subprocess as sp

    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        secret = tmp / "host-secret.token"
        secret.write_text(SENTINEL)

        worktree = tmp / "repo"
        worktree.mkdir()
        env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
               "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}
        sp.run(["git", "init", "-q", "-b", "main"], cwd=worktree, check=True, env=env)
        (worktree / "seed.txt").write_text("seed\n")
        sp.run(["git", "add", "-A"], cwd=worktree, check=True, env=env)
        sp.run(["git", "commit", "-qm", "seed"], cwd=worktree, check=True, env=env)

        # The attack: model authors the summary as a link to a host secret,
        # plus a real edit so there is something to commit.
        (worktree / "edited.txt").write_text("model edit\n")
        (worktree / ".lane-summary.md").symlink_to(secret)

        w.REPO = worktree
        try:
            w.verify(worktree, "main")
        except Exception:
            pass  # refusing is a valid outcome; the assertion below is the test

        log_out = sp.run(["git", "log", "--format=%B", "-20"], cwd=worktree,
                         capture_output=True, text=True, env=env).stdout
        if SENTINEL in log_out:
            raise AssertionError(
                "EXFIL CONFIRMED: host secret reached the commit body via "
                ".lane-summary.md symlink — this is what gets pushed"
            )


CASES = [
    case_secret_never_reaches_commit_body,
    case_summary_symlink_is_refused,
    case_guard_rejects_symlink,
    case_normal_summary_still_works,
    case_missing_summary_is_empty,
    case_node_modules_link_allowed,
]


def main() -> int:
    worker = load_worker()
    failures = []
    for case in CASES:
        try:
            case(worker)
            print(f"  PASS  {case.__name__}")
        except Exception as exc:  # noqa: BLE001 - report every failure
            failures.append((case.__name__, exc))
            print(f"  FAIL  {case.__name__}: {exc}")
    if failures:
        print(f"\n{len(failures)}/{len(CASES)} cage-symlink checks FAILED")
        return 1
    print(f"\nall {len(CASES)} cage-symlink checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
