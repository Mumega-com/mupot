#!/usr/bin/env python3
"""Disk Roster & Token Janitor Sweep (WU-3 / Issue #824)

Sweeps ~/.fleet/agents/ to archive stale test tokens, orphaned trial tokens,
and unattached credentials into ~/.fleet/agents/archive/, ensuring disk token hygiene.
"""

from __future__ import annotations

import os
import shutil
import time
from pathlib import Path

AGENT_DIR = Path("~/.fleet/agents").expanduser()
ARCHIVE_DIR = AGENT_DIR / "archive"

# Active 5-Agent Council + Core Infrastructure tokens
ACTIVE_TOKENS = {
    "asha-agent.token",
    "kasra-agent.token",
    "athena-agent.token",
    "river-agent.token",
    "loom-agent.token",
    "athena-sos.token"
}

def clean_roster() -> dict:
    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    results = {"timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "archived": [], "retained": []}

    if not AGENT_DIR.is_dir():
        print(f"[janitor] Directory {AGENT_DIR} not found.")
        return results

    for path in AGENT_DIR.iterdir():
        if path.is_file():
            filename = path.name
            if filename in ACTIVE_TOKENS:
                results["retained"].append(filename)
            else:
                dest = ARCHIVE_DIR / filename
                shutil.move(str(path), str(dest))
                results["archived"].append(filename)

    return results

def main() -> int:
    print("[janitor] Running Disk Roster Hygiene Sweep...")
    res = clean_roster()
    print(f"[janitor] Retained {len(res['retained'])} active council tokens: {res['retained']}")
    print(f"[janitor] Archived {len(res['archived'])} stale/test tokens: {res['archived']}")
    return 0

if __name__ == "__main__":
    main()
