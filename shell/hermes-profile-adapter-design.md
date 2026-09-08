# Hermes Profile → dsh Preset 录入兼容层 — design (draft for review)

Status: proposed. Working notes, not committed docs.

## Goal

把一个 Hermes Agent profile(如 `pm-certification-android-xts`)**
录入**为 dsh preset,使 dsh 会话能以该 Hermes profile 的角色身份工作:
同样的人格(SOUL)、同样的模型、同样的 skills、同样的工作区 ——
但**运行时零 Hermes 依赖**(纯 dsh preset + dsh 原生 skill/模型机制)。

定位:这是**录入转换器**(一次转换,产出 dsh 格式文件),不是运行时适配器,
也不是让 dsh 执行 Hermes workflow。转换后与源 profile 解耦,后续在 dsh
侧独立演进。

## 背景事实(已逐项核实)

### Hermes profile 组成(`pm-certification-android-xts` 实测)

| 文件/目录 | 内容 |
|---|---|
| `profile.yaml` | 角色描述(PM Agent)+ `description_auto: false` |
| `config.yaml` | `model.provider=deepseek / default=deepseek-v4-flash / base_url=qlitellm`;`skills.external_dirs`(共享+专属两目录);`terminal.cwd` |
| `SOUL.md` | 人格:身份/核心目标/基本原则/职责/标准工作流(01-07)/GMS 路由与交办协议/TaskContext 规则 |
| `skills/<cat>/<skill>/SKILL.md` | 技能库,frontmatter 含 `name`+`description`(+version/author/metadata 等) |
| `skill_from_server/` | profile 专属技能(MCP 拉取所得) |
| `.env` | per-profile secrets(DEEPSEEK_API_KEY 等) |
| `workspace/` | 工作目录 |

派发模型:Hermes 用 `hermes -p <profile> chat -q '<转交单>'` 孵子进程,
SOUL 里 PM 路由到下游 rd-* profile,TaskContext 跨 agent 透传。

### dsh preset 组成(实测)

`~/.dsh/presets/<id>/`(或 agent-presets 配置根)下的目录:

| 文件 | 作用 |
|---|---|
| `agent.cordis.yml` | 组合(必需):插件行列表;`persona` 经 `@deepseek-ai/dsh-persona` 的 `config.text` 注入(支持 `{{model}}`/`{{cwd}}`);skills 行等 |
| `preset.yml` | 显示元数据(可选):name/description/order |
| `profile.yml` | node profile(可选):persona+toolFilter,workflow 子 agent 用 |
| `skills/...` | 自带技能(样例 cordis preset 有) |

- dsh skill 机制:`skill-filesystem` provider 扫描 `<cat>/<skill>/SKILL.md`
  与 flat `.md`,frontmatter 需 `name`+`description`,其余字段忽略不报错。
- preset authoring 现有能力:整目录拷贝既有 preset(`copyComposition`),
  不支持"从 Hermes 目录新建映射"。

### 兼容性结论(逐项)

| Hermes | dsh | 兼容 |
|---|---|---|
| config.yaml model | agent.cordis.yml 的 model 行 | ✅ 同 provider/model 概念 |
| SOUL.md | persona(config.text) | ✅ 需净化(剔除 Hermes 运行时指令) |
| skills SKILL.md | skill-filesystem | ✅ **格式天然兼容**(同布局+name/description) |
| terminal.cwd | session 工作区 | ✅ |
| .env secrets | dsh credentials/.env | ✅(需手动/引导配置) |

## 转换映射

### 目录产出

```
输入: <hermes-profile>/ (pm-certification-android-xts)
输出: <dsh preset root>/<preset-id>/
  ├─ preset.yml          name/description ← profile.yaml.description
  ├─ agent.cordis.yml    组合 ← SOUL(净化)→ persona;model ← config.yaml
  ├─ profile.yml         node profile:persona + toolFilter(可选)
  └─ skills/             skills/** 原样拷入(<cat>/<skill>/SKILL.md)
```

### 字段级转换规则

1. **preset.yml**
   - `name`:profile.yaml 角色名 或 profile 目录名
   - `description`:profile.yaml.description

