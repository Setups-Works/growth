#!/usr/bin/env bash
# Builds a self-contained zip for Azure App Service (Linux, Node 24).
#
#   NEXT_PUBLIC_SITE_URL=https://<app>.azurewebsites.net scripts/package-azure.sh
#
# Must run on Linux x64 with Node 24 (the deploy workflow does): the standalone output
# includes platform-specific binaries. Produces ./app.zip containing the
# Next.js standalone server, static assets, migrations and docker/azure-startup.sh.
set -euo pipefail

npm ci --no-audit --no-fund
npm run build

rm -rf deploy app.zip
mkdir -p deploy/scripts
cp -r .next/standalone/. deploy/
mkdir -p deploy/.next
cp -r .next/static deploy/.next/static
cp -r public deploy/public
cp -r db deploy/db
cp scripts/migrate.mjs deploy/scripts/migrate.mjs
# The migration runner runs outside the Next bundle and needs its own driver.
mkdir -p deploy/node_modules
rm -rf deploy/node_modules/postgres
cp -r node_modules/postgres deploy/node_modules/postgres
cp docker/azure-startup.sh deploy/startup.sh

(cd deploy && zip -qr ../app.zip .)
echo "Packaged app.zip ($(du -h app.zip | cut -f1))"
