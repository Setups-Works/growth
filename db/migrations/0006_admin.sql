-- The admin panel: who is an admin, an editable plan catalog, site-wide
-- settings, and a record of every admin action.

-- Admins granted from the panel. ADMIN_EMAILS (env) is the other source, so
-- the first admin can exist before anyone can click anything.
alter table public.users add column if not exists is_admin boolean not null default false;

-- What each tier is called, costs, includes and is capped at. Read by the
-- pricing pages, Settings → Billing, checkout and the send gate, so a change
-- in the admin panel is a change everywhere at once. The ids stay fixed
-- (profiles.plan references them by value).
create table if not exists public.billing_plans (
    id text primary key check (id in ('lite', 'go', 'plus')),
    name text not null,
    price_paise integer not null check (price_paise >= 0),
    cadence text not null default 'per month',
    blurb text not null default '',
    features jsonb not null default '[]'::jsonb,
    -- null = unlimited WhatsApp messages a month; 0 = none.
    message_limit integer check (message_limit is null or message_limit >= 0),
    whatsapp boolean not null default true,
    highlight boolean not null default false,
    trial_days integer not null default 14 check (trial_days between 0 and 90),
    -- The Razorpay plan new subscriptions are created on. Null falls back to
    -- RAZORPAY_PLAN_ID_<TIER>. Razorpay plans are immutable, so a price change
    -- means a new plan id; existing subscribers stay on the one they bought.
    razorpay_plan_id text,
    sort integer not null default 0,
    updated_at timestamptz not null default now()
);

insert into public.billing_plans (id, name, price_paise, blurb, features, message_limit, whatsapp, highlight, sort) values
  ('lite', 'Lite', 199900, 'For a store that wants the analytics, not the messaging.',
   '["Every analytics module — RFM, cohorts, LTV, products, inventory", "Report exports (PDF, Excel, CSV)", "No WhatsApp campaigns, flows, inbox, order confirmations or assistant", "Pay by UPI Autopay or card, cancel anytime"]'::jsonb,
   0, false, false, 1),
  ('go', 'Go', 399900, 'For a store sending campaigns and flows at a steady pace.',
   '["10,000 WhatsApp messages per month", "Every feature included — analytics, campaigns, flows, the assistant", "Pay by UPI Autopay or card, cancel anytime"]'::jsonb,
   10000, true, false, 2),
  ('plus', 'Plus', 599900, 'For a store that doesn''t want to think about a message count.',
   '["Unlimited WhatsApp messages", "Every feature included — analytics, campaigns, flows, the assistant", "Pay by UPI Autopay or card, cancel anytime"]'::jsonb,
   null, true, true, 3)
on conflict (id) do nothing;

-- Small site-wide settings (the announcement banner, signup switch, …).
create table if not exists public.app_settings (
    key text primary key,
    value jsonb not null,
    updated_at timestamptz not null default now(),
    updated_by uuid references public.users(id) on delete set null
);

-- Every change made from the admin panel: who, what, to whom, when.
create table if not exists public.admin_audit (
    id bigserial primary key,
    admin_id uuid references public.users(id) on delete set null,
    admin_email text not null,
    action text not null,
    target text,
    detail jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);
create index if not exists admin_audit_created_idx on public.admin_audit (created_at desc);

-- Suspended accounts cannot sign in, and their sessions stop working.
alter table public.users add column if not exists suspended_at timestamptz;

-- A plan granted by an admin, free, until this moment (a partner, a refund,
-- a support gesture). Counts as a usable plan on its own — no Razorpay
-- subscription involved — and lapses by itself.
alter table public.profiles add column if not exists comp_until timestamptz;
