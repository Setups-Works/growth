-- Restores the shared analytics-result cache read and written by
-- src/lib/analytics/shared-cache.ts. The baseline (0001) omitted it by mistake.
--
-- One row per (store version, date range, granularity): the full computed
-- analytics result, gzipped. A hit replaces reading every order and
-- re-deriving RFM, cohorts and forecasts with a single-row read, which is what
-- keeps the dashboard fast after a restart and across many date ranges.
--
-- store_id is nullable: the writer keys rows by a hash of the store URL and
-- sync time, and old rows are swept by age (sweepShared, run after each sync).

CREATE TABLE IF NOT EXISTS public.analytics_cache (
    key text PRIMARY KEY,
    store_id uuid REFERENCES public.stores(id) ON DELETE CASCADE,
    payload bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS analytics_cache_created_idx ON public.analytics_cache (created_at);

-- The payload is already gzipped; don't spend CPU trying to compress it again.
ALTER TABLE public.analytics_cache ALTER COLUMN payload SET STORAGE EXTERNAL;