2. **agent.cordis.yml persona**
   - 提取 SOUL.md 的「身份 / 核心目标 / 基本原则 / 职责范围 / 标准工作流 /
     路由规则 / 交办与回收协议 / TaskContext 规则」
   - **剔除**(Hermes 运行时专属,转换时净化):
     - `/reload-skills`、`hermes -p ... chat -q` 等 CLI/会话机制指令
     - MCP skill 拉取规则(SKILL.md 已拷入,无需运行时拉取)
     - `profile_key` 等 Hermes 特有字段(保留其"路由意图",改写为 dsh 子 agent 概念)
   - 下游路由:SOUL 里 `hermes -p rd-x` 改写为 dsh subagent/preset 语义或
     "建议由外部/子 agent 完成",标注为映射点
   - 注入 `@deepseek-ai/dsh-persona` config.text,可保留 {{model}}/{{cwd}}

3. **model**
   - config.yaml model.provider/default → agent.cordis.yml 的 model 行;
   - base_url(qlitellm)若 dsh 该 provider 不支持自定义 base_url,则用 dsh
     provider 的同名模型,标注差异

4. **skills(拷贝模式)**
   - `skills/**`(含 `skill_from_server/` 专属技能)原样拷入 `preset/skills/`,
     保留 `<cat>/<skill>/SKILL.md` 结构(frontmatter 兼容)
   - **dsh 侧索引**:preset 的 agent.cordis.yml 须含一条 `skill-filesystem` 行,
     `customSkillDirs` 指向 preset 自身 `skills/`(用 `baseUrl` 相对引用,
     使 preset 拷到哪都能解析)—— 模板见 cordis preset:
     ```yaml
     - id: skill-filesystem
       name: '@deepseek-ai/dsh-skill-filesystem'
       config:
         customSkillDirs:
           - !!js "process.getBuiltinModule('node:url').fileURLToPath(new URL('skills/', baseUrl))"
     ```

5. **.env / 密钥**
   - 不拷贝;转换器输出指引:录入者把 DEEPSEEK_API_KEY 等配到 dsh credentials 或
     profile 对应 .env

6. **profile.yml(node profile,可选)**
   - persona 简版(身份一句话)+ toolFilter 从 skills/所需工具推断;供 workflow
     `agent({profile})` 派发该角色

## 录入命令形态(dsh 内置命令)

用户选择:**dsh 内置命令**,让 agent/人在 dsh 侧发起录入。

候选落点(待实现时定):
- **CLI**:`dsh preset import-hermes <hermes-profile-dir> [--id <preset-id>]`
  (apps/cli,仿 `dsh plugin` commander 子命令)
- 或 **agent tool / preset authoring 扩展**:会话内 agent 读 Hermes 目录 → 生成
  preset(经 `agent-presets` authoring 写入用户 preset 根)

倾向:CLI 为主(可脚本化/可测),agent tool 后置。转换逻辑抽成共享函数
(读 Hermes 字段 → 产出 dsh 文件),CLI 与 tool 同源。

## 边界与风险

- **SOUL 净化是核心难点**:Hermes 指令与人格混排,需一套提取/剔除规则;
  过度剔除丢人格,欠剔除残留 Hermes 指令(dsh 里无效甚至误导)
- **model base_url**:dsh 若无法连 qlitellm 自定义端点,模型能力不等价
- **skill 运行时差异**:Hermes skill 的 scripts 可能依赖 Hermes 工具/MCP 环境,
  拷入后模型能看到,但执行可能失败 → 需要 skill 分类(纯文档型可用 / 需适配)
- **下游 rd-* profile 未建**:转换器只转换本 profile;跨 profile 路由需 dsh 侧
  另配(多个 preset + subagent)
- **Hermes hooks / MCP / managed overlay**:不进 dsh,忽略并记录

## 验证路径

1. 转换 `pm-certification-android-xts` → `~/.dsh/presets/pm-certification-android-xts/`
2. dsh 会话选该 preset → 确认:
   - persona 生效(以 PM 身份回话,遵循 GMS 路由规则)
   - skill-filesystem catalog 能发现 certification/* skill
   - 模型为 deepseek-v4-flash
3. 手工跑一次"需求定义→任务分解"流程,验证 SOUL 工作流指令在 dsh 可执行

## Open questions

- 转换器落点:`dsh preset import-hermes`(CLI)vs preset authoring 扩展(agent tool);
  倾向 CLI,共享转换函数
- **model base_url**:dsh 是否支持为 provider 配自定义 base_url(qlitellm)?当前 alice
  走 quectel 无自定义端点;若 dsh 无法连 qlitellm 自定义端点,需改用 dsh 原生
  provider 同模型或接受能力差异 —— 待查 llm 适配器配置面
- SOUL 净化规则是否需要可配置(不同 Hermes profile 结构差异)?
