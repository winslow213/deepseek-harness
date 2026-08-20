# 天问星（Tianwenxing）改造计划

本文件记录把 deepseek-harness 改造成个人垂直业务 agent 应用「天问星」的两阶段计划。目标：保留全部原始能力，通过 profile 补丁层定制人格与模型；Phase 2 新增 A2UI 动态页面，模型直接生成页面 JSON，由 Web UI 原生渲染，业务流用既有 workflow 能力编排。

## Phase 1：天问星骨架（已完成）

纯配置改造，不修改仓库代码。所有产物都在 `$DSH_HOME`（`~/.dsh/`）下。

### 目标

- 保留 deepseek-harness 全部原始能力。
- 通过 profile 补丁层定制人格、默认预设与默认模型。
- 双模型路由：本地 Ollama（开发）与 DeepSeek API（生产）并存，可随时切换。

### 落地文件

| 文件 | 作用 |
|---|---|
| `~/.dsh/profiles/tianwenxing/package.json` | 声明 bundle 层依赖（`@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`） |
| `~/.dsh/profiles/tianwenxing/cordis.patch.yml` | 用户补丁层：默认预设 `tianwenxing`、部署层兜底人格、默认模型 `ollama/deepseek-r1:14b` |
| `~/.dsh/.agent-presets/tianwenxing/agent.cordis.yml` | 天问星 agent 预设：专属 persona（`dsh-persona`）+ 完整工具集（由 `standard` 派生） |
| `~/.dsh/.agent-presets/tianwenxing/preset.yml` | 预设元数据：显示名、描述、排序 |
| `~/.dsh/settings.yaml` | 用户层配置：双 provider 路由（`llm-pi-ai` 本地 Ollama + `llm-deepseek` DeepSeek API）、Ollama `apiKeyEnv` |
| `~/.dsh/.env` | `OLLAMA_API_KEY=ollama`（占位 key，Ollama 不需要真实密钥） |

### 关键机制

- **Profile/Bundle 组合**：应用顺序为 base bundle → web-app bundle → profile 补丁 → `$DSH_HOME/cordis.patch.yml` → `--patch` 覆盖层；补丁按 id 定位行并整行替换 config（不合并）。
- **Agent 预设遮蔽部署层 persona**：预设自带的 `dsh-persona`（注册为 `deployment:persona` section，order 0）会遮蔽部署层 `system-prompt.persona`，所以人格真正生效处是预设。
- **Agent preset 在会话创建时冻结**：默认预设只对新建会话生效；旧会话保留创建时的预设，需要开新会话才能吃到新人格。
- **配置优先级**：`agent-default-model` 的 settings 用户层配置覆盖 profile 补丁层配置（Web 模型选择器切换即写入 settings）。

### 验证结果

- 服务运行于 `http://127.0.0.1:3081`（`tianwenxing` profile）。
- 新建会话默认挂载 `tianwenxing` 预设，`request/header` 日志中 system 提示词包含天问星人格，模型不再自报 DeepSeek 身份。
- 本地 Ollama 对话正常。

### 遗留事项

- 默认模型路由：`settings.yaml` 的 `agent-default-model` 当前为 `qwen3.5:9b`（Web 模型选择器写入），覆盖了补丁的 `deepseek-r1:14b`。如需本地默认 deepseek-r1:14b，需改回并确保 Ollama 已加载该模型。

## Phase 2：A2UI 动态页面（开发中）

核心新特性：模型直接生成页面 JSON，Web UI 原生渲染动态页面；业务流用既有 workflow 能力编排。

### 目标

- 宿主侧提供 A2UI 工具，让模型能产出页面 JSON 并持久化到会话。
- 客户端侧原生渲染该页面 JSON，支持与页面交互。
- 用 workflow 能力编排多步骤业务流。

### 工作分解

1. **宿主工具插件**：实现 `a2ui_surface` 工具（模型产出页面 JSON）+ session 落库。✅ 已完成
2. **客户端渲染插件**：React 渲染器 + 会话面板，将页面 JSON 渲染为可交互 UI。✅ 已完成
3. **workflow 集成**：业务流经 workflow 编排，将 A2UI 页面接入既有 workflow 能力。（未开始）
4. **装配与验证**：装配到 profile/preset，验证模型生成页面并完成交互闭环。装配 ✅，真机交互验证 ⏳

### 落地代码（仓库侧）

| 产物 | 说明 |
|---|---|
| `packages/web/tool-a2ui-surface/` | A2UI 宿主工具插件：`a2ui_surface` 工具 + `a2ui/surface` 事件落库 + invariant + 测试 |
| `packages/client/ui-a2ui/` | A2UI 客户端插件：`a2ui-surface` Conversation 定义 + `A2uiPanel` 原生表单渲染器 + locales + 测试 |
| `packages/bundle/base/cordis.patch.yml` | base bundle 注册 `tool-a2ui-surface`（open-only，`allowUpdate: false`） |
| `packages/bundle/web-app/cordis.patch.yml` | web-app bundle 注册 `ui-a2ui` 客户端插件，禁用 base 工具行（改由 preset 挂载） |
| `apps/cli/config/agent-presets/standard/agent.cordis.yml` | standard 预设注册 `tool-a2ui-surface`（`allowUpdate: false`） |
| `~/.dsh/.agent-presets/tianwenxing/agent.cordis.yml` | 天问星预设注册 `tool-a2ui-surface`（`allowUpdate: true`，允许模型更新页面） |
| `docs/tool-catalog.md` / `docs/persistence-catalog.md` | 工具目录与持久化目录重新生成，收录 `a2ui_surface` 与 `a2ui/surface` |

### 待办状态

- [x] p2-tool：实现 A2UI 宿主工具插件
- [x] p2-client：实现 A2UI 客户端渲染插件
- [x] p2-assembly：装配到 base/web-app bundle + standard/tianwenxing preset + tsconfig + 目录再生成
- [x] p2-verify：typecheck + 测试 + build 全绿
- [ ] p2-e2e：启动天问星服务，用真实模型调用 `a2ui_surface` 生成页面，验证表单渲染与提交闭环
- [ ] p2-workflow：把 A2UI 页面接入 workflow 多步骤业务流
