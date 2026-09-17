# Agent Note: The personal wiki records an append-only op log merged by a weighted gate

Status: implemented

[English](2026-09-17-personal-wiki-op-log-with-weighted-merge.md) | 中文

## Problem

[每账户个人 wiki](../feature/2026-09-16-team-shell-user-wiki.zh.md) 写入 L1（身份）与 L2（偏好）的方式是整体覆写该层文件。在本部署中，一个账户同时跑多个会话是常态——浏览器里的 Web UI、飞书机器人、微信机器人——全部指向同一个实例。其中两个同时对该层调用 `wiki_note` 属正常情况而非边缘情况，而整体覆写会让后一次写入直接抹掉前一次写入的内容。

[冲突保护](../bug-fix/2026-09-16-wiki-whole-file-write-conflict-guard.zh.md) 通过拒绝第二次写入阻止了静默丢失，修好了一种损坏，又造成了另一种：第二个会话的内容被直接丢弃，模型唯一的补救办法是用它自己必须重新拼凑的文本重试。拒绝不是合并。

而且该层文件是唯一副本。任何对它整体重写的东西——轮转、外部编辑、写到一半——都会摧毁历史，且无从察觉。

## Decision

**wiki 的持久形态改为只追加的 op 日志；层文件成为它的派生投影。**

`$DSH_HOME/workspace/.dsh/wiki/oplog/ops.jsonl` 每次写入存一行 JSON 对象（`v`、`seq`、`ts`、`by`、`layer`、`op`、`target`、`text`、`intent`、可选 `evidence`、`class`）。写入永不修改或删除既有行，因此一个写入者根本够不到另一个写入者的内容。`watermark.json` 记录日志中有多少字节已折叠进投影，以及那一刻每个层文件的内容哈希。

**合并锁是进程内的布尔量（`tryAcquireMerge`/`releaseMerge`），不是跨进程声明。** 原设计在 `oplog/` 下用 `mkdir` 声明目录。它的两道防线都站不住：超时抢占会对仍持有 `owner.json` 的目录调用 `rmdir`，于是得到 `ENOTEMPTY` 而非 `EEXIST`，抢占从不生效；而 `mkdir` 成功与写入 `owner.json` 并非原子，读不到 owner 的第二个竞争者会偷走活跃声明，产生两个持有者。这两点在本地都不成立，因为 `InstanceManager.ensure` 在注册已存在时提前返回，所以一个账户最多只有一个活实例，"并发会话"是一个单线程 Node 进程里交错的多个 turn。`checkMergerPid`/`recordMergerPid` 保留，作为"记录的合并者就是本进程"的校验。

**每次写入把自己的文本渲染进层文件里由 `<!-- PENDING-OPS -->` 包住的块，而 `stripPendingBlock` 在计算哈希前精确移除该块。** 这正是让未合并写入在模型下一个 turn 中不至于不可见的原因：模型读到的投影里已经有它了。`renderPendingBlock` 与 `stripPendingBlock` 互为精确逆操作，且对账计算的是剥离后的内容——若对原始字节计算哈希，每次追加都会重写文件尾部，对账会在每次合并时失败。

**轮转给每个归档唯一命名，且归档算作历史。** `archiveEpoch.bytes` 跟踪当前 epoch。复用归档文件名会在日志声称保存全部历史的同时覆盖上一次轮转，并破坏规格 §9.1 所需的区分——"刚刚轮转过"与"历史已丢"——因此 `hasOpHistory` 把非空归档目录视为历史存在的证据。

**合并是由机械权重驱动的状态机，不是定时器。** `pendingWeight` 从 op 本身累加三项输入——op 的 `class`（`critical` 重于 `normal`）、陈旧度、冲突——全程无模型参与。`mergeGate` 将其与可配置阈值（默认 6，上限 50）比较，返回 `idle` 或 `merge`。模型也可以经 `wiki_merge` 工具请求合并，仍由同一道闸决定。固定间隔被否决：一周没写过东西的账户不该付一次合并，一分钟内把身份写了四遍的账户也不该等。

