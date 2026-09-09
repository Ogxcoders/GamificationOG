#!/bin/sh
# GamificationOG — container entrypoint
# First boot: create the SQLite schema (prisma db push) and optionally seed
# the Customer Zero reference project. Every boot: start the standalone
# Next.js server (runs under Bun).
set -e

DB_PATH="${DATABASE_URL#file:}"
mkdir -p "$(dirname "$DB_PATH")" /app/db

if [ ! -f "$DB_PATH" ]; then
  echo "==> first boot: creating database schema at $DB_PATH"
  bun node_modules/prisma/build/index.js db push --skip-generate --accept-data-loss
  if [ "${GOG_AUTOSEED:-true}" = "true" ]; then
    echo "==> seeding Customer Zero reference project (FocusQuest)"
    bun scripts/seed.ts
  fi
else
  echo "==> existing database found at $DB_PATH"
fi

echo "==> starting GamificationOG on ${HOSTNAME:-0.0.0.0}:${PORT:-3000}"
exec bun server.js
