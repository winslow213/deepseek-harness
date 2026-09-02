# Agent Note: Workflow node profiles for per-agent persona and tool scoping

Status: implemented

English | [中文](2026-08-25-workflow-agent-profile-node-config.zh.md)

## Problem

A workflow script delegates work to many subagents through `agent()`, but every child previously ran on the deployment persona and the deployment toolset. A multi-role orchestration — an auditor, a writer, a reviewer — needs each node to carry its own identity and its own tool scope, independent of the deployment, and that per-node configuration should be reusable across deployments the way a preset profile is.

The `agent()` option set is a closed protocol enforced by a hardcoded whitelist in the worker runtime. Adding options is a base-engine change, not a plugin hook, and the host must not invent behavior a script did not ask for.

## Decision

Two layers deliver per-node configuration.

The engine layer adds one option: `agent(prompt, { profile })` names a preset whose node profile supplies default `persona`/`toolFilter` for that child. The worker whitelist accepts `profile`, validates it as a string, and forwards it on `ChildStartRequest`. The host resolves the named profile and merges it with the call's explicit options: an explicit `persona` replaces the profile's whole field, and an explicit `toolFilter` replaces the profile's `allow` and `deny` independently. An option the call leaves unnamed keeps the profile's value.

The preset layer supplies the profile. Each preset directory may carry a `profile.yml` declaring `persona` and/or `tools: { allow?, deny? }`. Discovery reads it into a `NodeProfile` on the preset row; a malformed file is reported as `profileProblem`, independent of a broken composition. `AgentPresets.resolveNodeProfile(id)` returns the row's node profile and fails loud on an unknown preset, an absent `profile.yml`, or an unusable one.

Profile resolution is opportunistic, like subagent composition inheritance: `agent-presets` is an optional peer dependency, and a rosterless deployment fails loud per child rather than silently dropping the persona/toolFilter a script asked for. The workflow tool description documents the `profile` contract.

## Verification

The preset layer is covered by `readNodeProfile` parsing tests, discovery tests that a scanned preset carries its parsed profile or problem, and service tests that `resolveNodeProfile` succeeds on a declared profile and refuses an absent or malformed one. The engine layer is covered by session tests for `profile` validation and forwarding on the start request, and worker-thread tests that the host resolves the profile's persona/toolFilter onto the child, that explicit options override the profile field by field, and that a rosterless deployment fails loud. Both package READMEs and the workflow tool description document the new option.

## Alternatives considered

**Expose the option through a plugin hook without touching the engine.** Rejected: `agent()` options are a closed protocol; a hook cannot extend what the worker whitelist rejects, so honoring `profile` would require the base change this decision makes anyway.

**Share one agent's context across the fan-out.** Rejected: the requirement is independent agents dispatched per node with their own configuration, not one context reused across delegations.

**Hard-depend on `agent-presets` in the engine.** Rejected: the roster is optional in deployments, and a hard dependency would force it everywhere. An optional peer with a fail-loud use keeps the engine usable without presets.

**Merge the explicit persona with the profile's.** Rejected: personas are whole-identity strings, so the explicit value replaces the profile's. Only `toolFilter` merges, and only at the `allow`/`deny` field level.

## Consequences

Each workflow node configures its identity and tool scope independently, reuses a preset's profile across scripts and deployments, and can isolate permissions per node (for example denying a shell to a reviewer child). Editing a preset's `profile.yml` changes every future child that names it, without code changes.

The cost is indirection: `agent({ profile })` resolves against the roster at run time, so a script names a preset that must exist and declare a profile, and a deployment without the roster cannot honor the option at all. The added `ChildStartRequest` field lives in the private worker protocol, so no session log format changes; the model-visible surface is the workflow tool description.
