-- Setups Works Growth baseline schema.
--
-- The consolidated end state of the original migration history, rewritten
-- for plain PostgreSQL (no Supabase auth, pg_cron, pg_net or Vault). Applied
-- once by scripts/migrate.mjs; later changes go in new numbered files next to
-- this one, never as edits to it.
--
-- Tenant isolation is enforced in application code (src/lib/auth/tenant.ts):
-- the app connects as the table owner, so there are no row-level-security
-- policies here.

SET client_min_messages = warning;
SET check_function_bodies = false;

-- ── Accounts ────────────────────────────────────────────────────────────────
-- Replaces Supabase's auth.users. Passwords are stored as scrypt hashes only
-- (see src/lib/auth/password.ts). Email is unique case-insensitively.

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    email text NOT NULL,
    password_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX users_email_lower_idx ON public.users (lower(email));

-- One-time password-reset tokens, stored as a SHA-256 digest only.
CREATE TABLE public.password_resets (
    token_hash text NOT NULL PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX password_resets_user_idx ON public.password_resets (user_id);

-- Every user gets a profile row, created by trigger so it always exists.
CREATE FUNCTION public.handle_new_user() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

--
-- Name: touch_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


--
-- Name: api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_keys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    hash text NOT NULL,
    display text NOT NULL,
    scopes text[] DEFAULT '{read}'::text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone
);


--
-- Name: billing_invoices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.billing_invoices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    razorpay_invoice_id text,
    razorpay_payment_id text,
    plan text NOT NULL,
    amount_paise integer NOT NULL,
    currency text DEFAULT 'INR'::text NOT NULL,
    status text DEFAULT 'paid'::text NOT NULL,
    period_start timestamp with time zone NOT NULL,
    period_end timestamp with time zone NOT NULL,
    paid_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT billing_invoices_plan_check CHECK ((plan = ANY (ARRAY['go'::text, 'plus'::text, 'lite'::text]))),
    CONSTRAINT billing_invoices_status_check CHECK ((status = ANY (ARRAY['paid'::text, 'failed'::text, 'refunded'::text])))
);


--
-- Name: billing_webhook_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.billing_webhook_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    body_hash text NOT NULL,
    event_type text NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE billing_webhook_events; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.billing_webhook_events IS 'Written and read entirely by the Razorpay webhook route, keyed on a hash of the raw request body, so a retried delivery is a no-op.';


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profiles (
    id uuid NOT NULL,
    email text NOT NULL,
    full_name text,
    avatar_url text,
    onboarded_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    plan text,
    subscription_status text DEFAULT 'none'::text NOT NULL,
    razorpay_customer_id text,
    razorpay_subscription_id text,
    current_period_end timestamp with time zone,
    grace_until timestamp with time zone,
    legacy_unlimited boolean DEFAULT false NOT NULL,
    trial_ends_at timestamp with time zone,
    trial_used_at timestamp with time zone,
    CONSTRAINT profiles_plan_check CHECK ((plan = ANY (ARRAY['go'::text, 'plus'::text, 'lite'::text]))),
    CONSTRAINT profiles_subscription_status_check CHECK ((subscription_status = ANY (ARRAY['none'::text, 'created'::text, 'authenticated'::text, 'active'::text, 'past_due'::text, 'halted'::text, 'cancelled'::text])))
);


--
-- Name: stores; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stores (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    url text NOT NULL,
    name text,
    consumer_key text NOT NULL,
    consumer_secret text NOT NULL,
    history_months integer DEFAULT 24 NOT NULL,
    max_pages integer DEFAULT 300 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    synced_through timestamp with time zone,
    last_sync_at timestamp with time zone,
    order_count integer DEFAULT 0 NOT NULL,
    customer_count integer DEFAULT 0 NOT NULL,
    product_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    backfill_through timestamp with time zone,
    backfill_done boolean DEFAULT false NOT NULL,
    abandoned_checkout_enabled boolean DEFAULT false NOT NULL,
    abandoned_checkout_enabled_at timestamp with time zone,
    order_confirmation_enabled boolean DEFAULT false NOT NULL,
    order_confirmation_enabled_at timestamp with time zone,
    order_confirmation_webhook_id bigint,
    order_confirmation_webhook_secret text,
    order_confirmation_update_webhook_id bigint
);


--
-- Name: COLUMN stores.backfill_through; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.stores.backfill_through IS 'How far forward the historical backfill has read. Null means it has not started. Resume point for the next run.';


