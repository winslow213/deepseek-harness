# Agent Note: 团队 shell 改挂真正注册模型 provider 的插件

Status: implemented

[English](2026-10-13-team-shell-llm-provider-package.md) | 中文

## 问题

`writeTeamLlmPatch`（`shell/src/spawn-user.ts`）写出 home 级 `cordis.patch.yml` 块，为每个账号提供 DeepSeek 端点与密钥引用。它挂的是 `@deepseek-ai/dsh-llm-deepseek`。

上游 `0.2.1-alpha.2` 把该包拆开了：插件本体 —— 导出 `name`、`apply` 与 `PROVIDER = 'deepseek-official'` 的那份 —— 迁到了 `@deepseek-ai/dsh-llm-deepseek-api-key`，而 `@deepseek-ai/dsh-llm-deepseek` 变成只导出 `registerDeepSeekProvider` 的共用 Messages adapter 库。挂一个库不会注册任何 provider。

这个失败是静默的。patch 块、`DSH_LLM_API_KEY`、`DSH_LLM_BASE_URL`，以及 `settings.yaml` 里的 `agent-default-model.provider: deepseek-official` 全部保持正确，实例启动既无报错也无告警。唯一可观测的现象是模型目录：`session/modelCatalog` 返回 `routableProviders: []` 且没有任何分组，于是没有任何账号能选到或跑起模型。

验证第一个问题时又暴露出第二个独立缺口。该块没有设置 `models:`，账号因此继承 adapter 的 `DEFAULT_MODELS`，而那份清单已从四条缩到两条 —— 丢掉了账号原本在用的视觉模型 `deepseek-v4-flash-vision-exp`。团队端点提供九个模型，所以端点侧没有任何理由造成这次丢失。

## 决策

`writeTeamLlmPatch` 现在挂 `@deepseek-ai/dsh-llm-deepseek-api-key`，即 `packages/bundle/base/cordis.patch.yml` 为这条路由挂的同一个插件。

该块也显式写出 `models:`，通过 `TEAM_MODELS` 表钉住 `deepseek-flash`、`deepseek-v4-pro` 与 `deepseek-v4-flash-vision-exp`，其中接受图像的两个带 `inputModalities: [text, image]`，并保留 Flash 上游的缓存兼容标记。团队的模型清单从此由 shell 明示，而不再是继承的运行时默认值。

`shell/tests/team-llm-patch.spec.ts` 把两者都钉住：它读取渲染出的块，通过工作区 manifest 把挂载的包名解析到该包的 `src/index.ts`，断言源码导出 Cordis 插件并声明 `PROVIDER = 'deepseek-official'`。包名对照真实导出而非字符串，所以上游下一次重命名会在这里失败，而不是在生产里失败。

出于同一原因 —— shell 依赖的若干值只是恰好在最初那次部署里成立 —— 又有两项相邻的部署事实变成可配置：

- `TEAM_SESSION_COOKIE`（默认 `dsh_team_session`）命名账号服务签发、proxy 读取的登录 cookie。浏览器按 host 划分 cookie 而忽略端口，所以同一 host 上的第二个团队 shell 会顶掉第一个的登录，换任何端口都无法把它们分开。
- `TEAM_MANDATORY_BUNDLES` 取代硬编码的钉版插件表。不设置则保留 0.1.x 钉版；设置（包括设为空字符串）即为准，使 0.2.x 运行时在 provision 账号时不必为一次注定被拒的安装付一次 registry 往返。

## 考虑过的替代方案

### 继承 adapter 默认目录，不钉 `models:`

这正是该块原来做的，也正是它静默丢掉视觉模型的原因。adapter 的默认目录归运行时发版所有，而不是归本次部署所有：它在本文涉及的两个版本之间已经变过一次，而一个把模型可见性建立在它之上的部署，没有任何地方可以声明成员实际应该看到什么。钉住的代价是 `spawn-user.ts` 里多一张表，换来的是账号可见目录在 patch 里可审阅。

### 两个包都挂，或把库与插件并列挂

`@deepseek-ai/dsh-llm-deepseek` 是 `llm-deepseek-api-key` 的依赖，不是插件；挂它只会多出一条毫无贡献的条目，并让 `dsh-llm-deepseek` 这个 id 继续指向一个没有 `apply` 的包。一条条目、写出注册该路由的包名，才是配置格式期望的写法。

### 只修包名，不动目录

不接受，因为两个缺口同源：团队 patch 用"引用运行时默认值"的方式描述自己的 LLM 配置，而那些默认值已经从底下移走了。只修包名会让视觉模型继续静默缺失，也会让下一次默认值变动除了察觉到的成员之外无人可见。

### 回退到继承的 `DEEPSEEK_API_KEY`，不显式命名凭据引用

那是插件自身的默认值（`apiKeyEnv: z.string().role('credential-ref').default('DEEPSEEK_API_KEY')`）。显式命名 `DSH_LLM_API_KEY` 可让团队密钥不落在成员自有工具也可能设置的变量里，也与周围各团队 patch 块的既有写法一致。

## 后果

- 账号重新获得可路由的 `deepseek-official` provider 与钉住的三个模型。已对实际启动的实例验证：`routableProviders: ["deepseek-official"]`，分组为 `deepseek-flash`、`deepseek-v4-pro`、`deepseek-v4-flash-vision-exp`。
- 本文所针对的失败模式在构造上就是静默的。一个插件名错误、一次包拆分，或一条指向非插件的条目，产出的都是一个能启动、patch 看起来正常、而目录为空的实例。回归测试是唯一会报告它的东西；`team-llm-patch.spec.ts` 失败应当视为阻断生产的问题，而非文档漂移。
- 其余团队 patch 块存在同类错误 —— `writeTeamSandboxPatch`、`writeTeamDirectoryPickerPatch`，以及 region、wiki、KB 各注入器都写出插件名。上游拆分或重命名其中任何一个都会以同样的静默方式失败。本次改动已逐一对照各自包的导出核验；只有 LLM 那一处是错的。
- `TEAM_SESSION_COOKIE` 不设置则逐字节复现今天的行为。在既有部署上设置它会让所有成员被登出一次，因为浏览器里的旧 cookie 不再被读取；Redis 会话仍在，代价仅是一次重新登录。
- `TEAM_MANDATORY_BUNDLES` 不设置则保留 0.1.x 钉版。运行时拒绝这些插件的部署应把它设为空，而不是让行为停留在每次 provision 都尝试一次被拒的安装。
