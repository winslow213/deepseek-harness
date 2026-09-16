# Agent Note：让 dsh 会话通过 `kb_search` 工具读取团队知识库服务

Status: implemented

[English](2026-09-16-team-shell-kb-search-tool.md) | 中文

## Problem

团队已经在运行一个独立的 Rust/axum "Team KB Agent Server"（`/home/winslow/Desktop/wiki-server`，不属于本仓库），背后是一份庞大的、经过整理的知识库（OpenHarmony 平台文档、Agent 规则、实体/概念笔记——数千篇文档），通过一套 HTTP job API 暴露。此前的一次改动让该服务器把 `dsh --profile headless` 作为它自己可插拔的答案生成后端之一（见知识库服务自身的历史记录），但那是相反的方向：是知识库服务在调用 dsh，而不是反过来。团队 shell 里没有任何机制能让一个普通的 dsh 会话——也就是用户实际聊天用的那个——去查这份知识库；每个 dsh 实例对它一无所知。

## Decision

**一个面向模型的 `kb_search` 工具，是知识库服务现有 job API 的一个薄 HTTP 客户端，而不是在知识库服务内部新增能力。** `shell/src/remote/kb-tool.ts` 创建一个缓存的会话（`POST /api/sessions`），提交一个查询任务（`POST /api/jobs/query`），然后阻塞在该任务的 SSE 事件流（`GET /api/jobs/{id}/events`）上直到收到终态事件，返回合成后的 `{ answer, citations, used_docs }`。知识库服务自己的 worker 已经完成了文档检索、构造提示词、JSON Schema 校验（通过 `config/default.toml` 指定的任意后端，例如 Copilot）——这个工具不在服务端新增任何逻辑，就像调用任何其他内部 HTTP 服务一样。

**会话按插件实例缓存（即按 dsh 进程生命周期缓存），而不是每次调用都新建，也不跨重启持久化。** 知识库会话有服务端 24 小时的 TTL，远长于一个 dsh 进程的典型生命周期，因此一个闭包变量 `let cachedSessionId` 就足以避免每次 `kb_search` 调用都多一次往返，也无需任何过期刷新逻辑。

**用一次阻塞的 `GET .../events` 请求取代客户端轮询循环。** 知识库服务的 SSE 端点本身就设计成会一直保持连接直到任务到达终态（见知识库服务的 `get_job_events.rs`）——无论客户端连接时任务是否已经完成——所以一次 `fetch(...).then(r => r.text())`（解析出最后一个终态 `data:` 载荷）就够了；这个工具的一次性用法不需要轮询、退避或手动维护 `Last-Event-ID`。

**接入每个账号的方式与 wiki 工具完全一致：一个 home 级插件，在每次 `provisionUserHome` 时 upsert。** `injectKbSearch`（`shell/src/remote/inject.ts`）把 `kb-tool.ts` 拷贝进 `$DSH_HOME/plugins/kb/`，`ensureKbSearch`（`shell/src/spawn-user.ts`）把一个带 id 标记的区块 upsert 进账号 home 级的 `cordis.patch.yml`，配置了账号 id（作为知识库会话的 `user_id`）和知识库服务的 base URL（`TEAM_KB_BASE_URL` 环境变量，默认 `http://127.0.0.1:8080`——同一台主机、回环地址，因为知识库服务和它服务的每个 dsh 实例都跑在同一台部署主机上）。

**任务失败会以普通的工具调用错误呈现，而不是静默返回一个空答案。** 知识库服务在文档不支持某个答案时会刻意拒绝编造；`kb-tool.ts` 从终态事件里读出 `error_message` 并抛出，这样模型看到的是一次清晰、可恢复的工具调用失败，而不是一个空的或有误导性的"成功"。

## Alternatives considered

**常驻式的上下文注入（把知识库摘要加载进每个回合），仿照个人 wiki 的 L1/L2 通过 `agent-instructions` 自动加载的方式。** 被否决：知识库涵盖跨多个分类的数千篇文档——完全不像个人 wiki 那两个体量有限的文件，没有哪种摘要能便宜地塞进每个回合的上下文里。以这份知识库的规模，只有"模型需要时才主动调用"的拉取式工具是唯一可行的形态。

**循环轮询 `GET /api/jobs/{id}` 直到状态变为终态，再单独取结果。** 被否决：`JobInfo`（轮询响应）只携带 `result_ref`（一个服务端本地文件系统路径），而不是结果内容本身——网络客户端根本无法解析这个路径。SSE 事件端点是唯一能通过网络拿到真正的 `{answer, citations, used_docs}` 载荷的方式，而且它本来就会阻塞到终态，所以它同时取代了轮询循环和单独的"取结果"步骤。

**在知识库服务项目内部修复 `codex_runner.py` 的 `top_k: null` 崩溃问题。** 推迟，而非否决：`wiki-server` 是本次改动范围之外的独立仓库。`kb-tool.ts` 的规避方式是始终发送一个具体的 `top_k`（默认 8）而不是留空/传 `null`，无论服务端的 bug 之后是否被修复，这都是客户端应有的正确行为。

## Consequences

现在每个账号的 dsh 实例都有一个 `kb_search` 工具，可以查询团队真正的知识库并返回带引用的答案；已经针对真实运行中的知识库服务做了端到端验证（在部署主机上 `cargo run --release`，真实的 Postgres/Redis，真实的文档），一次真实查询（"NNRt 是什么"）返回了正确且带引用的答案。`shell/tests/kb-tool.spec.ts`（注册、成功路径、跨调用的会话缓存、失败呈现）和 `shell/tests/spawn-user-kb.spec.ts`（运行时拷贝、patch 内容、默认/覆盖的知识库 URL、幂等性）为 shell 测试套件新增了 7 个通过的用例（共 53 个，全部通过）；`shell/tsconfig.json` 和 `shell/tsconfig.executor.json` 均 typecheck 干净，`kb-tool.ts` 已按 `wiki-tool.ts` 的方式加入它们的 include/exclude 列表。知识库服务本身必须作为一个持久化服务运行在部署主机上，这个工具才能在生产环境里工作——它不受团队 shell 自己的 `deploy.sh`管理，需要单独的运维归属（这是后续工作，本笔记未设计）。知识库服务自己的默认答案生成后端是否应该切换成 `--provider dsh`，是一个独立的、仍然悬而未决的决定，本笔记不做这个决定。
