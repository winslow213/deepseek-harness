# Agent Note: Keep-alive instances for accounts with a bound IM bot

Status: implemented

English | [中文](2026-09-17-keep-alive-instances-for-bot-connected-accounts.zh.md)

## Problem

An instance is what a member's IM bot talks to: the bot's agent, workspace, and session all live inside it. Instances start only on login (`handleLogin` → `lifecycle.ensure`), and every one of them dies with the account service that spawned it. So a stop-and-start for a code update takes every bot offline, and nothing brings them back until each member happens to open the Web UI.

[The idle-reclaim whitelist](../feature/2026-09-16-idle-reclaim-whitelist.md) added `idle_exempt` so an operator could mark an account as "meant to stay running", and `restoreKeptAlive` restarts those at service start. Two gaps remained.

The first is that the restore runs exactly once. An instance that dies for any reason after boot — a crash, an OOM kill, a logout — is never restarted, so the flag's promise holds only until the first failure. This was observed directly: `darcy` was marked exempt, its instance died minutes later, and the account stayed cold with its bot offline.

The second is that `idle_exempt` is a manual list. An account whose member connected a bot is already a case of "must stay running" — the bot is unreachable without an instance — but the operator has to know to restate that as a second, unrelated fact. `anders` ran a WeChat bot and was never marked exempt, so nothing kept it up.

Diagnosing either failure was also impossible. `spawnUserInstance` accumulates the child's stderr into a local variable and prints it only if the URL does not appear within 30 seconds, so an instance that exits later leaves no reason anywhere in the logs.

## Decision

**The keep-alive set is the union of `idle_exempt` and "has a bound IM bot", recomputed every sweep.**

`listBotConnectedUsers` (`shell/src/spawn-user.ts`) derives the second half from disk, not from the database, because the bot binding is owned by `@xmanrui/dsh-im`, which has no row in the account service's schema. For each account it reads every directory under `integrations/` and treats one as bot-bound when either `config.json` or `workspaces.json` carries a non-empty entry — both count, because `config.json` alone covers a bot registered in a session that has since ended and `workspaces.json` alone covers a config layout this check does not recognize. The bot list is found by looking for any top-level non-empty array or string-valued mapping rather than by naming the field, because each channel declares its own config type (`bots` on feishu, `accounts` on weixin) or none at all.

**`InstanceManager.keepAlive()` runs on the existing 60-second sweep and at service start, from one implementation.** No second timer is added: `sweep` already exists for idle reclaim, and the two halves are the same policy question asked in opposite directions. A running account is skipped before `ensure` is consulted, so the steady state costs one store lookup per account and no log traffic; an account that had to be started is named in the log, because a restart is the event worth seeing and is otherwise invisible. `server.ts` calls the same method after `listen` instead of its own copy of the loop, so "which accounts must be up" has one home.

**Idle reaping skips the keep-alive set, and both halves read one snapshot of it.** Without the skip, an account that must stay up but is not `idle_exempt` — exactly `anders` — is reclaimed on the idle timeout and restarted immediately, dropping its bot connection every cycle. This was reproduced in production: the restart interval matched the 30-minute idle threshold. Doing it from one `Set` per pass also keeps the two halves from disagreeing about the same account.

**An unreadable keep-alive set aborts the whole pass rather than being treated as empty.** Reaping without it would reclaim precisely the accounts the pass exists to protect, which is the failure being fixed. The sweep logs and returns.

**`spawnUserInstance` prints the child's captured stderr when it exits**, bounded to the last 8 KB so a long-lived instance cannot grow the buffer without limit. A clean stop (code 0, no signal) logs at info; anything else logs at error.

## Alternatives considered

**Keeping `idle_exempt` as the only signal and asking operators to mark bot accounts too.** Rejected: it makes correctness depend on an operator remembering to record a fact the system can already observe. The union means neither reason has to be duplicated into the other's bookkeeping, and an operator who marks an account explicitly still gets the behavior they asked for.

**A separate watchdog timer for keep-alive.** Rejected: `sweep` already runs on the interval this would need, and a second timer would let the two disagree about the same account within one pass — the exact interaction that produced the reclaim/restart cycle above.

**Recording bot connections in `dsh_users` so the query can join.** Rejected: the binding is the IM plugin's data, written and rewritten by the plugin under the account's home. Duplicating it into the account schema would create a second copy to keep in sync, with no writer in the account service to own it.

**Treating only `config.json` as the bot signal.** Rejected: it is the field this deployment happens to have looked at, and it is the channel's own schema. Reading either file, and not naming the array field, means the check keeps working for a channel whose config layout differs.

**Restarting an instance in place when its process exits, rather than from a sweep.** Rejected: it cannot cover the case that matters most — an instance that died because the whole account service died, where there is no process left to run the restart.

## Consequences

A bot-connected account's instance now survives an indefinite service lifetime, not just the moment of startup, and a service restart restores every bot-connected account without anyone logging in. On this deployment the restored set went from 5 (`idle_exempt` alone) to 7, with the two additions found rather than configured.

The policy is now inferred from the filesystem on every sweep, which is more work than reading one boolean per account and could in principle promote an account to keep-alive from a stale or hand-made `integrations/` directory. The alternative is a bot that silently stops answering, which is the worse error. The diagnostic change is what made the difference between "something restarted it" and a timestamped reason: `[spawn-user] anders exited 0 on port 32007 (no output)` followed by `[team-account] started instance for anders (kept alive)` is what identified the reclaim cycle in production.

Test coverage is `shell/tests/instance-manager-keepalive.spec.ts`, which exercises the policy with `ensure`/`stop` overridden so no process is started, and runs the bot scan for real against a throwaway users root. It pins the union in both directions, the skip that prevents the reclaim cycle, that one account with both reasons starts once, that an integration directory with no bot bound is ignored, and that an unreadable set reclaims nothing.
