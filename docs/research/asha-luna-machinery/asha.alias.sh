#!/bin/sh
# asha — alias launcher for the asha Hermes profile (CANDIDATE template — not installed).
#
# Install target at promotion-time: /home/mumega/.local/bin/asha  (chmod 755)
#
# WHY THIS EXISTS (the routing defect):
#   The retired asha-responder.service set RESPONDER_BIN=hermes with NO profile
#   flag. prime-responder.py's hermes argv branch (_argv, line ~469) builds
#   [RESPONDER_BIN, "--in", WORKDIR, "-z", prompt] — hermes has no -p/--mode
#   top-level options, so the responder launched the DEFAULT profile with Asha's
#   prompt. This alias pins the profile: with RESPONDER_BIN=<this alias> and
#   RESPONDER_FLAVOR=hermes, the same branch now runs the RIGHT profile.
#
# Mirrors the proven prime-opencode launcher pattern
# (/home/mumega/.local/bin/prime-opencode).
exec /home/mumega/.hermes/hermes-agent/venv/bin/hermes -p asha "$@"