# Agent Note: A2UI 提交记录为折叠的上下文 notice

Status: implemented

[English](2026-09-09-a2ui-submission-notice-context.md) | 中文

## 问题

A2UI 的动作或表单提交经普通输入机进入对话，因此聊天区把它渲染为完整的用户提示气泡：原始 JSON（`{"a2uiAction": { ... }}`，含 `surfaceId`、`actionId`、`instruction` 与 `values`）与可交互页面并排出现在 transcript 中。该载荷是机器到模型的信封，不是人类消息，把它显示为用户气泡会污染对话，让用户看到自己从未输入过的文本。

## 决定

A2UI 动作与表单提交以插件 `notice` 来源记录为 `user/message`，而不是用户来源，因此聊天区渲染折叠的一行上下文行，模型仍完整收到载荷。

- **主机 prompt 上下文。** `SessionPromptRequest` 新增可选 `context: { plugin, form: 'notice', summary }`。存在时，`commands.prompt` 把消息来源标记为 `{ kind: 'plugin', plugin, form: 'notice', summary }` 而非 `{ kind: 'user', rpcId }`；模型可见内容不变，因此面向模型的契约（model-visible ⟺ logged）成立。
- **客户端 notice 提交器。** `ui-a2ui` 浏览器插件在 `ctx.remote.session.prompt` 之上构建 `submitNotice`；launcher 对 `a2ui/submit`（摘要 = 页面标题）与 `a2ui/action`（摘要 = 动作 `instruction`，回退到 `tool` 再回退到 `id`）调用它。拒绝的受理会 reject 该 promise；launcher 发起后不再等待，但仍向弹窗 ack。
- **摘要是受限的单行描述。** notice 摘要遵循既有的折叠行契约（`CONTEXT_SUMMARY_MAX_CHARS = 120`）；launcher 在发送前截断更长的标题／指令。

## 考虑过的替代方案

**渲染完整提示气泡但剥离 JSON。** 呈现友好的「已提交」一行，同时让原始信封不出现在视图中。否决：持久日志必须携带确切的模型可见文本，而呈现无法与所记录内容分叉，除非引入对话契约所没有的新「隐藏可见性」概念。

**专用结构化提交通道。** 新增一条区别于 `user/message` 的 wire 事件，以类型化方式携带载荷。否决：模型把 A2UI 提交作为普通 user 角色消息消费，因此独立通道仍须汇入同一模型输入，且会为模型不可见的增益而重复现有 prompt 路径。

**在客户端把 prompt 标记为 `hidden`。** 给对话节点契约增加隐藏可见性。否决：不存在这样的概念，凭空新增会影响所有节点渲染器；notice 形式是仓库已有的折叠非用户内容的做法。

## 后果

A2UI 提交不再渲染为用户气泡；transcript 显示折叠的 `a2ui` 上下文行与单行摘要，模型可见 JSON 只在展开时出现。`session/prompt` 请求类型新增可选字段，经 Typert 生成的客户端 remote 反映到两个 SDK。提交绕过输入框／输入机，因此 A2UI 提交没有草稿交互、忙碌阶段门控或乐观回显——受理失败只表现为一个被 reject 的 promise。
