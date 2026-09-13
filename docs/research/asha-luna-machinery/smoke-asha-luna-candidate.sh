#!/usr/bin/env bash
# =============================================================================
# smoke-asha-luna-candidate.sh — deterministic smoke for the Asha-Luna machinery
# candidate (task t_bc14f72c). READ-ONLY: no activation, no network, no model
# calls, no state changes. Exit 0 == every check PASS.
#
#   smoke-asha-luna-candidate.sh [--mode=baseline|promotion-ready]
#
#   baseline        (default) proves the candidate templates resolve to the EXACT
#                   profile (asha) + model route (gpt-5.6-luna / opencode-go),
#                   and that NOTHING has been activated since the candidate was
#                   authored (fingerprints + absence checks).
#   promotion-ready proves the INSTALLED artifacts (profile, alias, unit drop-in)
#                   match the templates exactly. For use AFTER the activation
#                   gates have fired — still read-only.
#
# Fork-proofing: the model route is fork-configurable. Override to assert a
# different expected route:
#   ASHA_SMOKE_EXPECT_MODEL=<model> ASHA_SMOKE_EXPECT_PROVIDER=<provider> \
#     smoke-asha-luna-candidate.sh
#
# Test roots (defaults are the LIVE fleet host paths — NOT $HOME, which on this
# host is a profile home): SMOKE_HERMES_PROFILES_DIR, SMOKE_FLEET_ROOT,
# SMOKE_BIN_DIR, SMOKE_SYSTEMD_UNIT_DIR, SMOKE_SYSTEMD_DROPIN.
# =============================================================================
set -u

MODE="${1:-baseline}"
MODE="${MODE#--mode=}"
case "$MODE" in
  baseline) ;;
  promotion-ready) ;;
  *) echo "usage: $(basename "$0") [--mode=baseline|promotion-ready]" >&2; exit 2 ;;
esac

BUNDLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SMOKE_HERMES_PROFILES_DIR="${SMOKE_HERMES_PROFILES_DIR:-/home/mumega/.hermes/profiles}"
SMOKE_FLEET_ROOT="${SMOKE_FLEET_ROOT:-/home/mumega/.fleet}"
SMOKE_BIN_DIR="${SMOKE_BIN_DIR:-/home/mumega/.local/bin}"
SMOKE_SYSTEMD_UNIT_DIR="${SMOKE_SYSTEMD_UNIT_DIR:-/etc/systemd/system}"
SMOKE_SYSTEMD_DROPIN="${SMOKE_SYSTEMD_DROPIN:-/etc/systemd/system/asha-responder.service.d/override.conf}"

EXPECT_MODEL="${ASHA_SMOKE_EXPECT_MODEL:-gpt-5.6-luna}"
EXPECT_PROVIDER="${ASHA_SMOKE_EXPECT_PROVIDER:-opencode-go}"
EXPECT_BASE_URL="https://opencode.ai/zen/go/v1"
EXPECT_API_MODE="codex_responses"
EXPECT_AGENT_ID="e211b0fb-6ebf-4aab-bac5-6129ce6075e0"

CFG="$BUNDLE_DIR/config.asha.yaml"
SOUL="$BUNDLE_DIR/SOUL.asha.md"
ALIAS_TPL="$BUNDLE_DIR/asha.alias.sh"
DROPIN_TPL="$BUNDLE_DIR/asha-responder.service.drop-in"
PINS="$BUNDLE_DIR/hashes.pins"

PROFILE_DIR="$SMOKE_HERMES_PROFILES_DIR/asha"
ALIAS_FILE="$SMOKE_BIN_DIR/asha"
TOKEN_FILE="$SMOKE_FLEET_ROOT/agents/asha-agent-bound.token"
AGENT_SPOOL="$SMOKE_FLEET_ROOT/inbox-spool/$EXPECT_AGENT_ID"

