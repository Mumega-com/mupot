#!/usr/bin/env python3
"""Run one bounded Hermes query received on stdin without exposing it in argv."""

from __future__ import annotations

import os
import sys


MAX_PROMPT_BYTES = 320 * 1024


def main() -> int:
    payload = sys.stdin.buffer.read(MAX_PROMPT_BYTES + 1)
    if not payload or len(payload) > MAX_PROMPT_BYTES:
        return 2
    try:
        prompt = payload.decode("utf-8")
    except UnicodeDecodeError:
        return 2
    os.environ["HERMES_SESSION_SOURCE"] = "mupot-agent-host"
    sys.path.insert(0, "/opt/hermes")
    from cli import main as hermes_main

    hermes_main(
        query=prompt,
        toolsets="mupot-operator",
        max_turns=6,
        quiet=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
