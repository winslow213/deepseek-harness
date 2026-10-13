# Agent Note：tsconfig paths 映射中的跨 face 工作区子路径别名

Status: implemented

[English](2026-10-12-cross-face-workspace-subpath-aliases.md) | 中文

## Problem

`tsconfig.base.json` 是唯一一张 `paths` 映射，供所有程序解析工作区导入：两个编译聚合、各 vitest 配置，以及由 `tsx` 启动的脚本。写入者有两类：`BEGIN generated package aliases` 与 `END generated package aliases` 标记之间的生成区由 `scripts/gen-tsconfig-paths.ts` 产出；该区域之上全部为手写。

生成器只映射裸包名。`collectPackageNames` 读取工作区包列表，`mappedSpecifiers` 只识别形如 `"@deepseek-ai/dsh-<name>"` 的键，因此 `…/types` 或 `…/client` 这类子路径别名既不会被生成，也不会被检查。`uncoveredPackages` 报告没有别名覆盖的包，但比较的是裸包名，因此未登记的子路径能通过所有门禁。

未登记的子路径仍能解析——经由工作区符号链接与包自身的 `exports` 映射——但解析到构建产物 `lib/`。`packages/web/tool-a2ui-data` 声明 `"./types": { "types": "./lib/types/types.d.ts" }`，因此未带别名而触及该说明符的消费者会离开源码面进入产物面，而这正是这些别名要防止的。

该失败的形态也不像缺少模块。`packages/api/remotes/src/client/index.ts` 跨 Host/Client face 边界重导出 A2UI 数据类型，Client 聚合会分析该重导出。当子路径解析到 Typert 无法作为源码读取的声明时，face 分析器在没有任何源文件的情况下调用 `getSymbolAtLocation`，并在 `getSymbolLinks` 内抛出 `Cannot read properties of undefined (reading 'flags')`，该消息既不指名包也不指名子路径。

## Decision

**程序解析的每个子路径都在生成区之上的块中手工登记，别名指向声明它的 `src` 文件。**

`"@deepseek-ai/dsh-tool-a2ui-data/types": ["./packages/web/tool-a2ui-data/src/types.ts"]` 加入已有的那些条目。该块还承载其他必须手写的情形：目录名与 npm 名不一致的包（`sdk/`、`util/`），以及需要以源码模式解析动态导入的浏览器半边。

生成的 Typert Remote 声明有意不在此列。它在两个 face 上都以构建产物消费，因此把它映射到源码会用缺少默认导出的模块取代 Client 加载的生成默认导出。

## Alternatives considered

**从各包的 `exports` 映射推导子路径别名。** 否决：每个 `exports` 目标都是 `lib/` 路径，据此生成会把该门面本就用于规避的产物面固化下来，并且还会牵入必须留在构建产物上的生成项 `/remote` 与 `/typert`。

**让生成器对未登记的子路径报错。** 否决：生成器只能看到它已经产出的说明符，而子路径只能从消费者的导入中发现。让 `uncoveredPackages` 保持在裸包名范围，使该门禁的规则可核查，而例外仍留在手写块中。

**把所有子路径都解析到源码并取消这些例外。** 否决：Remote 与 Typert 子路径没有源码面等价物，因为它们的内容在 Host 构建期间生成。

## Consequences

某包新增一个被其他包导入的子路径时，需要一行手写登记。漏掉它会引发不指名任何文件的 Typert 崩溃，而 `verify-tsconfig-paths` 不覆盖手写块，因此没有任何机制把这种遗漏变成门禁失败。

Client 聚合现在把 A2UI 数据类型解析到声明它的源文件，而不是构建产物。
