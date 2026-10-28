# Agent Note: Terminals confined to mounted device workspaces

Status: implemented

[English](2026-10-28-mount-scoped-terminals.md) | 中文

## Problem

团队 shell 部署在一台共享服务器上为每个账号运行一个 dsh Web 实例，成员还可以另外配对自己的机器，其根目录以挂载工作区出现在 hub 的影子树下。侧边栏终端通过 Host 上的 `ctx.subprocess.spawnTerminal` 分配 PTY，因此在挂载会话里它打开的是服务器上的 shell，工作目录是影子目录 —— 看起来像成员的机器，其实不是，`pwd` 只是同步副本。在账号自己的工作空间里它同样打开服务器上的 shell，而这正是运营方根本不想提供的东西：共享服务器上的 Web 终端就是一个以实例账号身份运行的 shell，与成员自己的机器毫无关系。

这层限制不能只放在终端 UI 里。Client 决定渲染什么，但分配是 Host 调用，任何 Client 构建都可以直接发起请求。

## Decision

`terminal-controller` 新增 `mountedWorkspaceRoot` 配置。部署设置它之后，会话只有在其工作空间就是该根或位于其下时才能打开终端，也就是只有挂载设备的工作区才可以。其他会话从 `availability` 得到 `{ available: false, reason: 'not-mounted-workspace' }`，并且 `create` 以 `terminal/not-mounted-workspace` Remote 错误拒绝。于是 Client 的渲染只是对 Host 决定的呈现，而不是决定本身。

团队 shell 负责写入这一行。`regionRouterPatchYaml` 在它已经置备的 region 路由块旁边输出一段 `terminal-controller` 配置，使用与它们相同的 `shadowRoot` 值，因此「挂载树在哪里」这一个部署事实同时决定路由、文件系统与终端资格。从不设置它的部署保持上游行为：每个工作空间都可用。

Client 引导卡在每次挂载时读取一次 `availability`，被拒绝时把卡片渲染成一段纯说明，既没有启动按钮，也没有 shell 菜单和快捷键提示。查询失败刻意不被当成拒绝：读不到的答案回退到可启动状态，让 Host 去拒绝它必须拒绝的分配 —— 因为一次瞬时 RPC 失败就把本来可用的终端隐藏起来，比显示一个 Host 会拒绝的终端更糟。

## Alternatives considered

**只在 Client 引导卡里做门禁。** 不采纳：任何绕过引导卡直接请求的调用方仍会拿到 PTY，包括限制生效之前发布的旧 Client 包。拒绝必须放在分配发生的地方。

**新建 `mountedWorkspaces` 能力 seam。** 暂不采纳：「这个工作空间是不是挂载」只有一个布尔问题，却需要一个 Service Definition、`shell/` 里的提供方、一个 invariant 和一个消费方，而终端路径本身已经握有输入（它配置的根与会话记录的 cwd）。当出现第二个消费方提问，或必须解析某个挂载是否在线时，seam 才有价值；眼下两者都不成立。

**与 hub 的实时挂载表比对。** 不采纳：这会让终端资格依赖分配时的一次 hub HTTP 调用，hub 只是在瞬间变慢也会让健康挂载上的终端被拒。影子根是部署常量，而会话的工作空间要么在它里面，要么不在。

**团队部署里对所有会话一律拒绝终端，不提供配置。** 不采纳：这层限制来自「共享服务器上一人一实例并配对设备」这一部署形态，而不是包本身的性质。没有挂载的部署没有理由失去终端，写死拒绝等于替它做了选择。

## Consequences

成员的挂载会话保留终端；成员的服务器工作空间会话失去终端。因为门禁依据的是工作空间路径而不是挂载是否在线，挂载离线的会话仍会报告可用，然后在分配时失败 —— 终端报告的是提供方失败而不是限制，这是对实际发生之事的诚实描述。

PTY 仍然运行在 Host 上、以影子目录为工作目录，而不是运行在配对的设备上。把终端路由到设备自己的 shell 需要在 hub 线协议上承载 PTY，[region 设计](../../../../shell/design.md) §13.6 将其列为「暂缓，非否决」；在此之前，这层限制确保终端不会冒充它并非之物。

覆盖：`packages/api/terminal-controller/tests/controller.spec.ts` 固定了拒绝、根本身与其下的接受、未配置时的默认行为以及取消；`packages/client/ui-sidebar-terminal/tests/terminal-guide.client.spec.tsx` 固定了替换后的卡片、查询失败时的回退，以及卸载后的拒绝。
