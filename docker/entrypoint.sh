#!/bin/sh
# Applies pending database migrations, then starts the server.
# Set RUN_MIGRATIONS=false to skip (e.g. when migrating from a separate job).
set -e

if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  node scripts/migrate.mjs
fi

exec "$@"
