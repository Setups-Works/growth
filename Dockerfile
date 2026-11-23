# syntax=docker/dockerfile:1
#
# Setups Works Growth — production image.
#
# Three stages: install dependencies, build the Next.js standalone server,
# then copy only what the server needs into a small Alpine runtime image
# (no dev dependencies, no source, no build cache).

ARG NODE_VERSION=22-alpine

# ── 1. Dependencies ─────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ── 2. Build ────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# NEXT_PUBLIC_* values are inlined into the browser bundle at build time, so
# they must be supplied here (docker compose passes them from .env).
ARG NEXT_PUBLIC_SITE_URL=""
ARG NEXT_PUBLIC_RAZORPAY_KEY_ID=""
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    NEXT_PUBLIC_RAZORPAY_KEY_ID=$NEXT_PUBLIC_RAZORPAY_KEY_ID \
    NEXT_TELEMETRY_DISABLED=1

RUN npm run build

# ── 3. Runtime ──────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN addgroup -S -g 1001 app && adduser -S -u 1001 -G app app

COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public

# The migration runner runs outside the Next bundle, so it gets its own copy
# of the (dependency-free) postgres driver.
COPY --from=deps --chown=app:app /app/node_modules/postgres ./node_modules/postgres
COPY --chown=app:app db ./db
COPY --chown=app:app scripts/migrate.mjs ./scripts/migrate.mjs
COPY --chown=app:app docker/entrypoint.sh /usr/local/bin/entrypoint.sh

USER app
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1

ENTRYPOINT ["/bin/sh", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "server.js"]
