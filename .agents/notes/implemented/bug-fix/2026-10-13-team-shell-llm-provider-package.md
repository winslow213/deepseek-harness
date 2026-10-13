# Agent Note: Team shell mounts the plugin that registers its model provider

Status: implemented

English | [中文](2026-10-13-team-shell-llm-provider-package.zh.md)

## Problem

`writeTeamLlmPatch` (`shell/src/spawn-user.ts`) writes the home-level `cordis.patch.yml` block that gives every account its DeepSeek endpoint and key reference. It mounted `@deepseek-ai/dsh-llm-deepseek`.

Upstream `0.2.1-alpha.2` split that package: the plugin body — the one exporting `name`, `apply`, and `PROVIDER = 'deepseek-official'` — moved to `@deepseek-ai/dsh-llm-deepseek-api-key`, and `@deepseek-ai/dsh-llm-deepseek` became the shared Messages adapter library that exports only `registerDeepSeekProvider`. Mounting a library registers no provider.

The failure was silent. The patch block, `DSH_LLM_API_KEY`, `DSH_LLM_BASE_URL`, and `settings.yaml`'s `agent-default-model.provider: deepseek-official` all stayed correct, and the instance booted without an error or a warning. The only observable was the model catalog: `session/modelCatalog` returned `routableProviders: []` with no groups, so no account could pick or run a model.

A second, independent gap surfaced while verifying the first. The block set no `models:`, so accounts inherited the adapter's `DEFAULT_MODELS`, which had shrunk from four entries to two — dropping `deepseek-v4-flash-vision-exp`, the vision model accounts had been using. The team endpoint serves nine models, so nothing about the endpoint justified the loss.

## Decision

`writeTeamLlmPatch` now mounts `@deepseek-ai/dsh-llm-deepseek-api-key`, the same plugin `packages/bundle/base/cordis.patch.yml` mounts for this route.

The block also writes `models:` explicitly, pinning `deepseek-flash`, `deepseek-v4-pro`, and `deepseek-v4-flash-vision-exp` through the `TEAM_MODELS` table, with `inputModalities: [text, image]` on the two that accept images and Flash's upstream cache-compatibility flags preserved. The team's model list is now a deployment fact the shell states, rather than a runtime default it inherits.

`shell/tests/team-llm-patch.spec.ts` holds both: it reads the rendered block, resolves the mounted package name through the workspace manifests to that package's `src/index.ts`, and asserts the source exports a Cordis plugin and declares `PROVIDER = 'deepseek-official'`. The package name is checked against the real exports rather than as a string, so the next upstream rename fails here instead of in production.

Two adjacent deployment facts became configurable for the same reason — the shell was relying on values that only happen to be right in the original deployment:

- `TEAM_SESSION_COOKIE` (default `dsh_team_session`) names the login cookie the account service issues and the proxy reads. Browsers scope cookies by host and ignore the port, so a second team shell on one host overwrote the first shell's logins and no port choice could separate them.
- `TEAM_MANDATORY_BUNDLES` replaces the hard-coded pinned-plugin table. Unset keeps the 0.1.x pins; set — including to the empty string — is authoritative, which lets the 0.2.x runtime provision accounts without paying a registry round trip for an install it rejects.

## Alternatives considered

### Inherit the adapter's default catalog instead of pinning `models:`

That is what the block did, and it is what silently dropped the vision model. The adapter's default is owned by the runtime release, not by this deployment: it changed once already between the two versions involved here, and a deployment that reads model availability off it has no place to state what its members should actually see. Pinning costs one table in `spawn-user.ts` and makes the account-visible catalog reviewable in the patch.

### Mount both packages, or mount the library alongside the plugin

`@deepseek-ai/dsh-llm-deepseek` is a dependency of `llm-deepseek-api-key`, not a plugin; mounting it adds an entry that contributes nothing and would keep the `dsh-llm-deepseek` id pointing at a package with no `apply`. One entry, naming the package that registers the route, is what the config format expects.

### Fix the name and leave the catalog alone

Rejected because the two gaps share one cause: the team patch described its LLM setup by reference to runtime defaults that had moved underneath it. Fixing only the name would leave the vision model quietly missing and would keep the next default change invisible to everyone but the members who noticed.

### Fall back to the inherited `DEEPSEEK_API_KEY` instead of naming a credential reference

That is the plugin's own default (`apiKeyEnv: z.string().role('credential-ref').default('DEEPSEEK_API_KEY')`). Naming `DSH_LLM_API_KEY` explicitly keeps the team key out of any variable a member's own tooling might also set, and matches what the surrounding team patch blocks already do.

## Consequences

- Accounts get a routable `deepseek-official` provider again, with the three pinned models. Verified against a booted instance: `routableProviders: ["deepseek-official"]`, groups `deepseek-flash`, `deepseek-v4-pro`, `deepseek-v4-flash-vision-exp`.
- The failure mode this note exists for is silent by construction. A plugin-name mistake, a package split, or an entry naming a non-plugin produces a booting instance with a working-looking patch and an empty catalog. The regression test is the only thing that reports it; treat a failing `team-llm-patch.spec.ts` as a production-blocking break, not a doc drift.
- The same class of mistake is possible in the other team patch blocks — `writeTeamSandboxPatch`, `writeTeamDirectoryPickerPatch`, and the region, wiki, and KB injectors all write plugin names. Upstream splitting or renaming any of them fails the same silent way. Each was checked against its package's exports during this change; only the LLM one was wrong.
- `TEAM_SESSION_COOKIE` unset reproduces today's behavior byte for byte. Setting it on an existing deployment signs every member out once, because the browser's old cookie is no longer read; the Redis session survives, so a re-login is all it costs.
- `TEAM_MANDATORY_BUNDLES` unset keeps the 0.1.x pins. A deployment whose runtime rejects them should set it empty rather than let behavior stay at a rejected install attempt on every account provision.
