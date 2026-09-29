# Agent Note: Member-to-member message channel over a Redis transport with a Postgres archive

Status: implemented

English | [中文](2026-09-20-team-member-message-channel.zh.md)

## Problem

The members of a team-shell deployment each own an isolated `dsh` instance, and nothing carries a message from one member to another: the reverse proxy's account mode maps a browser session only to that member's own instance port, and the hub routes only to a member's own agent. Handing work to a teammate has no path at all, and the browser has no surface that shows messages from anyone but the current session's owner.

## Decision

The account service owns the capability, and `MessageStore` (`shell/src/account/messages.ts`) splits it across two stores: Redis is the transport that holds undelivered messages, Postgres only archives what a fetch has consumed.

A send writes one JSON entry onto two per-user Redis lists — the recipient's inbox `dsh-msg:inbox:<user>` and the sender's own sent log `dsh-msg:sent:<user>` — each carrying a 90-day TTL. A fetch drains both of the caller's lists, archives everything drained in send order, and returns the recent archive over every thread the caller appears in; the sent log exists so a message is archived even when its recipient never fetches.

The drain is one LUA script that runs `LRANGE` and `DEL` in a single execution (`DRAIN_LUA`), so two overlapping fetches neither lose a message in the gap between the read and the delete nor deliver one twice.

Archiving is idempotent per message id: `dsh_messages.msg_id` is `UNIQUE` and the insert is `ON CONFLICT (msg_id) DO UPDATE SET read_at = COALESCE(dsh_messages.read_at, EXCLUDED.read_at)`. The recipient's drain is the one that sets the read stamp, the sender's drain archives without it, and whichever of the two runs second only fills in a stamp the first left null — so both converge on one row without unreading a message.

`nextSendTs()` keeps send order equal to timestamp order: one account-service process writes every send and the value is strictly increasing, `+1` on a shared millisecond, so the view ordered by `created_at DESC, seq DESC` is stable across messages that share a wall-clock instant.

## HTTP surface

Four paths on the account service carry the capability, and the reverse proxy forwards them straight to it so they never route to a member instance:

- `POST /api/messages` with `{to, body}` — send. The recipient must be an active account.
- `GET /api/messages?limit=` — drain and return the caller's recent messages (default 200, maximum 500), oldest first.
- `GET /api/messages/contacts` — the active-member directory for the recipient picker.
- `GET /inbox` — the message center page; a request without a session is redirected to `/`.

One helper resolves the caller for all of them: `messageCaller` checks an `Authorization: Bearer` header against `dsh_users.agent_token` (`UserStore.findByAgentToken`) and yields `kind: 'agent'`, otherwise it falls back to the session cookie and yields `kind: 'text'`. Sender identity and `kind` are therefore derived from the credential and never accepted from the request body, so a client cannot claim to be someone else or to be an agent.

A send is refused when the body is blank or longer than `MAX_BODY_CHARS` (65536) — checked before the rate counter increments — and when the sender has passed `SENDS_PER_MINUTE` (60) in the current minute, counted by Redis `INCR` with a 60-second `EXPIRE` on `dsh-msg:rl:<user>`. The send endpoint also raises its request-body ceiling to `MAX_MESSAGE_BODY_BYTES` (256 KiB), because one accepted message exceeds the generic 16 KiB request cap once encoded.

## Browser surface

`inboxPage` (`shell/src/team-pages.ts`) renders the message center as one self-contained document: a contact sidebar ordered by recent activity, a thread pane, and a composer, refreshed by a 10-second poll of the API. Every dynamic value is inserted with `textContent`, so a message body cannot render as HTML.

The settings entry lives in `@deepseek-ai/dsh-client-ui-team-account` as a General row (`team-message-center`, order 98) beside the existing pairing-code, idle-exempt, and sign-out rows. It opens `/inbox` in a new tab, so the conversation the member is in stays intact, and it renders only while the document carries the `<meta name="team-shell">` marker those rows already gate on.

## Alternatives considered

**Writing each message to the Postgres table on send.** Rejected: with every member reading through one table, sends and fetches contend on the same rows and index entries, and each fetch must mark rows read — a hot update path over the same records. Per-user Redis keys contend with nothing, and consumption as deletion leaves no residue to expire or reconcile.

**A cross-user route inside the reverse proxy.** Rejected: the proxy's account mode maps a session to that member's own instance port, so a member-to-member route would be a second, unrelated routing rule inside a component whose job is proxying to one instance. The account service already owns identity and persistence, and the proxy already forwards a fixed account-endpoint list.

**A separate `POST /api/messages/ack` endpoint.** Rejected: a fetch already consumes the message and archives it, so a separate acknowledgement would add a delivered-but-unacked state that nothing needs; the read stamp is written by the same drain that removes the entry.

**Delivering into the recipient's instance instead of, or alongside, the inbox.** Rejected for this phase: injecting into another member's instance raises its own injection semantics and prompt-boundary question, and the browser half does not need it. `dsh_messages.delivered_at` stays reserved for that consumer.

**A WebSocket or server-sent push instead of polling.** Rejected: the entry host serves self-contained pages that open no long-lived connection, and a 10-second poll is enough for a 40-member internal tool whose messages are not latency-critical.

## Consequences

The hot path never touches Postgres, so member traffic cannot contend on the archive, and a consumed message leaves Redis entirely — there is no unread state to reconcile. The archive is the only durable history: undrained entries expire after 90 days, a member who never fetches loses their inbox entries at that point, and the browser learns about new messages up to 10 seconds late because the page polls rather than being pushed to.

## Testing

`shell/tests/messages.spec.ts` covers the store against real Redis and Postgres — drain before archive, both drains converging on one row, send order across both directions, blank and oversized bodies rejected without spending rate budget, and the per-minute limit — and skips when `TEAM_DB_URL`/`TEAM_REDIS_URL` are unset, since those targets are operator-local. Its second suite pins the four forwarded routes: each must answer its own credential check (401, or the `/inbox` redirect) rather than the router's `no route for` 404, which is what a missing dispatch returns.

## Related

`shell/message-channel-design.md` records the design, the Phase 2 agent-to-agent injection plan, and the decisions still open with the operator.