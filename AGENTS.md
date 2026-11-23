<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Setups Works Growth — orientation for AI agents

`README.md` is the full reference (architecture diagrams, every pipeline, every
feature, deployment, troubleshooting) — read it before touching a subsystem you
don't already know. This file is not a second copy of that. It exists for the
things that aren't written down anywhere else, and that a careful read of the
code alone won't surface fast enough: real gotchas from real incidents in this
codebase, and the one or two facts that quietly invalidate an otherwise
reasonable assumption a fresh agent would make.

## Everything runs in Docker — there is no Supabase and no Vercel

The stack is `docker-compose.yml`: `app` (Next.js standalone), `db`
(PostgreSQL 17), `cron` (BusyBox crond) and an optional `caddy` for HTTPS.
This project used to run on Supabase (Auth, pg_cron, Vault) and Vercel; all of
that is gone. If you find a comment, doc or habit that assumes Supabase Auth,
`auth.users`, `auth.uid()`, RLS policies, pg_cron, `supabase/migrations`,
Vercel Cron, Redis/KV or serverless cold starts, it is stale — fix it rather
than following it.

**Scheduling** lives in `docker/cron/crontab`: `/api/cron/sync` every 10 min,
`/api/cron/flows` daily at 04:30 UTC, `/api/cron/abandoned-checkouts` every 5
min, each POSTed with `CRON_SECRET` as a bearer token over the private Docker
network. That file is the source of truth for cadence — grep it, don't trust
prose. A new scheduled route copies the existing constant-time `CRON_SECRET`
check verbatim, goes in `PUBLIC_API` in `src/proxy.ts`, and gets a crontab line.

**Auth** is the app's own: `users` table, scrypt hashes
(`src/lib/auth/password.ts`), an HMAC-signed `sw_session` cookie
(`src/lib/auth/session.ts`), and the `/api/auth/*` routes. Password-reset
tokens are stored as SHA-256 digests only. Keep that digest-only discipline.

## The tenant-scoping chokepoint

The server reaches Postgres as the table owner and there are no row-level
security policies — so nothing in the database keeps one tenant from reading
another's data. `src/lib/auth/tenant.ts` is what does: every request
handler resolves a `Tenant`/`TenantStore` through `resolveTenant` /
`requireTenant` / `requireStore` / `activeStore` and scopes its own queries by
the returned `storeId`/`userId`. A handler that queries a tenant-owned table
without going through one of these first has no isolation at all — this is
the one file where a shortcut is a cross-tenant data leak, not a style issue.

## Known-shape bug: per-tenant config tables

`whatsapp_config` (single-tenant) was dropped and replaced by
`whatsapp_connections` (per-user) in the multi-tenant migration
but `src/lib/whatsapp/config.ts` kept
querying the old table for a long time afterward — every WhatsApp-touching
route silently broke ("Cannot POST /api/sessions//start") except the one route
that happened to do its own inline session lookup. The fix was threading
`userId` through every exported function in that file
(`readWhatsAppConfig(userId)` etc.) rather than reading a single global row.
If you add a new per-tenant config table, check every reader takes a
tenant/user id as a real parameter — a config helper with no id parameter in a
multi-tenant app is a bug waiting to surface exactly like this one did.

## Database migrations

Schema changes are plain SQL files in `db/migrations/`, applied in filename
order by `scripts/migrate.mjs` (each once, in a transaction, under an advisory
lock) — automatically when the `app` container starts, or by hand with
`DATABASE_URL=... npm run db:migrate`. `0001_baseline.sql` is the consolidated
end state of the old Supabase migration history; never edit an applied file —
add `0002_*.sql`. There is no RLS: the app connects as the table owner, so
tenant isolation is entirely `src/lib/auth/tenant.ts` (below).

## Safety rules for anything that can message a real phone

- **Test sends go to one number only.** Never send a real WhatsApp message —
  test or otherwise — to a number that isn't the established test number,
  without the user explicitly naming a different recipient in the current
  conversation. A phone number pulled from real WooCommerce order/customer
  data is a real customer; treat it as one.
- **The abandoned-checkout `enabled_at` boundary is load-bearing, not
  incidental.** `stores.abandoned_checkout_enabled_at` is reset to `now()`
  every time the toggle is switched on (`src/app/api/whatsapp/abandoned-
  checkouts/route.ts`), specifically so that turning the feature on for a
  store with a real backlog of old pending orders never messages that backlog
  as a batch. Any new "resume a paused recovery/reminder feature" work should
  default to the same pattern — an explicit boundary timestamp reset on
  enable — rather than "everything currently eligible" the moment a switch
  flips.
- The AI assistant (`src/lib/ai/execute.ts`) never returns a phone number or
  email to the model, and action tools (anything that sends or changes state)
  are returned to the browser as unexecuted proposals for a human to approve —
  the assistant is a way to reach the ordinary REST endpoints, not a way
  around their guards. Keep both properties if you add a tool.

