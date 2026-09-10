# Agent Note: A2UI tool share tokens

Status: implemented

English | [中文](2026-09-10-a2ui-share-tokens.zh.md)

## Problem

A saved A2UI tool lived only in the author's own store directory. On a team service, each user's runtime owns an isolated `<harness home>/a2ui-tools/`, so a tool one user authored could not reach a teammate: there was no way to hand the page from one store to another without re-authoring it in a message and asking the recipient to export it again.

## Decision

A saved tool is shared as a self-contained bearer token: one URL-safe string that carries the tool's name and canonical page, with no server-side store. The recipient imports the token and their deployment re-canonicalizes and persists the page.

- **The token.** `encodeA2uiShareToken(name, page)` emits `a2ui-share:<base64url>` where the payload is a versioned JSON envelope `{ v: 1, name, page }`. `decodeA2uiShareToken(token)` rejects a missing prefix, empty or oversized payload, undecodable base64, a non-object payload, an unsupported version, an unsafe name, a missing page, and any page that fails `canonicalizeA2uiPage`. The token is the import boundary, so every field is re-validated exactly as a model-authored page is.
- **Store verbs.** `ctx.a2uiStore` gains `share(name)` (encode a saved tool) and `import(token)` (decode and persist). The Remote namespace exposes `a2uiStore/share` and `a2uiStore/import`, with `a2ui-store/not-found` for an unknown name and `a2ui-store/invalid-token` for a malformed token.
- **Model tools.** `a2ui_share(name)` returns the token; `a2ui_import(token)` imports it. Neither touches session state, so neither requires an owning agent — they are pure store operations like the sidebar list/remove.
- **Sidebar.** Each saved-tool row gains a share button that copies the token to the clipboard; a top import input pastes a token and reloads the list. Share/import are locale-owned copy.

## Alternatives considered

**Server-backed short token.** Store shares on the team service and mint a short opaque token. Rejected for now: the token must survive across isolated per-user runtimes with no cross-runtime store in place, and a self-contained token needs no server change. A server-backed share store can be layered on later without changing the import surface.

**Reuse `a2ui_export` with a paste-and-import page.** Rejected: export writes to the local store only; it gives no way to move the page to a different user, and a separate share verb keeps the "save for me" and "share to you" intents distinct.

**Sign the token against a shared secret.** Rejected: there is no shared secret across the isolated runtimes, and the page is already a canonicalized, declarative document — the same trust level a model-authored page carries — so re-canonicalization, not a signature, is the safety boundary.

## Consequences

A tool can move from one user's store to another's by pasting a single token. The token is a bearer value: anyone who holds it can import the page, and there is no revocation or expiry — the same confidentiality a copied page already has. Import replaces any same-named tool. Tokens are bounded to 1 MiB of encoded payload and never exceed what a model-authored page can already contain, so a hostile token can only degrade to an import failure.