PASS=0; FAIL=0; SKIP=0
ok()   { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$1"; }
skip() { SKIP=$((SKIP+1)); printf 'SKIP  %s\n' "$1"; }
check() { # check <label> <cmd...>
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then ok "$label"; else bad "$label"; fi
}

echo "== mode: $MODE  profile: asha  model: $EXPECT_MODEL  provider: $EXPECT_PROVIDER"

# --- A. Bundle completeness -------------------------------------------------
echo "-- A. candidate bundle files"
for f in config.asha.yaml SOUL.asha.md asha.alias.sh asha-responder.service.drop-in hashes.pins; do
  [ -f "$BUNDLE_DIR/$f" ] && ok "bundle file present: $f" || bad "bundle file missing: $f"
done

# --- B. Template: exact profile routing -------------------------------------
echo "-- B. profile routing (alias -> hermes -p asha)"
check "alias launches hermes"   grep -q 'hermes' "$ALIAS_TPL"
check "alias pins profile -p asha" grep -q -- '-p asha' "$ALIAS_TPL"
[ "$(grep -o -- '-p asha' "$ALIAS_TPL" | wc -l)" = "1" ] \
  && ok "alias pins exactly one profile (-p asha)" \
  || bad "alias -p asha count != 1"

# --- C. Template: exact model route -----------------------------------------
echo "-- C. model route (fork-configurable; expected $EXPECT_MODEL / $EXPECT_PROVIDER)"
check "model.default == $EXPECT_MODEL"     grep -qE "^[[:space:]]*default:[[:space:]]*${EXPECT_MODEL}[[:space:]]*$" "$CFG"
check "model.provider == $EXPECT_PROVIDER" grep -qE "^[[:space:]]*provider:[[:space:]]*${EXPECT_PROVIDER}[[:space:]]*$" "$CFG"
check "model.base_url == $EXPECT_BASE_URL" grep -qE "^[[:space:]]*base_url:[[:space:]]*${EXPECT_BASE_URL}[[:space:]]*$" "$CFG"
check "model.api_mode == $EXPECT_API_MODE" grep -qE "^[[:space:]]*api_mode:[[:space:]]*${EXPECT_API_MODE}[[:space:]]*$" "$CFG"

# --- D. Template: Asha SOUL + findings law ----------------------------------
echo "-- D. SOUL template (identity + MU.100.001 §2.2 findings law)"
check "SOUL identity: asha"      grep -q 'asha' "$SOUL"
check "SOUL agent_id pinned"     grep -q "$EXPECT_AGENT_ID" "$SOUL"
check "SOUL VERIFIED marker"     grep -q 'VERIFIED' "$SOUL"
check "SOUL REFUTED marker"      grep -q 'REFUTED' "$SOUL"
check "SOUL UNPROVEN marker"     grep -q 'UNPROVEN' "$SOUL"
check "SOUL three-part form (1) what was checked" grep -q '(1) what was checked' "$SOUL"

# --- E. Template: unit drop-in routing + guardrails --------------------------
echo "-- E. responder drop-in template (route + fail-closed flags)"
check "drop-in RESPONDER_BIN -> asha alias" grep -q 'RESPONDER_BIN=/home/mumega/.local/bin/asha' "$DROPIN_TPL"
check "drop-in RESPONDER_FLAVOR=hermes"     grep -q 'RESPONDER_FLAVOR=hermes' "$DROPIN_TPL"
if grep -q 'RESPONDER_EXECUTE_ROUTINES=' "$DROPIN_TPL" && ! grep -q 'RESPONDER_EXECUTE_ROUTINES=1' "$DROPIN_TPL"; then
  ok "drop-in RESPONDER_EXECUTE_ROUTINES off (fail-closed)"
else
  bad "drop-in RESPONDER_EXECUTE_ROUTINES not pinned off"
fi
if grep -q 'RESPONDER_TASKS=' "$DROPIN_TPL" && ! grep -q 'RESPONDER_TASKS=1' "$DROPIN_TPL"; then
  ok "drop-in RESPONDER_TASKS off (fail-closed)"
else
  bad "drop-in RESPONDER_TASKS not pinned off"
fi
check "drop-in identity RESPONDER_AGENT=asha"      grep -q 'RESPONDER_AGENT=asha' "$DROPIN_TPL"
check "drop-in identity RESPONDER_AGENT_ID pinned" grep -q "RESPONDER_AGENT_ID=$EXPECT_AGENT_ID" "$DROPIN_TPL"

# --- F. Fingerprints: nothing minted/modified since authoring ----------------
echo "-- F. fingerprints (token + machinery + retired units unchanged)"
[ -f "$TOKEN_FILE" ] && ok "token file present" || bad "token file missing"
[ "$(stat -c '%a' "$TOKEN_FILE" 2>/dev/null)" = "600" ] \
  && ok "token mode 600" || bad "token mode != 600"
while read -r pin rel; do
  [ -z "$pin" ] && continue
  case "$pin" in \#*) continue ;; esac
  if [ "$(sha256sum "$SMOKE_FLEET_ROOT/$rel" 2>/dev/null | awk '{print $1}')" = "$pin" ]; then
    ok "pin unchanged: $rel"
  else
    bad "pin MISMATCH: $rel (minted/modified since candidate?)"
  fi
done < "$PINS"

# --- G. No activation (baseline only) ----------------------------------------
if [ "$MODE" = "baseline" ]; then
  echo "-- G. no activation (baseline state)"
  [ ! -d "$PROFILE_DIR" ] && ok "profile 'asha' NOT created" || bad "profile 'asha' EXISTS (activated!)"
  [ ! -e "$ALIAS_FILE" ]  && ok "alias 'asha' NOT installed" || bad "alias 'asha' EXISTS (activated!)"
  if command -v systemctl >/dev/null 2>&1; then
    if systemctl list-unit-files --no-legend 2>/dev/null | grep -qE '^(asha-responder|asha-inbox-capture)\.service'; then
      bad "asha units registered with systemd (activated!)"
    else
      ok "no asha-* units registered with systemd"
    fi
  else
    skip "systemctl unavailable — unit registration not checked"
  fi
  if command -v pgrep >/dev/null 2>&1; then
    if pgrep -f 'prime-responder[.]py|inbox-watch[.]py' >/dev/null 2>&1; then
      bad "responder/watcher process RUNNING (activated!)"
    else
      ok "no responder/watcher process running"
    fi
  else
    skip "pgrep unavailable — process check skipped"
  fi
  for u in "$SMOKE_FLEET_ROOT/retired-units-20260815/asha-responder.service" \
           "$SMOKE_FLEET_ROOT/retired-units-20260815/asha-inbox-capture.service"; do
    [ -f "$u" ] && ok "retired base unit still parked: $(basename "$u")" || bad "retired base unit gone: $u"
  done
  [ -d "$AGENT_SPOOL" ] && ok "inbox capture spool surface intact" || bad "inbox spool dir missing: $AGENT_SPOOL"
else
  echo "-- G. promotion-ready: installed artifacts match templates"
  [ -d "$PROFILE_DIR" ] && ok "profile 'asha' exists" || bad "profile 'asha' missing"
  [ -f "$PROFILE_DIR/SOUL.md" ] && ok "profile SOUL.md exists" || bad "profile SOUL.md missing"
  check "installed SOUL identity asha"      grep -q 'asha' "$PROFILE_DIR/SOUL.md"
  check "installed SOUL findings law"       grep -q 'UNPROVEN' "$PROFILE_DIR/SOUL.md"
  check "installed config model == $EXPECT_MODEL"     grep -qE "^[[:space:]]*default:[[:space:]]*${EXPECT_MODEL}[[:space:]]*$" "$PROFILE_DIR/config.yaml"
  check "installed config provider == $EXPECT_PROVIDER" grep -qE "^[[:space:]]*provider:[[:space:]]*${EXPECT_PROVIDER}[[:space:]]*$" "$PROFILE_DIR/config.yaml"
  check "installed alias = hermes -p asha" grep -q -- '-p asha' "$ALIAS_FILE"
  [ -f "$SMOKE_SYSTEMD_DROPIN" ] && ok "unit drop-in installed" || bad "unit drop-in missing: $SMOKE_SYSTEMD_DROPIN"
  check "drop-in RESPONDER_FLAVOR=hermes"  grep -q 'RESPONDER_FLAVOR=hermes' "$SMOKE_SYSTEMD_DROPIN"
  check "drop-in EXECUTE_ROUTINES off"     grep -q 'RESPONDER_EXECUTE_ROUTINES=' "$SMOKE_SYSTEMD_DROPIN"
  check "drop-in TASKS off"                grep -q 'RESPONDER_TASKS=' "$SMOKE_SYSTEMD_DROPIN"
  if [ "$SMOKE_SYSTEMD_UNIT_DIR" = "/etc/systemd/system" ] && command -v systemctl >/dev/null 2>&1; then
    if systemctl is-enabled asha-responder >/dev/null 2>&1; then
      ok "asha-responder unit enabled"
    else
      bad "asha-responder unit NOT enabled"
    fi
  else
    skip "unit enablement not checked (fixture/override roots)"
  fi
fi

# --- Result ----------------------------------------------------------------
echo "== RESULT mode=$MODE profile=asha model=$EXPECT_MODEL provider=$EXPECT_PROVIDER activation=$([ "$MODE" = baseline ] && echo none || echo promoted-verified)"
echo "== $PASS pass, $FAIL fail, $SKIP skip"
[ "$FAIL" -eq 0 ]