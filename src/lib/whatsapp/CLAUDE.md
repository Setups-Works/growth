# src/lib/whatsapp — orientation for AI agents

Everything here talks to the WhatsApp engine running inside this Next.js
server (`engine/`, Baileys) — one linked-device session per account, never a
third-party messaging API. See `AGENTS.md`. The gotchas below are specific to
this directory.

## config.ts is per-tenant. It must stay that way.

Every exported function takes `userId` as a real parameter, and an account's
engine session id *is* its user id. `readWhatsAppConfig(userId)` returns null
only when WhatsApp is disabled (`WHATSAPP_DISABLED=true`); non-null
does not mean a number is linked — check the session before sending. A config
helper with no id parameter in a multi-tenant app has no way to be correct
(see `AGENTS.md` § "Known-shape bug").

## client.ts → engine/

`client.ts` (`WhatsAppClient`) is the only way routes reach the engine, always
with the caller's own session id. It imports `engine/` lazily so the protocol
library never lands in a browser bundle. The engine keeps sockets in a
`globalThis` registry (one per process — run a single app instance) and
`src/instrumentation.ts` reconnects linked accounts at server start.

`isSessionSendable(session)` is the one gate every send path checks before
calling `sendText`/`sendImage`/`sendVideo`/`sendBulk`. `ensureSendable()`
restarts a session whose pairing is on disk but whose socket is down (e.g.
right after the engine restarts) and waits briefly for it. Don't add a second
path that sends without going through this check.

## phone.ts — conservative on purpose

`normalisePhone` returns `null` far more often than it guesses. This is
deliberate: a recipient dropped for being unparseable is recoverable (it
shows up as a skip, with a reason); a message sent to a re-normalised wrong
number is not. If you're tempted to make this "smarter" for one store's
number format, check whether that assumption holds for every other
connected store first — it almost certainly doesn't.

## opt-out.ts — enforced at send time, not in the UI

The opt-out list is checked server-side, after the audience is resolved,
inside every send path (broadcast, flow step, abandoned-checkout reminder,
assistant-approved send) — never as a UI-only filter. If you add a new way
to send a message to a WhatsApp number, it must check this list itself; there
is no shared middleware that does it for you, only the discipline of every
existing send path checking it explicitly.

## recipients.ts / broadcast.ts / flows.ts

`resolveAudience` (recipients.ts) is the only place a filter becomes an
actual phone number — the browser never sends or receives numbers, only a
filter and a `customerKey`. Broadcasts and flows both re-resolve the
audience at send time rather than trusting a count computed earlier (see
`README.md` § Broadcast pipeline for why: "the audience changed" must refuse
the send, not silently send to a stale list).

## menu.ts, templates.ts, schema.ts, errors.ts

Smaller, more self-explanatory. `templates.ts`'s `TemplateVariables` shape is
about a customer's past purchase history for a campaign message — it is a
different shape from a one-off transactional message (like the
abandoned-checkout reminder), which deliberately does not reuse it. Don't
force the two together; they answer different questions.
