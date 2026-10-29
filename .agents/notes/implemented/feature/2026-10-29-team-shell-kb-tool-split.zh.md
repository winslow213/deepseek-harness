# Agent Note: 把 KB 面拆成检索、综合与整页读取

Status: implemented

[English](2026-10-29-team-shell-kb-tool-split.md) | 中文

## Problem

`kb_search` 最初是单次阻塞调用，且永远走综合：开一个 KB 会话、提交查询任务、再等 KB 服务端自己的 LLM 环节跑完 30-130 秒。对常见情形这是错的形状。模型问「KB 里有没有提到 NNRt？」时，必须先付出综合的代价才能看到任何证据，而「拿回来的证据够不够」只有模型自己能判断。同一个形状还暴露第二个问题：当 KB 服务端的综合后端退化时，纯检索型的提问完全答不了，尽管它背后的检索索引是健康的、而且读取很便宜。

## Decision

**按代价拆成三个工具。** `shell/src/remote/kb-tool.ts` 现在注册 `kb_search`（仅检索，约一秒）、`kb_answer`（综合，30-130 秒）和 `kb_document`（整页读取）。

**`kb_search` 读 KB 服务端开放的读取面，不开会话。** 它用 `GET /api/kb/search` 取命中、为每个选中的页面发一次 `GET /api/kb/document`，因此不需要会话、不需要任务、也不需要 agent token；综合链路挂掉时它照常工作。页面按 `(path, heading)` 去重，每页预算按页面而不是按章节计数——一个文件会贡献多条窗口化命中。

**余弦下限把「看着像相关内容」的结果显式变成「没有可靠匹配」。** 低于 `minCosine`（默认 0.6）的命中被逐条丢弃，而不只是检查最高分，这样一个靠泛词匹配上的页面无法挨着一个真正好的命中一起混进来。一条都不剩时，工具返回 `covered: false` 并附注说明是**这个提问**没匹配上，而不是 KB 里没有——并指向 `kb_answer`。记录这个区分很重要：把空结果读错，会让模型永远改写提问、或断定 KB 里就是没有这类内容。

**`kb_answer` 保留会话加任务的路径，但换成一次失败握手无法污染进度的 promise 缓存。** 缓存句柄是 `Promise<string>` 而不是已解析的 id，所以两次并发调用共享一次握手；拒绝时清空缓存，一次坏握手不会让该进程此后每次调用都失败。`SessionExpiredError`（服务端对超出 24 小时 TTL 的会话返回 404）会清空缓存、重建一次、重试同一查询。

**结果键在进入工具输出 schema 之前先做兜底。** 框架对必填键为 `undefined` 的结果以「value is not lossless JSON」整条拒绝。曾观察到一次用中文作答的模型（138 秒的运行）产出 `{使用文档, 引用文档, 答案}`，因此 `kb_answer` 读 `answer`/`citations`/`used_docs`，取不到时回落到中文键名，而不是让长任务在最后一步失败。

## Alternatives considered

**一个带 `mode` 参数（`retrieve` | `synthesize`）的工具。** 否决：工具描述才是模型判断要不要调用的依据，一段描述无法同时说清「很便宜，随便调」和「这要花几分钟」。两个分别描述的工具让代价在决策时就可见，而「检索是否已经够用」只有模型能判断。

**`kb_search` 找不到过线命中时自动回落到 `kb_answer`。** 否决：那会把一次一秒的调用悄悄变成两分钟，而这正是拆分要消除的意外。改为在 `covered: false` 的注里点名 `kb_answer`，让升级仍是模型的决定。

**保留已解析的会话 id，靠定时器刷新。** 否决：定时器会刷新没有任何调用在用的会话，而且过期本来也只能在下一次请求时才被观测到。按服务端自己的 `SessionExpiredError` 重建，在罕见的过期情形下多花一次往返、常见情形下零成本。

## Consequences

`kb_search` 不再需要账号的 agent token，因此该 token 现在的消费者只剩 `kb_answer` 的会话与查询调用；出于前一条 note 记录的归属理由，token 仍按账号分发。`shell/tests/kb-tool.spec.ts` 围绕一个同时实现读取面和会话加任务面的假服务重写：覆盖三个工具的注册、不开会话的检索、余弦下限、整页读取、综合路径、bearer 头的有无、会话缓存、过期重建、任务失败上报，以及非 `Error` 中止原因的包裹。`injectKbSearch` 生成的 home patch 注释现在点名三个工具；patch 块的 id 与文件布局未变，因此已有 home 在下次 provision 时自然取到新文件。home patch 只在启动时加载（`patchReload: startup`），所以已在运行的实例会保留旧副本直到重启。
