-- Customers are downloaded after the order history (orders matter first for
-- the dashboard). This records whether that full customer pass has finished,
-- so it runs exactly once and later syncs only fetch recent changes.
ALTER TABLE public.stores
    ADD COLUMN IF NOT EXISTS customers_complete boolean NOT NULL DEFAULT false;
