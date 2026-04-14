#!/usr/bin/env bash
# SPDX-License-Identifier: Hippocratic-3.0
#
# Spin up two Babelr instances side-by-side for local federation testing.
#
# Instance A:  http://babelr-a.local:3000  (client on :1111)
# Instance B:  http://babelr-b.local:3001  (client on :1112)
#
# Prerequisites (one-time setup):
#
#   1. /etc/hosts entries (requires sudo once):
#        127.0.0.1 babelr-a.local
#        127.0.0.1 babelr-b.local
#
#   2. Two Postgres databases (matching the babelr role from .env):
#        PGPASSWORD=babelr createdb -h localhost -U babelr babelr_a
#        PGPASSWORD=babelr createdb -h localhost -U babelr babelr_b
#
#   3. Migrations applied to each:
#        DATABASE_URL=postgresql://babelr:babelr@localhost:5432/babelr_a \
#          npm run db:migrate -w packages/server
#        DATABASE_URL=postgresql://babelr:babelr@localhost:5432/babelr_b \
#          npm run db:migrate -w packages/server
#
# See docs/FEDERATION_TESTING.md for the full walkthrough and the
# manual test checklist.
#
# Usage:
#   ./scripts/dev-two-instance.sh          # start all four processes
#   Ctrl-C                                 # stop everything cleanly
#
# Environment overrides (rarely needed):
#   SESSION_SECRET_A / SESSION_SECRET_B — per-instance session secret
#   DATABASE_URL_A   / DATABASE_URL_B   — per-instance Postgres URL

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# --- Config ---------------------------------------------------------------

HOST_A="babelr-a.local"
HOST_B="babelr-b.local"
SERVER_PORT_A=3000
SERVER_PORT_B=3001
CLIENT_PORT_A=1111
CLIENT_PORT_B=1112

DATABASE_URL_A="${DATABASE_URL_A:-postgresql://babelr:babelr@localhost:5432/babelr_a}"
DATABASE_URL_B="${DATABASE_URL_B:-postgresql://babelr:babelr@localhost:5432/babelr_b}"
SESSION_SECRET_A="${SESSION_SECRET_A:-federation-test-secret-a-not-for-production}"
SESSION_SECRET_B="${SESSION_SECRET_B:-federation-test-secret-b-not-for-production}"

# --- Preflight checks ----------------------------------------------------

check_hosts_entry() {
  local host=$1
  if ! getent hosts "$host" >/dev/null 2>&1; then
    echo "ERROR: $host does not resolve." >&2
    echo "Add to /etc/hosts:" >&2
    echo "  127.0.0.1 babelr-a.local" >&2
    echo "  127.0.0.1 babelr-b.local" >&2
    exit 1
  fi
}
check_hosts_entry "$HOST_A"
check_hosts_entry "$HOST_B"

# --- Colored log prefixer ------------------------------------------------

# Each child process has its output piped through a small awk filter
# that prepends a colored tag so you can tell which instance is saying
# what when both are logging at once.
prefix() {
  local tag=$1
  local color=$2
  awk -v tag="$tag" -v color="$color" \
    '{ printf "\033[%sm[%s]\033[0m %s\n", color, tag, $0; fflush(); }'
}

# --- Process management --------------------------------------------------

PIDS=()

cleanup() {
  echo ""
  echo "Stopping all instances..."
  for pid in "${PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  # Give them a second to exit cleanly, then hard-kill anything still up.
  sleep 1
  for pid in "${PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
  echo "Done."
  exit 0
}
trap cleanup INT TERM

# --- Launch servers ------------------------------------------------------

echo "Starting instance A (server :$SERVER_PORT_A, client :$CLIENT_PORT_A)"
echo "Starting instance B (server :$SERVER_PORT_B, client :$CLIENT_PORT_B)"
echo ""
echo "Press Ctrl-C to stop everything."
echo ""

# The server package's dev script passes --env-file=../../.env, which
# loads .env first and lets inline environment variables override any
# of its values (Node's --env-file behavior). That's why we can set
# per-instance DB and port inline without touching .env.

# mediasoup port ranges must be disjoint so the two SFU workers don't
# compete for the same UDP ports. announcedIp = 127.0.0.1 so federated
# voice candidates work between babelr-a.local and babelr-b.local on
# the same machine.

(
  DATABASE_URL="$DATABASE_URL_A" \
  PORT="$SERVER_PORT_A" \
  HOST="127.0.0.1" \
  BABELR_DOMAIN="$HOST_A:$SERVER_PORT_A" \
  SESSION_SECRET="$SESSION_SECRET_A" \
  NODE_ENV=development \
  MEDIASOUP_LISTEN_IP=127.0.0.1 \
  MEDIASOUP_ANNOUNCED_IP=127.0.0.1 \
  MEDIASOUP_RTC_MIN_PORT=40000 \
  MEDIASOUP_RTC_MAX_PORT=40099 \
  npm run dev -w packages/server 2>&1 | prefix "server-a" "34"
) &
PIDS+=($!)

(
  DATABASE_URL="$DATABASE_URL_B" \
  PORT="$SERVER_PORT_B" \
  HOST="127.0.0.1" \
  BABELR_DOMAIN="$HOST_B:$SERVER_PORT_B" \
  SESSION_SECRET="$SESSION_SECRET_B" \
  NODE_ENV=development \
  MEDIASOUP_LISTEN_IP=127.0.0.1 \
  MEDIASOUP_ANNOUNCED_IP=127.0.0.1 \
  MEDIASOUP_RTC_MIN_PORT=40100 \
  MEDIASOUP_RTC_MAX_PORT=40199 \
  npm run dev -w packages/server 2>&1 | prefix "server-b" "35"
) &
PIDS+=($!)

# Give servers a head start so their initial log lines don't interleave
# with the vite startup banners.
sleep 1

(
  VITE_DEV_PORT="$CLIENT_PORT_A" \
  VITE_PROXY_TARGET="http://$HOST_A:$SERVER_PORT_A" \
  npm run dev -w packages/client 2>&1 | prefix "client-a" "36"
) &
PIDS+=($!)

(
  VITE_DEV_PORT="$CLIENT_PORT_B" \
  VITE_PROXY_TARGET="http://$HOST_B:$SERVER_PORT_B" \
  npm run dev -w packages/client 2>&1 | prefix "client-b" "33"
) &
PIDS+=($!)

echo ""
echo "Once everything is up:"
echo "  Instance A:  http://$HOST_A:$CLIENT_PORT_A"
echo "  Instance B:  http://$HOST_B:$CLIENT_PORT_B"
echo ""
echo "Register alice on A and bob on B, then walk through the checklist"
echo "in docs/FEDERATION_TESTING.md."
echo ""

# Wait for any child to exit, then clean up the rest.
wait -n
cleanup
