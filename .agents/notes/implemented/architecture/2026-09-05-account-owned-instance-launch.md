# Agent Note: Account-owned login and instance launch

Status: implemented

English | [中文](2026-09-05-account-owned-instance-launch.zh.md)

## Problem

The team proxy can authenticate a member and route requests, but a route is unusable when the member's dsh instance has not been started. Manual instance startup couples deployment operations to each login and leaves the account service without ownership of the process that backs an authenticated session.

## Decision

The account service owns the member login-to-instance transition. After `AuthService` creates a session, the account HTTP handler asks `InstanceManager` to ensure that the member has a registered dsh instance. `InstanceManager` allocates an unused port from `TEAM_INSTANCE_PORT_START` through `TEAM_INSTANCE_PORT_END` and supervises the member's instance in-process (see [the account-into-shell merge](../../simplification/2026-09-06-merge-account-service-into-shell.md)); it waits for the first generation's URL before recording the port, launch token, and PID in `dsh_instances`.

`InstanceManager` coalesces concurrent starts for the same user, reserves ports while instances start, removes the instance record when the supervision loop ends, and stops all account-owned supervisors during account-service shutdown. A failed start destroys the newly created session and returns an explicit 503 response. `spawn-user.ts` still provisions `DSH_HOME` and `superviseUserInstance` handles same-port plugin-install restarts, now driven directly by the account service rather than through a `spawn-user` subprocess. The proxy only authenticates and routes; it does not start instances.

Deployments configure the port range through `TEAM_INSTANCE_PORT_START`/`TEAM_INSTANCE_PORT_END`; `DSH_USERS_ROOT` and `DSH_ENTRY_HOST` are read by `spawn-user` from the shared environment. Existing instance registrations remain authoritative, so account-service restarts do not duplicate a live instance.

## Alternatives considered

**Let the proxy start instances on a missing route.** Rejected because the proxy would need process ownership, port allocation, startup coordination, and cleanup in addition to HTTP routing. It would also make login success depend on a second component's hidden lifecycle.

**Keep operator-started instances and return an instance-not-ready page.** Rejected because login would not provide the promised working session and every member would require an out-of-band deployment action.

**Start a new process for every login.** Rejected because one member must have one isolated `DSH_HOME` and one durable instance route; the per-user start map and persisted registration make concurrent logins idempotent.

**Make startup fire-and-forget after returning the login response.** Rejected because the browser would race the first route request against instance registration. Waiting for the URL gives the caller a clear success or an actionable 503.

## Consequences

Account-service deployment must be able to execute `TEAM_SHELL_COMMAND` and must provide a port range with capacity for concurrent members. The account service now owns child-process cleanup and reports instance startup failures as login failures. The shell CLI remains reusable for manual operations, but normal team access no longer requires an operator to start a member instance before login.
