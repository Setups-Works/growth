-- Safe sending: per-account limits for the WhatsApp engine's anti-ban guard
-- (src/lib/whatsapp/engine/guard.ts).

ALTER TABLE public.whatsapp_connections
    -- Most marketing messages (campaigns + flows) per rolling 24 hours, once
    -- the number is past its warm-up period.
    ADD COLUMN IF NOT EXISTS daily_limit integer NOT NULL DEFAULT 300,
    -- Local hours (WHATSAPP_TIMEZONE) when marketing waits, e.g. 21 → 9.
    -- Both null turns quiet hours off.
    ADD COLUMN IF NOT EXISTS quiet_start smallint DEFAULT 21,
    ADD COLUMN IF NOT EXISTS quiet_end smallint DEFAULT 9,
    -- Append "Reply STOP to unsubscribe" to marketing messages.
    ADD COLUMN IF NOT EXISTS opt_out_footer boolean NOT NULL DEFAULT true,
    -- When this number was first linked; drives the warm-up schedule.
    ADD COLUMN IF NOT EXISTS linked_at timestamp with time zone;

-- What kind of send each outgoing message was, so limits can count only
-- marketing: 'marketing' | 'transactional' | 'reply'. Null for inbound.
ALTER TABLE public.wa_messages ADD COLUMN IF NOT EXISTS kind text;

CREATE INDEX IF NOT EXISTS wa_messages_outbound_kind_idx
    ON public.wa_messages (session_id, kind, created_at DESC)
    WHERE from_me;
