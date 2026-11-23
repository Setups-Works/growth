# A tiny scheduler: BusyBox crond calling the app's /api/cron/* endpoints.
# Replaces Supabase pg_cron + pg_net. About 8 MB.
FROM alpine:3.20
COPY crontab /etc/growth/crontab.template
COPY entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/bin/sh", "/entrypoint.sh"]