## Jira workflow for AI agents

Work is tracked on the Setups Works Growth Jira board
(`setups-works.atlassian.net/jira/software/projects/PUL/boards/2`), not in
GitHub Issues. An issue that's ready for an agent to pick up carries an
**"Agent prompt" comment** — self-contained context, real file pointers, and
a "done when" checklist, written to be handed to the agent directly rather
than just the issue summary.

**Building a new feature that has no issue yet is a five-step protocol —
create the issue, move it to In Progress before writing code, move it to In
Review the moment a PR is open, and only to Done after it's actually
merged.** [JIRA_WORKFLOW.md](JIRA_WORKFLOW.md) is the exact, mechanical
version of this — read it before starting a feature from scratch, don't
improvise the transition points.

**Commit and link via a branch + PR, not a direct push to `main`.** GitHub
for Jira's webhook reliably links a commit that arrives as part of a pull
request — confirmed by direct test, a PR linked within seconds. A commit
pushed straight to `main` was observed sitting unlinked for 15+ minutes on
this repo even after the same commit's issue was otherwise valid and
correctly keyed. Branch, commit with the issue key at the start of the
message (`PUL-12: rename ...`), open a PR with the same key in the title,
and merge that — don't push directly to `main` for anything that should
show up on the issue's Development tab.

**Each developer needs their own personal Jira API token for agent tooling
to call the Jira REST API** (transitioning an issue, adding a comment,
creating a linked sub-task) — this is separate from `.env.local`, which is
runtime config the Next.js app itself reads; Jira credentials are never
read by the app and must never end up in a file tracked by git. Generate a
token at `id.atlassian.com/manage-profile/security/api-tokens`, scoped to
your own Atlassian account, and export it in your own shell/agent config
(commonly `JIRA_EMAIL` / `JIRA_API_TOKEN`, though the exact names depend on
your tooling) — never use someone else's token on their behalf, and never
paste a token into a commit, a PR description, or a file this repo tracks.

## Update the changelog in the same PR, not after

`src/lib/marketing/changelog.ts` feeds the public `/changelog` page, and it
drifts the same way `README.md`'s "Vercel Cron" claim did — quietly, until
someone notices it's stale. It went unmaintained for a week in practice: five
real shipped changes (a new plan, a reliability fix, three new pages, several
bug fixes) landed across five separate PRs with none of them touching this
file, and it took a dedicated catch-up pass to close the gap. Don't leave that
for someone else to notice later.

**If a PR changes what a signed-in customer or a visitor can see or do, add a
changelog entry in that same PR** — new pages, new plans or pricing, a
customer-visible bug fix, a real behavior change. Follow the file's own doc
comment for what to leave out (internal refactors with no visible effect,
abandoned experiments) and match its existing voice: product language, not
engineering language ("A campaign sending a photo or video over WhatsApp no
longer fails silently", not "fixed BulkMessageContentDto schema mismatch").
Group under today's real date; add a new date block at the top of the array
rather than editing an old one. This is the same discipline as
`src/lib/openapi.ts` — new routes documented in the commit that adds them, not
backfilled in a batch later.

## Where to look first

- `src/proxy.ts` — the single auth chokepoint (Next 16's replacement for
  `middleware.ts`); `PUBLIC_API` / `READ_ONLY_POSTS` / `PROTECTED_PAGES` are
  the allowlists that decide what needs a session or key.
- `src/lib/openapi.ts` — the hand-written OpenAPI 3.1 spec. CI
  (`scripts/check-openapi.mjs`) fails if a route exists that this doesn't
  describe; add new routes here in the same commit that adds them.
- `src/lib/auth/` — `tenant.ts`, `session.ts`, `password.ts`,
  `current-user.ts`, `api-key.ts`, `pending.ts`: the whole auth surface.
  Small on purpose; match the existing digest-only / signed-token-only
  discipline rather than inventing a new pattern.
- `docker-compose.yml`, `Dockerfile`, `docker/` — how it runs.
- `db/migrations/` — the schema.

## WhatsApp is the bundled engine in `whatsapp/`, not an external gateway

There is no OpenWA or other third-party gateway any more. The `whatsapp`
service (`whatsapp/src/`, Node + Baileys) holds one linked-device session per
account — session id = user id — that the account owner links by scanning a QR
in Settings → WhatsApp. It is reachable only on the Docker network with
`WHATSAPP_ENGINE_KEY`. Its HTTP API is documented at the top of
`whatsapp/src/server.mjs` and consumed by `src/lib/whatsapp/client.ts`: change
both sides together. The menu bot (`chat-flow`) runs inside the engine
(`whatsapp/src/menu-bot.mjs`); the inbox reads the engine's `wa_messages`
table. Pairing credentials live on the `wa-data` volume, never in Postgres.

Billing gates (Lite plan, message caps) apply only when Razorpay is configured
(`billingEnforced()` in `src/lib/billing/usage.ts`); a self-hosted server
without Razorpay gives every account every feature.
