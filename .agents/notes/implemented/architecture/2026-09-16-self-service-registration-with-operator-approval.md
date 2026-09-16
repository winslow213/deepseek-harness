# Agent Note: Self-service registration gated by operator approval

Status: implemented

English | [中文](2026-09-16-self-service-registration-with-operator-approval.zh.md)

## Problem

Creating a team-shell account required an operator on the host: `account-cli create-user <username> <password>` against the account database. At 25 accounts that is an interruption per joiner, and the account name was whatever the operator typed, so it drifted from the member's email address.

A public registration form is the obvious fix and the obvious hazard. On this deployment the entry host is reachable from the LAN by anyone, so a form that creates an account on submit hands account creation to every person who can resolve the address — and this account is the credential for an instance that holds the team's LLM key, a private workspace, and a wiki. Registration therefore has to be **request-then-approve**, with no account existing in between.

The second constraint is the notification channel itself. The account service runs on a LAN host and the Feishu cloud cannot call back into it, so the interactive-card approval button — the button that would make this a two-tap flow — is not available. An approval link the operator opens is the only mechanism that reaches the operator without inbound reachability.

## Decision

**Split registration into a sessionless request and an operator decision, with the decision authorized by a single-use link token.**

`GET /register` serves the form from the account service rather than the proxy, so the accepted-domain list and the issued password have one home and are shown truthfully on the page. `POST /api/register` records the request in `dsh_registrations`, derives the account name from the address, and sends the operator one Feishu message. Nothing is created until the operator decides.

The account name is the email local part, lowercased, with characters that cannot appear in a `DSH_HOME` directory replaced by `.`. The name is also the `user_id` and the directory under `DSH_USERS_ROOT`, so `deriveUsername` rejects anything that could not be a safe path component — a leading separator, an empty result, a `..` after normalization — and the applicant never chooses it.

**Deciding is a POST, never a GET.** A GET-only approval link is approved by any link prefetcher, chat client that unfurls URLs, or mail scanner that fetches it; against a Feishu notification that is not a hypothetical. `GET /approve?token=…` only renders the decision page; `POST /api/approvals` spends the token. The token itself is 256 bits, stored only as a SHA-256 hash, and never compared in cleartext.

**The token is spent by the decision, inside the same transaction as the account insert.** One conditional `UPDATE … WHERE token_hash = $1 AND status = 'pending' … RETURNING *` claims the row; if it matches nothing the request is already decided or expired. The account insert runs in that transaction, so a replay, a double-submitted form, or two concurrent approvals of the same link cannot produce two accounts, and a failed insert leaves the request pending instead of burning the operator's link. `decide` is covered for exactly that: two concurrent approvals of one token create one account.

**The domain allowlist is enforced before the notification, not after.** `TEAM_REGISTRATION_DOMAINS` (comma-separated, default `quectel.com`) is checked in the request path, so an address outside it never reaches the operator's Feishu — otherwise the notification channel is the spam target and the human is the rate limit.

**A failed notification is its own status, not a rejection.** `notify_failed` rows are excluded from the partial unique indexes that allow one open request per address and per account name, so the applicant can retry the same address; the alternative — recording `pending` before the send — would lock the address behind a message nobody saw. The service still boots without a Feishu integration and logs one error: refusing to start would take login away from the 25 existing accounts for a feature none of them use.

**Credentials come from the operator's existing `dsh-feishu` integration.** The app id and owner open id are read from `$DSH_USERS_ROOT/winslow/integrations/dsh-feishu/config.json` and the app secret through its `secretRef` in `.credentials.yaml`, with `TEAM_FEISHU_*` overriding the whole lookup. The service already runs as the operator, so this needed no new grant; the `.credentials.yaml` reader is a targeted line scan of the top-level `refs:` map rather than a YAML dependency the account service would otherwise not need.

**Password change became a real HTTP surface.** Approval issues a shared default (`TEAM_DEFAULT_PASSWORD`, `quectel@123`) that every approved member knows, so the account is only as private as the first login. `GET /password` and `POST /api/me/password` re-check the current password before replacing it, so a stolen session cookie alone cannot take over an account. Until now the only way to change a password was the operator's `account-cli reset-password`.

## Alternatives considered

**Feishu interactive-card approval buttons with a webhook callback.** The best interaction and unavailable: Feishu's cloud cannot reach an address inside this LAN, and exposing the account service to the internet to obtain two-tap approval trades a LAN-only deployment for a public one. Recorded because it becomes correct the day the entry host is published under TLS.

**A notification-only message with the decision made by `account-cli`.** Fewer moving parts and it was the operator's second choice. It loses on frequency: the point of the change is that joining stops requiring host access, and a CLI decision puts the operator back on the host for every join.

**Approving in a GET.** Simplest link, and rejected outright — see above. The cost is one extra button press; the benefit is that fetching the notification URL is not a privileged operation.

**Deriving the account name from a form field.** Rejected: the name is a `DSH_HOME` directory and a `user_id`, so letting the applicant choose it means validating an arbitrary path component and accepting names that do not match the address the operator is approving.

**Auto-approving on a valid company-domain address.** Rejected by the operator: the domain proves where the mail is addressed, not that the applicant is entitled to an account.

## Consequences

Joining no longer needs host access: an applicant submits an email address, the operator approves from Feishu, and the account exists with the shared default password, which the member then changes at `/password`. `deriveUsername`, the domain and email validation, the notification text, and the credential resolution are unit-covered; the request, duplicate, retry, approval, rejection, replay, concurrency, and expiry paths run against the real schema — the conditional `UPDATE`, the partial unique indexes, and the transaction are the behaviour under test, so a fake query layer would not have exercised them.

**The approval link is only as reachable as the entry host.** `TEAM_ENTRY_BASE_URL` must name an address the operator's browser can open from Feishu; the default is `http://$DSH_ENTRY_HOST:3999`. An operator on a phone without the corporate network cannot approve, and the message gives no hint of that.

**Registration shares the entry host's plaintext HTTP.** The form and the approval link carry no credential beyond the token, but they travel unencrypted on the LAN like the login form already does. Publishing the entry host under TLS fixes both.

**The registration page states the shared default password.** That is deliberate — the applicant has to know what to log in with, and there is no per-applicant delivery channel (no member email address is verified). It makes the first login a shared secret rather than a private one, which is why `/password` exists in the same change.

**Token lifetime and the pending table need no sweeper.** An unused link simply expires against `created_at`, and the row stays for audit; `dsh_registrations` grows by a row per application, so no reclaim path was built.
