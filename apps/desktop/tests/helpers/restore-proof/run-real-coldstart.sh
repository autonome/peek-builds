#!/bin/bash
# REAL (non-Playwright) cold-start restore proof — the frontmost pixel proof the
# Playwright coldstart spec structurally cannot produce.
#
# Boots the built Electron app directly TWICE against an isolated tmp profile so
# the app becomes OS-frontmost (unlike Playwright, which never makes Electron
# frontmost, so its moveTops are window-server no-ops). Boot 0 initializes the
# profile; we then inject a crafted multi-window session; boot 1 is the MEASURED
# cold-start restore. Answers: on a real frontmost launch, do page-host moveTops
# stick (pages land in front of tiles) at/near renderer-paint time?
#
# Expected PASS stack (front->back): P1 P2 P3 P4 P5 T1 T2 T3.
#
# STEALS FOCUS during both launches. Run only when the screen is clear.
# Paths derive from this script's own location, so it works in any checkout.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../../.." && pwd)"
STAGE=/tmp/peek-real-coldstart-stage
PROFILE=tmp-restore-coldstart
ELECTRON="$REPO_ROOT/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
DB="$STAGE/$PROFILE/datastore.sqlite"
CG="$SCRIPT_DIR/../cg-windows.swift"
DIAG=/tmp/peek-cmd-diag.log
OUT=/tmp/peek-real-coldstart
BOOT1_SETTLE=12

cd "$REPO_ROOT" || exit 1
rm -rf "$STAGE"
mkdir -p "$STAGE"
rm -f "$DIAG" "$OUT.boot0.log" "$OUT.boot1.log" "$OUT.stack.json"

# ---------- Boot 0: initialize the profile (schema + onboarding) ----------
echo "[runner] boot0: initializing profile at $STAGE ..."
PROFILE=$PROFILE DEBUG=1 "$ELECTRON" . --user-data-dir="$STAGE" >"$OUT.boot0.log" 2>&1 &
B0=$!
for i in $(seq 1 80); do
  if [ -f "$DB" ] && sqlite3 "$DB" "SELECT 1 FROM feature_settings LIMIT 1;" >/dev/null 2>&1; then
    echo "[runner] boot0: datastore + feature_settings ready (after ${i} polls)"
    break
  fi
  sleep 0.5
done
sleep 4   # let onboarding/seed settle so boot1 won't re-run it
echo "[runner] boot0: quitting (SIGTERM $B0) ..."
kill -TERM "$B0" 2>/dev/null
wait "$B0" 2>/dev/null
sleep 1   # ensure DB handles/WAL released

# ---------- Inject crafted multi-window session ----------
echo "[runner] injecting staged session snapshot ..."
sqlite3 "$DB" ".read $SCRIPT_DIR/inject-session.sql"
echo "[runner] snapshot rows now in DB:"
sqlite3 "$DB" "SELECT id, length(value) FROM feature_settings WHERE featureId='session';"

# ---------- Boot 1: MEASURED real cold-start restore (frontmost) ----------
rm -f "$DIAG"
echo "[runner] boot1: cold-start restore (frontmost), settling ${BOOT1_SETTLE}s ..."
PROFILE=$PROFILE DEBUG=1 "$ELECTRON" . --user-data-dir="$STAGE" >"$OUT.boot1.log" 2>&1 &
B1=$!
sleep "$BOOT1_SETTLE"

echo "[runner] reading CGWindowList for pid $B1 ..."
swift "$CG" "$B1" > "$OUT.stack.json" 2>/dev/null
echo "[runner] quitting boot1 (SIGTERM $B1) ..."
kill -TERM "$B1" 2>/dev/null
wait "$B1" 2>/dev/null

echo ""
echo "================ RESULT ================"
echo "--- restore-focus decision + frontmost signals (boot1 stdout) ---"
grep -iE "restore-focus-decision|isAppFocused|did-become-active|cold-start re-assert" "$OUT.boot1.log" | head -30
echo ""
echo "--- [ff] first-frame / reassert timing (main-side diag, t= is Date.now-accurate) ---"
grep -E "\[ff" "$DIAG" 2>/dev/null | head -80
echo ""
echo "--- restore perf (window-loaded / dom-ready, boot1 stdout) ---"
grep -E "\[session:perf\]" "$OUT.boot1.log" | head -40
echo ""
echo "--- FINAL ON-SCREEN STACK ---"
python3 "$SCRIPT_DIR/decode-stack.py" "$OUT.stack.json"
echo "======================================="
echo "[runner] logs: $OUT.boot0.log  $OUT.boot1.log  $DIAG  $OUT.stack.json"
