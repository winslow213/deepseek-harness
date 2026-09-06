# Agent Note: Team LLM credentials inject through a cordis patch, not config files

Status: implemented

English | [中文](2026-09-06-team-llm-cordis-patch-injection.zh.md)

## Problem

The team shell must give every spawned user instance the team's LLM API key and endpoint. The first implementation materialized them onto each user's `$DSH_HOME`: the endpoint into `settings.yaml`'s `llm-deepseek:` section and the key into `.credentials.yaml`'s `DEEPSEEK_API_KEY` reference. That writes the key into a per-user file at every spawn, so rotating the team key means rewriting every user's managed document — the opposite of one central swap.

## Decision

Injection goes through the harness's patch layer, not generated config files. `provisionUserHome` upserts an id-delimited block into the home-level patch `$DSH_HOME/cordis.patch.yml` (the machine-local layer that outranks the profile's own `cordis.patch.yml`). The block is delimited by `# >>> dsh-team-llm` / `# <<< dsh-team-llm` markers — the same protocol `plugin-install` uses for its own patch rows — so every other byte of the file survives and any other writer of the home patch coexists. The block carries one row that overrides the `llm-deepseek` entry:

```yaml
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek'
  config:
    apiKeyEnv: DSH_LLM_API_KEY
    baseURL: !!js process.env.DSH_LLM_BASE_URL
```

The key is never written to any file. The patch names the `DSH_LLM_API_KEY` credential reference, and `spawnUserInstance` forwards the account service's `TEAM_LLM_API_KEY` / `TEAM_LLM_BASE_URL` into the child environment as `DSH_LLM_API_KEY` / `DSH_LLM_BASE_URL`. The credentials seam resolves the reference per request from the inherited environment — its highest-priority layer — and the endpoint resolves once at startup through the `!!js` expression. Rotating the key is one change to the account service `.env` plus an instance restart.

## Alternatives considered

**Write `settings.yaml` + `.credentials.yaml` per user.** Rejected: it materializes the secret into many files, and a central key rotation must rewrite every user's document instead of one environment value.

**Add per-user `api_key` / `api_base_url` database columns and inject them at spawn.** Rejected: the team runs one shared key, and a per-user column adds schema, migration, and UI surface for a rotation that a single environment change already covers.

**Inline the key into the patch.** Rejected: the patch is a durable file, and putting the secret there reintroduces the multi-file rotation problem the patch is meant to avoid.

## Consequences

The patch file is static and contains no secret — it names a reference and reads the endpoint from the environment. A single change to `TEAM_LLM_API_KEY` / `TEAM_LLM_BASE_URL` in the account service `.env`, then an instance restart, propagates to every user. The endpoint resolves once at startup (so it needs the restart); the key resolves per request through the inherited environment. A user who later sets a `llm-deepseek:` settings section through the web Models page still overrides the patch entry, because the settings layer outranks the cordis entry config. The marked-block upsert keeps the shell from clobbering any operator or other-writer rows in the home patch, and re-running the upsert is idempotent (the block replaces in place rather than duplicating). The removed `yaml` dependency leaves the shell's only third-party packages as `pg` and `ioredis`.
