# Agent Note: Trusted hosts reach the browser privileged surface

Status: implemented

## Problem

The dsh web UI keeps settings persistence and file-open behind a loopback-only
check: `connection.isLoopback` derives from the page URL hostname, so a LAN
deployment (bind `0.0.0.0`, reached by an IP literal) leaves every settings
surface in the terminal `unavailable` state — "settings are unavailable in
this browser" — even though the /api Host fence already admits the same
authority through `trustedHosts`.

## Decision

Extend the browser privileged-surface classification to trust the deployment's
own `trustedHosts` list, mirroring the /api Host fence. The Host connection
plugin injects `trustedHosts` into the page as `globalThis.__DSH_TRUSTED_HOSTS__`
(an index-injection global row); the browser connection client classifies the
page authority as privileged when it is loopback, the transport owns the host,
or its hostname matches a trusted entry (port-less entries match any port).

Trust follows the same list the /api fence already enforces: a page that can
reach the authenticated /api channel against a trusted Host is the same page
whose settings requests the fence admits. No new authority is introduced.

A browser-safe `isTrustedPageAuthority` classifier in
`packages/client/connection/src/trusted-hostname.ts` mirrors the Host-side
`isTrustedAuthority` entry semantics.
