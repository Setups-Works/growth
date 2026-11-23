#!/bin/sh
# Azure App Service startup command: `sh startup.sh` (set by scripts/azure-setup.sh).
# Applies pending database migrations, then starts the Next.js server.
set -e
cd "$(dirname "$0")"

node scripts/migrate.mjs

# App Service sets HOSTNAME to the instance name; the server must listen on all
# interfaces, on the port App Service assigns (PORT).
export HOSTNAME=0.0.0.0
exec node server.js
