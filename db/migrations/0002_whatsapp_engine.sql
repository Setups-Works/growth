-- Storage for the bundled WhatsApp engine (whatsapp/), which replaces the
-- external self-hosted gateway. One session per account; `session_id` is the
-- account's user id. Login credentials themselves live on the engine's own
-- volume, never here.

-- Every message the engine sees or sends, for the shared inbox.
CREATE TABLE public.wa_messages (
    session_id text NOT NULL,
    wa_message_id text NOT NULL,
    chat_id text NOT NULL,
    from_me boolean NOT NULL,
    sender text,
    push_name text,
    type text NOT NULL,
    body text NOT NULL DEFAULT '',
    "timestamp" bigint NOT NULL,
    status text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (session_id, wa_message_id)
);

CREATE INDEX wa_messages_chat_idx ON public.wa_messages (session_id, chat_id, "timestamp" DESC);
CREATE INDEX wa_messages_recent_idx ON public.wa_messages (session_id, "timestamp" DESC);

-- Per-session engine plugins. Today: the `chat-flow` menu bot.
CREATE TABLE public.wa_plugins (
    session_id text NOT NULL,
    plugin_id text NOT NULL,
    config jsonb NOT NULL DEFAULT '{}'::jsonb,
    enabled boolean NOT NULL DEFAULT false,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (session_id, plugin_id)
);

-- The gateway URL and key are no longer configured per account: the engine is
-- part of the deployment. The columns stay for compatibility but are unused.
COMMENT ON COLUMN public.whatsapp_connections.base_url IS 'Unused since the bundled engine (0002).';
COMMENT ON COLUMN public.whatsapp_connections.api_key IS 'Unused since the bundled engine (0002).';
