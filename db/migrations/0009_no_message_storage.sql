-- WhatsApp messages are no longer stored (see src/lib/whatsapp/engine/store.ts).
-- The shared inbox is gone; incoming messages are read once for opt-outs and
-- the menu bot and then dropped. wa_messages now only holds a content-free row
-- per message the account sent — no text, no recipient — because the
-- safe-sending guard counts recent sends to enforce its daily and hourly caps.
--
-- This removes what was stored before: every incoming message, the text and
-- recipient of every sent one, and anything older than the guard's look-back.

delete from public.wa_messages where not from_me;

delete from public.wa_messages where created_at < now() - interval '2 days';

update public.wa_messages
   set chat_id = '', body = '', sender = null, push_name = null, type = 'sent';

drop index if exists public.wa_messages_chat_idx;
drop index if exists public.wa_messages_recent_idx;

comment on table public.wa_messages is
  'Content-free send log for the safe-sending guard: one row per message sent, no text or recipient, pruned after 2 days.';
