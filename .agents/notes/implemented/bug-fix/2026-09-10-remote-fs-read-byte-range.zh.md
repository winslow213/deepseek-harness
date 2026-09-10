# Agent Note: 远程文件系统支持字节区间读取

Status: implemented

[English](2026-09-10-remote-fs-read-byte-range.md) | 中文

## 问题

文件系统接缝的 `FileSystem` 抽象类新增了 `readByteRange(target, { offset, length })`，但远程 provider（`shell/src/remote/fs-provider.ts`）从未实现它，导致 `RemoteFileSystem` 作为非抽象子类无法通过类型检查。本地 provider 通过 `readByteWindow` 读取有界窗口；远程 agent 没有对应的 wire op，hub/client/protocol 链路也无法承载窗口。

## 决策

字节区间读取贯穿远程 fs 路径的每一跳：

- `agent-fs.ts` 新增 `readByteRange(absolutePath, offset, length)`，对齐本地 `readByteWindow` 语义：普通文件检查、不解码、不拒绝二进制、`length === 0` 或窗口越过 EOF 时返回空、有界缓冲（任何时候只持有 `length` 字节）。
- `protocol.ts` 为 `FsOpRequest.op` 增加 `readByteRange`，并增加 `offset`/`length` 字段。
- `agent.ts` 处理 `case 'readByteRange'`，把窗口作为 base64 返回。
- `hub.ts` 转发 `readByteRange` 并中继 `offset`/`length`；`client.ts` 扩展 `FsOpSpec`。
- 两个远程 provider 都实现该 override：`fs-provider.ts`（`RemoteFileSystem`，`remote inject` 路径）与 `region-router.ts`（`RegionRouterFileSystem`，region-router 路径）——后者把影子树目标转发给所属 agent，本地目标委托给继承的 `readByteRange`。

## 备选方案

### 为什么不从整文件 `readBytes` 合成区间？

那会拉取整个文件（直到 `maxBytes` 上限）再在客户端切片，违背窗口的初衷——只读任意大文件中被请求的那些字节，而不缓冲其余部分。

### 为什么不保持未实现并放宽子类检查？

接缝契约要求该方法；省略它只会掩盖一个能力缺口，真实调用方（二进制/部分文件读取）会在运行时撞上它，正如远程 shell 缺失的 `createOutputReader` 一样。

## 后果

- `RemoteFileSystem` 现在满足完整的 `FileSystem` 抽象表面；executor tsconfig 干净。
- 对挂载根目录的字节区间读取是有界的：调用方可以拉取大型远程文件的窗口，而无需传输整个文件。
- 无需重启 daemon——`fs-provider.ts` 运行在 per-user dsh 实例内；agent 侧 `agent-fs.ts`/`agent.ts` 的改动在用户重新部署挂载 agent（打包的 `dsh-mount-agent`）后生效。
