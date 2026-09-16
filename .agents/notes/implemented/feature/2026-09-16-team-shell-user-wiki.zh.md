# Agent Note：每账号一份四层个人 wiki，由模型可调用的 `wiki_note` 工具写入

Status: implemented

[English](2026-09-16-team-shell-user-wiki.md) | 中文

## Problem

team-shell 让每个账号拥有自己隔离的 `dsh` 实例与工作区，但没有任何机制跨会话保留关于"这个人"的长期知识：身份事实、工作偏好、值得记住的进展，以及过往决策背后的推理，都会在会话结束或被压缩后丢失。用户要求一种机制：从用户拿到第一个实例起，dsh 就在其工作区下维护一份个人知识模型，并随对话中出现的真正突破持续更新——不需要用户自己整理，也不能仅依赖模型在长会话中"自己记得"去调用。

## Decision

**四个独立文件，而非一份分 section 的文档，按写入语义与加载代价拆分。**`.dsh-wiki-identity.md`（L1，稳定事实）与 `.dsh-wiki-preferences.md`（L2，工作模式）直接位于工作区根目录，每次写入整体覆写，与 `todo_write` "整份列表替换"的纪律同构。`.dsh/wiki/timeline.md`（L3，值得记住的进展/突破）与`.dsh/wiki/decisions.md`（L4，决策与被放弃的方案）位于隐藏子目录，追加式——条目从不改写；推翻一个决策意味着追加一条新条目并声明它推翻了哪条旧条目，与本仓库自身 Agent Note "已封存记录从不编辑"的规则一致。L1/L2 之所以必须是工作区根目录的直接子项，是因为 `agent-instructions` 的 `localInstructionFileCandidates`遍历只检查 project-root 到 cwd 祖先链上的每一层目录，绝不下钻子目录——放在别处会让它们悄悄失去自动加载。

**L1/L2 复用既有的 `agent-instructions` 本地叠加机制，而非新建一条上下文注入管线。** `ensureUserWiki`（在 `provisionUserHome` 中调用，因此每次实例启动前都会执行，而不只是字面意义上的"第一次"启动）把一个 `agent-instructions`配置 patch upsert 进去，将 `.dsh-wiki-identity.md` 与 `.dsh-wiki-preferences.md`加入 `localInstructionFileCandidates`。由于该候选列表恰好在 project root（对team-shell 实例而言同时也是工作区根与 cwd）下被检查，两个文件会自动加载进每一轮的基线上下文，零新增管线。L3/L4 刻意不自动加载：用普通文件工具按需读取，避免日志累积后上下文无界增长。

**用 `wiki_note` 工具主动写入，而非会话结束时被动提取。** 该工具（`shell/src/remote/wiki-tool.ts`）接受 `kind: 'identity' | 'preferences' |'timeline' | 'decision'` 判别字段；两种日志类型额外接受 `alternativesConsidered`（`decision` 必填）与 `decidedBy`。它与纯 fs 辅助文件 `wiki-fs.ts`（无`@deepseek-ai/*` 依赖，在 provisioning 时的脚手架逻辑与运行时工具之间共享）一起被拷贝进 `$DSH_HOME/plugins/wiki/`，并打入账号的 **home 级**`cordis.patch.yml`（`apps/cli/src/profile-boot.ts` 在 profile 自身 patch 之后叠加的那一层），而不是 `injectRegionRouter` 每次调用都整份覆写的 profile 级patch 文件。

**周期性 `<system-reminder>`，模仿 `packages/skill/tool-skill` 的 catalog消息注入手法，对抗遗忘。** 一个进程内 `WeakMap<Agent, number>` 计数`agent/pre-step` 调用次数；每 `reminderEveryTurns`（默认 6，可配置）轮，插件注入一条提醒消息并清零计数器——而不是只提醒一次（skill catalog 的语义）或在长会话中再也不提醒。

## Alternatives considered

**在会话结束或压缩时被动提取，模仿 `compaction-basic` 的摘要器。** 不采纳：真正的突破发生在对话中途，描述它所需的最丰富上下文就在那一刻，压缩已经丢弃细节之后再提取为时已晚；摘要器每次会话还要多付一次 LLM 调用的成本。让模型在突破发生的当下主动调用 `wiki_note` 能捕获更多信息，什么都没发生时也不产生额外成本，而周期性提醒则兜住"模型就是不主动调用"的风险。

**用一份合并的 wiki 文件分 section，而非四个文件。** 不采纳：L1/L2 需要"每轮整份加载"，L3/L4 需要"永久追加、从不整体重新加载"——把两种纪律混进同一文件，要么被迫引入原本不存在的解析/截断逻辑，要么每轮都要整份加载无界增长的日志。四个文件让 L1/L2 可以原样复用 `agent-instructions` 现成的本地叠加加载，也让 L3/L4 可以无界增长而不产生逐轮开销。

**把 wiki 插件的 patch 写进 `injectRegionRouter` 拥有的那份 profile 级`cordis.patch.yml`。** 不采纳：该文件在每次 `ensureRegionRouter` 调用（即每次`provisionUserHome`）时都用整份 `writeFileSync` 覆写，若在那里另写一个 wiki区块，要么在下次 region-router 刷新时被悄悄冲掉，要么得把 `injectRegionRouter`重构成 upsert 写入器。home 级 patch 文件已有成熟的 upsert 约定（`writeTeamLlmPatch`、`writeTeamSandboxPatch`、`writeTeamDirectoryPickerPatch`），本笔记的 `ensureUserWiki` 只是照此约定行事。

## Consequences

现在每个账号在第一轮对话之前就有一份预建好的个人 wiki，模型可以调用工具让它保持最新，并有周期性提醒防止长会话中被遗忘。`shell/tests/wiki-fs.spec.ts`（脚手架与读写语义）、`shell/tests/wiki-tool.spec.ts`（工具注册、四种`kind`、必填字段校验、周期性提醒）与 `shell/tests/spawn-user-wiki.spec.ts`（provisioning 接线的端到端验证，含幂等性与对无关 home-patch 内容的保留）共新增 33 个 `node --test` 用例，并入既有 shell 测试套件（共 35 个，全部通过）；`shell/tsconfig.json` 与 `shell/tsconfig.executor.json` 均 typecheck干净，`wiki-tool.ts`/`wiki-fs.ts` 已按 `region-router.ts` 等同伴的方式加入executor/exclude 列表。超出"直接读文件"的检索需求（例如按任务/会话 id 大规模检索 `decisions.md`）本笔记未设计，待日志积累到有必要时再重新考虑。一起生产事故中，同一账号的两个并发会话静默毁掉了彼此的 L1 写入，由此为整体替换层加上了冲突守卫，详见另一篇笔记[整体覆盖写入冲突守卫](../bug-fix/2026-09-16-wiki-whole-file-write-conflict-guard.zh.md)。