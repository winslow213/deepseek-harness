# Agent Note: A2UI 控制台跟随最新输出

Status: implemented

[English](2026-09-10-a2ui-console-follow-tail.md) | 中文

## 问题

A2UI 弹窗的命令运行与实时结果面板把输出渲染进一个固定高度的 `<pre>`（`max-height: 220px; overflow: auto`）。客户端包里完全没有任何滚动跟随逻辑，于是当流式运行增长到超过可见窗口后，最新输出滚出视野，面板一直钉在顶部——模型和用户必须手动滚动才能看到进度，尤其像 `hdc shell hilog` 这样的长流几乎不可读。

## 决策

`packages/client/ui-a2ui-render/src/standalone.tsx` 新增一个 `ConsoleBody` 组件，为每个面板持有一个跟随器：

- 一个 `useRef` 的 "follow" 标志初始为 `true`，每当 `runKey` 变化（一次新的命令运行，或一条新的实时流）时重新置为 `true`。
- 一个依赖 `text` 的 `useEffect` 在跟随时把 `scrollTop` 钉在 `scrollHeight`。
- `onScroll` 在用户向上滚动（距底部超过 24px）时解除跟随，回到底部时重新跟随——这是标准的终端跟随交互。

两处 `<pre className={css.consoleBody}>` 都被替换为 `ConsoleBody`：运行面板以 `run.runId` 为键，实时面板以常量 `"live"` 为键（该面板仅在 `live.active` 时渲染）。

## 备选方案

### 为什么不在每次渲染时做一行 `scrollTop = scrollHeight`？

那会与用户打架：任何向上滚动阅读早先输出的尝试都会被立刻弹回底部。follow/detach 标志才是让行为可用的关键。

### 为什么不用外部自动滚动库？

这个行为只有十几行，且该包已经 import 了 `useRef`/`useEffect`；为单个效果引入依赖，带来的东西手写版本已经都有了。

### 为什么不改为加一个「跳到底部」按钮？

那是一个合理的未来增强，但不能替代跟随；在流式运行期间，模型和用户希望无需交互就能看到进度。

## 后果

- 流式运行与实时结果输出现在在跟随时始终钉在最新一行；向上滚动解除跟随，回到底部（或新的运行）重新跟随。
- 无新增依赖；改动局限于 standalone 渲染器。
- 该改动仅客户端侧，通过 web bundle 构建发布。
