#!/bin/bash
# PR Drain: GitHub close commands for invalid/duplicate PRs
# Run these to finalize triage Phase 2 (close duplicates/self-tests)
# Timestamp: 2026-08-05

# Verify repo before running
if ! gh repo view Mumega-com/mupot >/dev/null 2>&1; then
  echo "Error: Not in Mumega-com/mupot repo"
  exit 1
fi

echo "PR Drain Phase 2: Close duplicate/self-test PRs"
echo "================================================"

# SELF-TEST PRs (close both, they are validation-only)
echo ""
echo "Closing SELFTEST PRs..."
gh pr close 661 --comment "Closing SELFTEST PR. The security-sweep board reporting is now handled by PR #655 (production implementation)." || true
gh pr close 660 --comment "Closing SELFTEST PR duplicate. See PR #661 and PR #655 for the actual security-sweep implementation." || true

# DUPLICATE DOCS (keep #653, close #654 — check dates to confirm which is newer)
echo ""
echo "Closing duplicate docs PR..."
# Note: both created same time, but if one has more recent work, keep that one
# For now, close #654 per triage (could swap if needed)
gh pr close 654 --comment "Duplicate of PR #653. Both are '[DOCS] Write docs/operations/loop-runbook.md'. Consolidated to PR #653." || true

echo ""
echo "Phase 2 complete. Re-run 'gh pr list --state open' to verify count dropped to ~52."