--
-- Name: COLUMN stores.backfill_done; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.stores.backfill_done IS 'True once the backfill has reached the present. From then on only incremental syncs run, keyed on synced_through.';


--
-- Name: whatsapp_abandoned_checkouts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_abandoned_checkouts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    woo_order_id bigint NOT NULL,
    status text DEFAULT 'messaged'::text NOT NULL,
    skip_reason text,
    messaged_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT whatsapp_abandoned_checkouts_status_check CHECK ((status = ANY (ARRAY['messaged'::text, 'skipped'::text])))
);


--
-- Name: whatsapp_broadcast_recipients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_broadcast_recipients (
    broadcast_id uuid NOT NULL,
    customer_key text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    sent_at timestamp with time zone,
    error text,
    chat_id text,
    name text,
    vars jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: whatsapp_broadcasts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_broadcasts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    status text DEFAULT 'sending'::text NOT NULL,
    message jsonb NOT NULL,
    filter jsonb,
    total integer DEFAULT 0 NOT NULL,
    handed_off integer DEFAULT 0 NOT NULL,
    skipped jsonb DEFAULT '{}'::jsonb NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: whatsapp_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_connections (
    user_id uuid NOT NULL,
    base_url text,
    api_key text,
    session_id text,
    session_name text,
    phone text,
    dial_code text,
    send_delay_ms integer DEFAULT 4000 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: whatsapp_enrolments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_enrolments (
    flow_id uuid NOT NULL,
    customer_key text NOT NULL,
    chat_id text,
    step_index integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    orders_at_entry integer DEFAULT 0 NOT NULL,
    enrolled_at timestamp with time zone DEFAULT now() NOT NULL,
    last_sent_at timestamp with time zone,
    due_at timestamp with time zone
);


--
-- Name: whatsapp_flows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_flows (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    definition jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: whatsapp_menu; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_menu (
    user_id uuid NOT NULL,
    tree jsonb DEFAULT '[]'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: whatsapp_opt_outs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_opt_outs (
    user_id uuid NOT NULL,
    phone text NOT NULL,
    reason text,
    opted_out_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: whatsapp_order_confirmations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_order_confirmations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    store_id uuid NOT NULL,
    woo_order_id bigint NOT NULL,
    status text NOT NULL,
    skip_reason text,
    sent_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT whatsapp_order_confirmations_status_check CHECK ((status = ANY (ARRAY['sent'::text, 'skipped'::text])))
);


--
-- Name: whatsapp_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_usage (
    user_id uuid NOT NULL,
    period text NOT NULL,
    sent_count integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE whatsapp_usage; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.whatsapp_usage IS 'Written and read entirely by the server (every WhatsApp send path calls src/lib/billing/usage.ts), no reason for a browser to query this directly.';


--
-- Name: woo_customers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.woo_customers (
    store_id uuid NOT NULL,
    id bigint NOT NULL,
    email text,
    first_name text,
    last_name text,
    username text,
    billing_city text,
    billing_state text,
    billing_country text,
    has_phone boolean DEFAULT false NOT NULL,
    orders_count integer DEFAULT 0 NOT NULL,
    total_spent numeric(14,2) DEFAULT 0 NOT NULL,
    date_created timestamp with time zone,
    date_modified timestamp with time zone,
    raw jsonb NOT NULL,
    synced_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: woo_order_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.woo_order_items (
    store_id uuid NOT NULL,
    order_id bigint NOT NULL,
    id bigint NOT NULL,
    product_id bigint DEFAULT 0 NOT NULL,
    variation_id bigint DEFAULT 0 NOT NULL,
    name text,
    quantity integer DEFAULT 0 NOT NULL,
    subtotal numeric(14,2) DEFAULT 0 NOT NULL,
    total numeric(14,2) DEFAULT 0 NOT NULL,
    order_date timestamp with time zone NOT NULL
);


--
-- Name: woo_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.woo_orders (
    store_id uuid NOT NULL,
    id bigint NOT NULL,
    number text,
    status text NOT NULL,
    currency text,
    total numeric(14,2) DEFAULT 0 NOT NULL,
    discount_total numeric(14,2) DEFAULT 0 NOT NULL,
    shipping_total numeric(14,2) DEFAULT 0 NOT NULL,
    total_tax numeric(14,2) DEFAULT 0 NOT NULL,
    customer_id bigint DEFAULT 0 NOT NULL,
    billing_email text,
    billing_city text,
    billing_state text,
    billing_country text,
    payment_method text,
    date_created timestamp with time zone NOT NULL,
    date_paid timestamp with time zone,
    date_completed timestamp with time zone,
    date_modified timestamp with time zone,
    item_count integer DEFAULT 0 NOT NULL,
    raw jsonb NOT NULL,
    synced_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: woo_products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.woo_products (
    store_id uuid NOT NULL,
    id bigint NOT NULL,
    name text,
    sku text,
    status text,
    type text,
    price numeric(14,2),
    regular_price numeric(14,2),
    stock_quantity integer,
    stock_status text,
    total_sales integer DEFAULT 0 NOT NULL,
    date_created timestamp with time zone,
    date_modified timestamp with time zone,
    raw jsonb NOT NULL,
    synced_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: woo_sync_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.woo_sync_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    store_id uuid NOT NULL,
    mode text NOT NULL,
    status text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    orders_synced integer DEFAULT 0 NOT NULL,
    customers_synced integer DEFAULT 0 NOT NULL,
    products_synced integer DEFAULT 0 NOT NULL,
    error text,
    CONSTRAINT woo_sync_runs_mode_check CHECK ((mode = ANY (ARRAY['full'::text, 'incremental'::text]))),
    CONSTRAINT woo_sync_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'succeeded'::text, 'failed'::text])))
);


--
-- Name: api_keys api_keys_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_hash_key UNIQUE (hash);


--
-- Name: api_keys api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);


--
-- Name: billing_invoices billing_invoices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_invoices
    ADD CONSTRAINT billing_invoices_pkey PRIMARY KEY (id);


--
-- Name: billing_invoices billing_invoices_razorpay_invoice_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_invoices
    ADD CONSTRAINT billing_invoices_razorpay_invoice_id_key UNIQUE (razorpay_invoice_id);


--
-- Name: billing_webhook_events billing_webhook_events_body_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_webhook_events
    ADD CONSTRAINT billing_webhook_events_body_hash_key UNIQUE (body_hash);


--
-- Name: billing_webhook_events billing_webhook_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_webhook_events
    ADD CONSTRAINT billing_webhook_events_pkey PRIMARY KEY (id);


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);


--
-- Name: stores stores_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stores
    ADD CONSTRAINT stores_pkey PRIMARY KEY (id);


--
-- Name: stores stores_user_id_url_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stores
    ADD CONSTRAINT stores_user_id_url_key UNIQUE (user_id, url);


--
-- Name: whatsapp_abandoned_checkouts whatsapp_abandoned_checkouts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_abandoned_checkouts
    ADD CONSTRAINT whatsapp_abandoned_checkouts_pkey PRIMARY KEY (id);


--
-- Name: whatsapp_abandoned_checkouts whatsapp_abandoned_checkouts_user_id_woo_order_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_abandoned_checkouts
    ADD CONSTRAINT whatsapp_abandoned_checkouts_user_id_woo_order_id_key UNIQUE (user_id, woo_order_id);


--
-- Name: whatsapp_broadcast_recipients whatsapp_broadcast_recipients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_broadcast_recipients
    ADD CONSTRAINT whatsapp_broadcast_recipients_pkey PRIMARY KEY (broadcast_id, customer_key);


--
-- Name: whatsapp_broadcasts whatsapp_broadcasts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_broadcasts
    ADD CONSTRAINT whatsapp_broadcasts_pkey PRIMARY KEY (id);


--
-- Name: whatsapp_connections whatsapp_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_connections
    ADD CONSTRAINT whatsapp_connections_pkey PRIMARY KEY (user_id);


--
-- Name: whatsapp_enrolments whatsapp_enrolments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_enrolments
    ADD CONSTRAINT whatsapp_enrolments_pkey PRIMARY KEY (flow_id, customer_key);


--
-- Name: whatsapp_flows whatsapp_flows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_flows
    ADD CONSTRAINT whatsapp_flows_pkey PRIMARY KEY (id);


--
-- Name: whatsapp_menu whatsapp_menu_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_menu
    ADD CONSTRAINT whatsapp_menu_pkey PRIMARY KEY (user_id);


--
-- Name: whatsapp_opt_outs whatsapp_opt_outs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_opt_outs
    ADD CONSTRAINT whatsapp_opt_outs_pkey PRIMARY KEY (user_id, phone);


--
-- Name: whatsapp_order_confirmations whatsapp_order_confirmations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_order_confirmations
    ADD CONSTRAINT whatsapp_order_confirmations_pkey PRIMARY KEY (id);


--
-- Name: whatsapp_order_confirmations whatsapp_order_confirmations_store_id_woo_order_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_order_confirmations
    ADD CONSTRAINT whatsapp_order_confirmations_store_id_woo_order_id_key UNIQUE (store_id, woo_order_id);


--
-- Name: whatsapp_usage whatsapp_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_usage
    ADD CONSTRAINT whatsapp_usage_pkey PRIMARY KEY (user_id, period);


--
-- Name: woo_customers woo_customers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.woo_customers
    ADD CONSTRAINT woo_customers_pkey PRIMARY KEY (store_id, id);


--
-- Name: woo_order_items woo_order_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.woo_order_items
    ADD CONSTRAINT woo_order_items_pkey PRIMARY KEY (store_id, order_id, id);


--
-- Name: woo_orders woo_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.woo_orders
    ADD CONSTRAINT woo_orders_pkey PRIMARY KEY (store_id, id);


--
-- Name: woo_products woo_products_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.woo_products
    ADD CONSTRAINT woo_products_pkey PRIMARY KEY (store_id, id);


--
-- Name: woo_sync_runs woo_sync_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.woo_sync_runs
    ADD CONSTRAINT woo_sync_runs_pkey PRIMARY KEY (id);


--
-- Name: api_keys_active_hash_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX api_keys_active_hash_idx ON public.api_keys USING btree (hash) WHERE (revoked_at IS NULL);


--
-- Name: api_keys_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX api_keys_user_idx ON public.api_keys USING btree (user_id, created_at DESC);


--
-- Name: billing_invoices_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX billing_invoices_user_idx ON public.billing_invoices USING btree (user_id, paid_at DESC);


--
-- Name: profiles_razorpay_subscription_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX profiles_razorpay_subscription_idx ON public.profiles USING btree (razorpay_subscription_id) WHERE (razorpay_subscription_id IS NOT NULL);


--
-- Name: stores_one_active_per_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX stores_one_active_per_user_idx ON public.stores USING btree (user_id) WHERE is_active;


--
-- Name: stores_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX stores_user_idx ON public.stores USING btree (user_id);


--
-- Name: whatsapp_abandoned_checkouts_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX whatsapp_abandoned_checkouts_lookup_idx ON public.whatsapp_abandoned_checkouts USING btree (user_id, woo_order_id);


--
-- Name: whatsapp_broadcast_recipients_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX whatsapp_broadcast_recipients_pending_idx ON public.whatsapp_broadcast_recipients USING btree (broadcast_id) WHERE (status = 'pending'::text);


--
-- Name: whatsapp_broadcasts_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX whatsapp_broadcasts_user_idx ON public.whatsapp_broadcasts USING btree (user_id, created_at DESC);


--
-- Name: whatsapp_enrolments_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX whatsapp_enrolments_due_idx ON public.whatsapp_enrolments USING btree (due_at) WHERE ((status = 'active'::text) AND (due_at IS NOT NULL));


--
-- Name: whatsapp_flows_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX whatsapp_flows_user_idx ON public.whatsapp_flows USING btree (user_id, created_at DESC);


--
-- Name: whatsapp_order_confirmations_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX whatsapp_order_confirmations_lookup_idx ON public.whatsapp_order_confirmations USING btree (store_id, woo_order_id);


--
-- Name: woo_customers_email_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX woo_customers_email_idx ON public.woo_customers USING btree (store_id, lower(email));


--
-- Name: woo_customers_spent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX woo_customers_spent_idx ON public.woo_customers USING btree (store_id, total_spent DESC);


--
-- Name: woo_order_items_product_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX woo_order_items_product_idx ON public.woo_order_items USING btree (store_id, product_id, order_date DESC);


--
-- Name: woo_orders_billing_phone_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX woo_orders_billing_phone_idx ON public.woo_orders USING btree (store_id, TRIM(BOTH FROM ((raw -> 'billing'::text) ->> 'phone'::text)), date_created DESC) WHERE (NULLIF(TRIM(BOTH FROM ((raw -> 'billing'::text) ->> 'phone'::text)), ''::text) IS NOT NULL);


--
-- Name: woo_orders_store_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX woo_orders_store_created_idx ON public.woo_orders USING btree (store_id, date_created DESC);


--
-- Name: woo_orders_store_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX woo_orders_store_customer_idx ON public.woo_orders USING btree (store_id, customer_id) WHERE (customer_id > 0);


--
-- Name: woo_orders_store_modified_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX woo_orders_store_modified_idx ON public.woo_orders USING btree (store_id, date_modified DESC NULLS LAST);


--
-- Name: woo_orders_store_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX woo_orders_store_status_idx ON public.woo_orders USING btree (store_id, status);


--
-- Name: woo_products_stock_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX woo_products_stock_idx ON public.woo_products USING btree (store_id, stock_status);


--
-- Name: woo_sync_runs_store_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX woo_sync_runs_store_idx ON public.woo_sync_runs USING btree (store_id, started_at DESC);


--
-- Name: profiles profiles_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER profiles_touch BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: stores stores_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER stores_touch BEFORE UPDATE ON public.stores FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: whatsapp_broadcasts whatsapp_broadcasts_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER whatsapp_broadcasts_touch BEFORE UPDATE ON public.whatsapp_broadcasts FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: whatsapp_connections whatsapp_connections_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER whatsapp_connections_touch BEFORE UPDATE ON public.whatsapp_connections FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: whatsapp_flows whatsapp_flows_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER whatsapp_flows_touch BEFORE UPDATE ON public.whatsapp_flows FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: whatsapp_menu whatsapp_menu_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER whatsapp_menu_touch BEFORE UPDATE ON public.whatsapp_menu FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: api_keys api_keys_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: billing_invoices billing_invoices_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_invoices
    ADD CONSTRAINT billing_invoices_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: profiles profiles_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: stores stores_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stores
    ADD CONSTRAINT stores_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: whatsapp_abandoned_checkouts whatsapp_abandoned_checkouts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_abandoned_checkouts
    ADD CONSTRAINT whatsapp_abandoned_checkouts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: whatsapp_broadcast_recipients whatsapp_broadcast_recipients_broadcast_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_broadcast_recipients
    ADD CONSTRAINT whatsapp_broadcast_recipients_broadcast_id_fkey FOREIGN KEY (broadcast_id) REFERENCES public.whatsapp_broadcasts(id) ON DELETE CASCADE;


--
-- Name: whatsapp_broadcasts whatsapp_broadcasts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_broadcasts
    ADD CONSTRAINT whatsapp_broadcasts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: whatsapp_connections whatsapp_connections_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_connections
    ADD CONSTRAINT whatsapp_connections_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: whatsapp_enrolments whatsapp_enrolments_flow_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_enrolments
    ADD CONSTRAINT whatsapp_enrolments_flow_id_fkey FOREIGN KEY (flow_id) REFERENCES public.whatsapp_flows(id) ON DELETE CASCADE;


--
-- Name: whatsapp_flows whatsapp_flows_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_flows
    ADD CONSTRAINT whatsapp_flows_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: whatsapp_menu whatsapp_menu_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_menu
    ADD CONSTRAINT whatsapp_menu_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: whatsapp_opt_outs whatsapp_opt_outs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_opt_outs
    ADD CONSTRAINT whatsapp_opt_outs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: whatsapp_order_confirmations whatsapp_order_confirmations_store_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_order_confirmations
    ADD CONSTRAINT whatsapp_order_confirmations_store_id_fkey FOREIGN KEY (store_id) REFERENCES public.stores(id) ON DELETE CASCADE;


--
-- Name: whatsapp_order_confirmations whatsapp_order_confirmations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_order_confirmations
    ADD CONSTRAINT whatsapp_order_confirmations_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: whatsapp_usage whatsapp_usage_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_usage
    ADD CONSTRAINT whatsapp_usage_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: woo_customers woo_customers_store_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.woo_customers
    ADD CONSTRAINT woo_customers_store_id_fkey FOREIGN KEY (store_id) REFERENCES public.stores(id) ON DELETE CASCADE;


--
-- Name: woo_order_items woo_order_items_store_id_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.woo_order_items
    ADD CONSTRAINT woo_order_items_store_id_order_id_fkey FOREIGN KEY (store_id, order_id) REFERENCES public.woo_orders(store_id, id) ON DELETE CASCADE;


--
-- Name: woo_orders woo_orders_store_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.woo_orders
    ADD CONSTRAINT woo_orders_store_id_fkey FOREIGN KEY (store_id) REFERENCES public.stores(id) ON DELETE CASCADE;


--
-- Name: woo_products woo_products_store_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.woo_products
    ADD CONSTRAINT woo_products_store_id_fkey FOREIGN KEY (store_id) REFERENCES public.stores(id) ON DELETE CASCADE;


--
-- Name: woo_sync_runs woo_sync_runs_store_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.woo_sync_runs
    ADD CONSTRAINT woo_sync_runs_store_id_fkey FOREIGN KEY (store_id) REFERENCES public.stores(id) ON DELETE CASCADE;


CREATE TRIGGER on_user_created
    AFTER INSERT ON public.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
