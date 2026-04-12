#!/usr/bin/env bash
# SPDX-License-Identifier: Hippocratic-3.0
#
# Drop and recreate both federation-testing databases from scratch.
# Run this when accumulated state from prior test runs is getting
# in the way and you want a clean slate without thinking about it.
#
# Safe to run while dev-two-instance.sh is stopped. If the rig is
# running, stop it first (Ctrl-C) — the servers hold connections
# that prevent dropdb from succeeding.
#
# Usage:
#   ./scripts/reset-federation-dbs.sh
#
# Environment overrides (must match dev-two-instance.sh if changed):
#   PGUSER / PGPASSWORD — Postgres role (default: babelr/babelr)
#   PGHOST              — Postgres host (default: localhost)
#   DATABASE_A          — instance A database name (default: babelr_a)
#   DATABASE_B          — instance B database name (default: babelr_b)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

PGUSER="${PGUSER:-babelr}"
PGPASSWORD="${PGPASSWORD:-babelr}"
PGHOST="${PGHOST:-localhost}"
DATABASE_A="${DATABASE_A:-babelr_a}"
DATABASE_B="${DATABASE_B:-babelr_b}"

export PGPASSWORD

echo "Resetting federation databases..."
echo "  Host:      $PGHOST"
echo "  Role:      $PGUSER"
echo "  Databases: $DATABASE_A, $DATABASE_B"
echo ""

for DB in "$DATABASE_A" "$DATABASE_B"; do
  echo -n "  [$DB] drop... "
  dropdb -h "$PGHOST" -U "$PGUSER" "$DB" 2>/dev/null && echo -n "ok" || echo -n "skipped (didn't exist)"
  echo -n " → create... "
  createdb -h "$PGHOST" -U "$PGUSER" "$DB"
  echo -n "ok → migrate... "
  DATABASE_URL="postgresql://$PGUSER:$PGPASSWORD@$PGHOST:5432/$DB" \
    npm run db:migrate -w packages/server --silent 2>&1 | tail -1
  echo "done."
done

echo ""
echo "Both databases are fresh. Start the rig:"
echo "  ./scripts/dev-two-instance.sh"
