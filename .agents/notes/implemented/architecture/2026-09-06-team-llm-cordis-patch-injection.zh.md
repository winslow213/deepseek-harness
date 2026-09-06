# Agent Note: 团队 LLM 凭据通过 cordis patch 注入，而非写入配置文件

Status: implemented

[English](2026-09-06-team-llm-cordis-patch-injection.md) | 中文

## Problem

团队 shell 必须为每个孵化的用户实例注入团队的 LLM API key 与 endpoint。最初实现把它们落到每个用户的 `$DSH_HOME`：endpoint 写入 `settings.yaml` 的 `llm-deepseek:` 段，key 写入 `.credentials.yaml` 的 `DEEPSEEK_API_KEY` 引用。这样每次 spawn 都把 key 写进每个用户的文件，轮换团队 key 就必须重写每个用户的受管文档——与"一处集中替换"背道而驰。

## Decision

注入走 harness 的 patch 层，而非生成的配置文件。`provisionUserHome` 向 home 级 patch `$DSH_HOME/cordis.patch.yml`（机器本地层，优先级高于 profile 自身的 `cordis.patch.yml`）upsert 一个 id 定界块。该块由 `# >>> dsh-team-llm` / `# <<< dsh-team-llm` 标记定界——与 `plugin-install` 写自身 patch 行所用的同一协议——因此文件的其余每个字节都保留，任何其他写 home patch 的一方都能共存。块内一行覆盖 `llm-deepseek` 条目：

```yaml
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek'
  config:
    apiKeyEnv: DSH_LLM_API_KEY
    baseURL: !!js process.env.DSH_LLM_BASE_URL
```

key 绝不写入任何文件。patch 只声明 `DSH_LLM_API_KEY` 凭据引用，`spawnUserInstance` 把 account 服务的 `TEAM_LLM_API_KEY` / `TEAM_LLM_BASE_URL` 作为 `DSH_LLM_API_KEY` / `DSH_LLM_BASE_URL` 转发进子进程环境。凭据 seam 每次请求时从继承环境（其最高优先级层）解析该引用，endpoint 则在启动时经 `!!js` 表达式求值一次。轮换 key 就是改一处 account 服务 `.env` 再加一次实例重启。

## Alternatives considered

**为每个用户写 `settings.yaml` + `.credentials.yaml`。** 否决：把密钥落到许多文件里，集中轮换 key 必须重写每个用户的文档，而非改一处环境值。

**增加 per-user `api_key` / `api_base_url` 数据库列并在 spawn 时注入。** 否决：团队使用同一个共享 key，per-user 列额外引入 schema、迁移与 UI 面，而这些一处环境变更已覆盖。

**把 key 内联进 patch。** 否决：patch 是持久化文件，把密钥放进去会重新引入 patch 本要避免的多文件轮换问题。

## Consequences

patch 文件是静态的、不含任何密钥——它只声明引用并从环境读取 endpoint。改一处 account 服务 `.env` 里的 `TEAM_LLM_API_KEY` / `TEAM_LLM_BASE_URL`，再重启实例，即可传播到每个用户。endpoint 启动时求值一次（因此需要重启）；key 每次请求经继承环境解析。用户后续若通过 web Models 页设置 `llm-deepseek:` settings 段，仍会覆盖 patch 条目，因为 settings 层优先级高于 cordis 条目配置。标记块 upsert 使 shell 不会覆盖 home patch 里 operator 或其他写入方的任何行，重复运行 upsert 也幂等（块原地替换而非重复追加）。移除 `yaml` 依赖后，shell 的第三方包仅剩 `pg` 与 `ioredis`。
