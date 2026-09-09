#!/bin/bash
# GamificationOG — Full test runner: starts dev server, waits for ready,
# runs every E2E suite (web + Rust⟷TS parity), stops the server, and
# reports a combined verdict.
# Usage: bash scripts/run-all-tests.sh [base-url]
set -uo pipefail
cd "$(dirname "$0")/.."

BASE="${1:-http://localhost:3000}"
LOG=.zscripts/test-run.log
mkdir -p "$(dirname "$LOG")"
SUITES=(
  e2e-verify
  e2e-features
  e2e-sdk
  e2e-db
  e2e-monetization
  e2e-mcp
  e2e-packs
  e2e-plugins
  e2e-io
  e2e-cli
  e2e-security
  e2e-ops
  e2e-sso
  e2e-scim
  e2e-region
  e2e-promote
  e2e-fraud
  e2e-replay
  e2e-realtime
  e2e-dr
)
declare -A RESULTS

# already running? else start one
if ! curl -s -o /dev/null --max-time 3 "$BASE/"; then
  echo "==> Starting dev server..."
  (bun run dev > dev.log 2>&1 &)
  for i in $(seq 1 60); do
    if curl -s -o /dev/null --max-time 2 "$BASE/"; then break; fi
    sleep 2
  done
fi
curl -s -o /dev/null --max-time 5 "$BASE/" || { echo "FATAL: server did not start"; exit 1; }
echo "==> Server ready at $BASE"

for suite in "${SUITES[@]}"; do
  echo ""
  echo "════════════════ SUITE: $suite ════════════════"
  if timeout 400 bun "scripts/$suite.ts" "$BASE" > "$LOG" 2>&1; then
    RESULTS[$suite]="PASS"
    tail -3 "$LOG"
  else
    RESULTS[$suite]="FAIL"
    rg "❌|RESULT|Failed:|error" "$LOG" | head -20
  fi
done

# Rust⟷TS parity — no web server needed, only the built Rust CLI
echo ""
echo "════════════════ SUITE: e2e-rust-parity (no server) ════════════════"
if [ -x ./target/debug/gog-engine ]; then
  if timeout 120 bun scripts/e2e-rust-parity.ts > "$LOG" 2>&1; then
    RESULTS[e2e-rust-parity]="PASS"
    tail -3 "$LOG"
  else
    RESULTS[e2e-rust-parity]="FAIL"
    rg "❌|RESULT|Failed:|error" "$LOG" | head -20
  fi
else
  echo "  ⏭️  skipped (Rust CLI not built — run: cargo build)"
  RESULTS[e2e-rust-parity]="SKIP"
fi

echo ""
echo "════════════════════════════════════════════════"
echo "  COMBINED RESULTS"
total_pass=0
for suite in "${SUITES[@]}"; do
  status="${RESULTS[$suite]}"
  marker=$([ "$status" = "PASS" ] && echo "✅" || echo "❌")
  echo "  $marker $suite: $status"
  [ "$status" = "FAIL" ] && overall=1 || true
done
rp="${RESULTS[e2e-rust-parity]}"
rp_marker=$([ "$rp" = "PASS" ] && echo "✅" || { [ "$rp" = "SKIP" ] && echo "⏭️" || echo "❌"; })
echo "  $rp_marker e2e-rust-parity: $rp"
[ "$rp" = "FAIL" ] && overall=1 || true
if [ "${overall:-0}" = "1" ]; then
  echo "  VERDICT: FAILURES PRESENT — inspect $LOG"
  exit 1
fi
echo "  🎉 ALL SUITES PASSED"
exit 0
