# Agent Note: Splitting the KB surface into retrieval, synthesis, and page reads

Status: implemented

English | [中文](2026-10-29-team-shell-kb-tool-split.zh.md)

## Problem

The `kb_search` tool shipped as a single blocking call that always synthesized: it opened a KB session, submitted a query job, and waited 30-130s for the KB server's own LLM passes to finish. That is the wrong shape for the common case. A model asking "does the KB mention NNRt?" had to pay for synthesis before seeing any evidence, and only the model can judge whether the evidence it gets back is enough. A second problem showed up in the same shape: a retrieval-only question could not be answered at all when the KB server's synthesis backend was degraded, even though the retrieval index behind it was healthy and cheap to read.

## Decision

**Three tools, split by what they cost.** `shell/src/remote/kb-tool.ts` now registers `kb_search` (retrieval only, about one second), `kb_answer` (synthesis, 30-130s), and `kb_document` (read one page in full).

**`kb_search` reads the KB server's open read surface instead of opening a session.** It issues `GET /api/kb/search` for hits and one `GET /api/kb/document` per selected page, so it needs no session, no job, and no agent token — and it keeps working when the synthesis path is down. Pages are deduplicated by `(path, heading)` and the per-page budget counts pages, not sections, because one file contributes several windowed hits.

**A cosine floor turns an on-topic-looking but irrelevant result into an explicit "no confident match".** Hits below `minCosine` (default 0.6) are dropped individually rather than only checking the best one, so a page that matched on a generic word cannot ride in beside a genuinely good hit. When nothing survives, the tool returns `covered: false` with a note saying the query did not match — not that the KB is silent — and pointing at `kb_answer`. Recording that distinction matters: the wrong reading of an empty result sends the model to rephrase forever or to conclude the KB has no such content.

**`kb_answer` keeps the session-plus-job path, now with a promise cache that a failed handshake cannot poison.** The cached handle is a `Promise<string>` rather than a resolved id, so two concurrent calls share one handshake; a rejection clears the cache so one bad handshake does not fail every later call for the process lifetime. A `SessionExpiredError` (the server's 404 for a session that outlived its 24h TTL) clears the cache, rebuilds once, and retries the same query.

**Result keys are coerced before they reach the tool's output schema.** The framework rejects a result whose required keys are `undefined` with "value is not lossless JSON". A model answering in Chinese was observed once producing `{使用文档, 引用文档, 答案}` over a 138-second run, so `kb_answer` reads `answer`/`citations`/`used_docs` and falls back to their Chinese spellings rather than failing a long job at the last step.

## Alternatives considered

**One tool with a `mode` parameter (`retrieve` | `synthesize`).** Rejected: tool descriptions are what the model reads when deciding whether to call, and one description cannot say "this is cheap, call it freely" and "this costs minutes" at once. Two separately described tools make the cost visible at decision time, and the model is the only party that can decide when retrieval was enough.

**Falling back to `kb_answer` automatically when `kb_search` finds nothing above the floor.** Rejected: it would silently convert a one-second call into a two-minute one, which is exactly the surprise the split exists to remove. The `covered: false` note names `kb_answer` instead, so escalation stays the model's decision.

**Keeping a resolved session id and refreshing it on a timer.** Rejected: a timer would renew sessions that no call is using, and the expiry is only observable at the next request anyway. Rebuilding on the server's own `SessionExpiredError` costs one extra round trip in the rare expiry case and nothing in the common one.

## Consequences

`kb_search` no longer needs the account's agent token, so the token's only consumers are now `kb_answer`'s session and query calls; the token stays per-account for the attribution reason the previous note records. `shell/tests/kb-tool.spec.ts` is rewritten around a fake server implementing both the read surface and the session-plus-job surface: it covers all three registrations, retrieval with no session opened, the cosine floor, a full page read, the synthesis path, the bearer header present and absent, session caching, expiry rebuild, job-failure surfacing, and non-`Error` abort-reason wrapping. `injectKbSearch`'s generated home-patch comment now names all three tools; the patch block's id and file layout are unchanged, so an existing home picks the new file up on its next provision. The home patch loads only at startup (`patchReload: startup`), so an instance already running keeps the previous copy until it restarts.
