#!/bin/sh
# crond does not pass the container environment to jobs, so the values are
# written into the crontab once, at start.
set -e

: "${CRON_SECRET:?CRON_SECRET must be set for the scheduler}"
APP_INTERNAL_URL="${APP_INTERNAL_URL:-http://app:3000}"

mkdir -p /etc/crontabs
sed -e "s|__APP_URL__|${APP_INTERNAL_URL}|g" -e "s|__CRON_SECRET__|${CRON_SECRET}|g" \
  /etc/growth/crontab.template > /etc/crontabs/root
chmod 600 /etc/crontabs/root

echo "[cron] scheduling jobs against ${APP_INTERNAL_URL}"
exec crond -f -l 6