**基线缺失时大声失败，而不是覆写。** 当某层既无 op 又无可对账内容时，`assertMergeBaseline` 抛出 `NoBaselineError`（`E_NO_BASELINE`），而不是把"历史缺失"当作空层并覆写那里的东西。`provisionUserHome` 通过 `seedBaselineIfMissing` 为每个账户（无论新建还是既有）播种一条 `baseline` op——脚手架生成的骨架文本本身就是内容，因此"已供给但从未写入"的账户此前与"op 历史已丢失"无法区分，会永远撞上 `E_NO_BASELINE`。

**面向模型的开关是 `config.wikiV2`，默认开启**，`mergeWeightThreshold`、`maxPendingOps`、`rotateBytes` 作为部署可调项位于插件的 `Config` 中。设为 `false` 会恢复整体覆写及其冲突检查，这是有文档的回滚路径，也让冲突保护 note 描述的行为仍然可达。

## Alternatives considered

**跨进程互斥，即原先的 `mkdir` 声明。** 其失败原因已记录在 Decision 中；它还在必要性上失败。一个正确实现需要 fencing token、过期时间与偷锁检测，而本部署的生命周期根本产生不出第二个进程。

**按固定间隔合并。** 被否决：调度与"是否有值得合并的内容"无关，于是它要么在空闲账户上白烧一次模型调用，要么让繁忙账户干等。权重读取真实存在的 op，并把决策保留为可检视的算术而非一个策略旋钮。

**保留冲突保护作为主机制，只改进它的拒绝文案。** 被否决：拒绝只能告诉模型用手工合并后的文本重试，而这正是 op 日志以机械且持久的方式完成的工作。该保护仅作为 v1 回滚路径保留。

**合并运行前不向层文件渲染任何内容。** 被否决：模型读的是投影，因此未合并的写入对它不可见，第二个会话会乐呵呵地产出同一事实的第三个版本。渲染 pending 块在不把投影变成权威的前提下让读路径保持诚实。

## Consequences

一个账户上的多个并发会话现在会组合而非互相抹除：对整体替换层每次 `wiki_note` 追加一条 `baseline` op，投影显示最新的 pending 文本，合并在 `critical` 加权复核下折叠它们。模型写下的每一条都能仅从 `ops.jsonl` 恢复，因此投影丢失只是重建而非损失。

代价是真实的。wiki 不再是操作者可以手工改动并期望其保留的文件——外部编辑会被对账为新基线而非被当作权威，而要让对账哈希匹配，它必须基于剥离 pending 后的内容计算。轮转与水印引入了两种 v1 单文件设计不可能有的失效模式（日志已轮转但归档缺失、水印领先于日志）。`shell/src/remote/oplog.ts` 特意不引入任何 `@deepseek-ai/*`，以便其测试无需模型即可运行；`wiki-merge.ts` 接受注入的 completion，因此合并同样可无模型测试。

测试覆盖为 `shell/tests/oplog.spec.ts`、`wiki-v2-concurrency.spec.ts`、`wiki-v2-merge.spec.ts`、`wiki-v2-provisioning.spec.ts`、`wiki-v2-rotation.spec.ts`、`wiki-v2-weight.spec.ts`、`wiki-v2-wiring.spec.ts` 中 30 余个新增用例，其中包含一个刻意不加锁的竞态，并被证明会丢失一次更新——正是这个用例为锁争取到了它存在的理由。`runtime-copy-lists.spec.ts` 从模块的真实导入推导要复制进各账户 `plugins/` 目录的文件，因为漏掉一个（`oplog.ts` 一度被漏出该列表）会让每个实例在启动时崩溃，而这是类型检查看不出来的。`wiki-fs.ts` 的四个文件保持原形，只有写入路径与合并发生变化。
