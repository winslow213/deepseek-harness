# WebUI Plugin Install — 交接清单（Phase A + B 已交付）

> 供后续 agent 接手。设计决策与来源见 `shell/plugin-install-design.md`；
> 本文件只记录「已交付什么、在哪些文件、如何验证、还剩什么」。

## 1. 状态总览

- **Phase A**（host Remote 服务 `@deepseek-ai/dsh-host-plugin-install`）✅
- **Phase B**（Web Settings 标签页 `@deepseek-ai/dsh-client-ui-settings-plugin-install`）✅
- **Phase B 追加能力**（在线验证阶段提出）✅
  - npm 完整命令安装（`parseNpmSpec` 接受 `dsh plugin --profile web add <spec>` / `pnpm add <spec>`）
  - upload-directory 目录上传（webkitdirectory 选择器 + base64 Remote 通道）
- 全部门禁通过：typecheck、40 tests、lint 0 error、doc-sync 32/32、build:lib 重建。
- 在线验证通过：`DSH_PLUGIN_INSTALL=true pnpm dsh --profile web` → http://127.0.0.1:3080，
  Settings → Plugins → **Install plugin** 标签页（与只读的 Inventory 标签并列）。

## 2. 已交付能力（三个表单）

1. **file-dir**：id + 本地插件目录绝对路径 → 复制到 `profiles/<name>/plugins/<id>/`，
   无 package.json 时写 name-less 松散插件清单，向 `cordis.patch.yml` 追加 idempotent 的
   `- insert:` 行（同 id 替换、不重复）。
2. **npm-bundle**：裸 spec 或完整 `dsh plugin --profile <name> add <spec>` /
   `pnpm add <spec>` 命令 → 提取尾部 spec（剥引号）→ profile 目录内 `pnpm add` →
   `reconcileProfileBundles` 提升带 `dsh.bundle` 的包进 `dsh.profile.bundles`；
   无 bundle 的包作为普通依赖安装。
3. **upload-directory**：id + 浏览器目录选择 → 文件按相对路径 base64 经 Remote 落盘
   `plugins/<id>/` → 登记同一 patch 行。安全上限：512 文件、单文件 1 MiB、总计 10 MiB；
   拒绝绝对路径 / `..` 逃逸 / 非普通文件（`plugin-install/invalid-spec`）。

门控：`DSH_PLUGIN_INSTALL=true`（操作员显式开关，默认关闭；UI 与 Remote 同开关注册）。

## 3. 文件清单

### 新增包

| 路径 | 说明 |
| --- | --- |
| `packages/host/plugin-install/` | host Remote 服务。`src/index.ts`（`PluginInstallGateway` + `parseNpmSpec` + 目录上传落盘/校验）、`src/types.ts`（spec/result/错误码）、`tests/install.spec.ts`（27 tests）、README 双语 trio |
| `packages/client/ui-settings-plugin-install/` | 浏览器标签页。`src/client/PluginInstallSettingsTab.tsx`（三表单 UI + 状态机）、`src/client/locales.ts`（中英字典）、`PluginInstallSettingsTab.module.css`、注册入口、`tests/`（组件 8 + 注册 5）、README 双语 trio、`tsdown.config.ts` |

### 修改的关键文件

| 文件 | 改动 |
| --- | --- |
| `packages/bundle/web-app/cordis.patch.yml` | 操作员门控的 `plugin-install` 挂载行（host Remote） |
| `packages/bundle/web-app/package.json` | 依赖 + browser roster 行（`@deepseek-ai/dsh-client-ui-settings-plugin-install`，受 `DSH_PLUGIN_INSTALL` 门控） |
| `packages/api/remotes/src/client/index.ts` | `$mount` 贡献列表加入 `plugin-install` Remote；re-export `DirectoryUploadFile` 等类型 |
| `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts` | `settings.plugins.tab` 插槽注册入口 |
| `packages/boot/app-boot/src/profile-plugins.ts` | Phase A 抽取的 `dependencyIsBundle` + `reconcileProfileBundles` |
| `tsconfig.base.json` / `tsconfig.client.json` / `tsconfig.host.json` | 新包路径别名（含 `@deepseek-ai/dsh-host-plugin-install/types` subpath） |
| `docs/config-catalog.*`、`docs/module-graph.*`、`packages/host/README.*` | 目录/门禁再生成 |
| `scripts/verify-package-readme-model-experience.ts` | 新包 model-experience 审计条目 |

### Agent Note（已归档为 implemented）

- `.agents/notes/implemented/architecture/2026-09-05-operator-gated-plugin-install-remote.{md,zh.md,i18n.yaml}`
- `.agents/notes/implemented/feature/2026-09-05-web-settings-plugin-install-tab.{md,zh.md,i18n.yaml}`

## 4. 接手须知（关键实现点）

- **Remote 命名空间 `pluginInstall`，方法名 `installPlugin`**。不要改回 `install`——
  曾因 `client api: method "pluginInstall/install" conflicts with its namespace service` 崩溃，
  客户端命名空间服务会保留同名内部方法。
- 客户端组件通过注入的 `installPlugin(spec): Promise<PluginInstallResult>` 调 Remote；
  spec 的判别字段是 `form: 'file-dir' | 'npm-bundle' | 'upload-directory'`。
- 跨包类型：`DirectoryUploadFile` / `PluginInstallSpec` / `PluginInstallResult` /
  `PluginInstallForm` 由 `@deepseek-ai/dsh-api-remotes/client` 导出，客户端包从那里 import。
- `upload-directory` 文件内容在浏览器端 `readAsDataURL` 后去前缀转 base64；宿主端
  `Buffer.from(content, 'base64')` 解码落盘——两端上限常量在宿主 `src/types.ts` 或 `src/index.ts`。
- **lib/ 产物会陈旧**：改了 `src/` 后必须 `pnpm run build:lib`（typert host/remote-client
  由 tsdown 生成）。`pnpm --filter <pkg> build` 不存在，构建入口是仓库级 `scripts/build.ts`。
- 标签页注册用 `ctx.slots.inject('settings.plugins.tab')`，id `plugin-install`，order 20。

## 5. 验证命令

```sh
pnpm exec vitest run \
  packages/host/plugin-install/tests/install.spec.ts \
  packages/client/ui-settings-plugin-install/tests/components.client.spec.tsx \
  packages/client/ui-settings-plugin-install/tests/browser-plugin.client.spec.ts
pnpm run typecheck
pnpm run lint
pnpm run build:lib
pnpm run doc-sync
DSH_PLUGIN_INSTALL=true pnpm dsh --profile web   # 在线验证，端口 3080
```

## 6. 剩余后续工作（按设计文档 phased plan 与 open decisions）

1. **Phase 2 — hub 控制面端点**：list users/instances、install、restart target instance。
2. **pick-user 目标选择**（open decision 3）：目前 self-first，只装当前登录实例；
   跨进程选目标是后续。open decision 5 记录 first vertical slice = self-first。
3. **自动重启 + 浏览器自动重连**（open decision 2）：install 触发目标 web 实例自动重启
   （当前 profile 是 `patchReload: startup`，装完需手动重启才生效）；cookie 存于
   `client-connection/browser-session`，重启后可自动重连，但重启动作本身未实现。
4. **hub 统一监督 web 实例**（open decision 4）：exit 自动 relaunch，取代裸 nohup。
5. **Phase 4 剩余 UI**：进度观察（watch progress）、重启后自动刷新（auto-refresh）。
6. **form 4（raw `cordis.yml` patch 行编辑）**：设计文档四表单之一，未实现。
7. **快照覆盖**：模型/产品可见路径无 keyless 录制快照（snapshot ownership 检查）；
   后续行为变更需同步快照或按 testing.md 决策。

## 7. 踩坑记录（避免重蹈）

- **Remote 方法名与命名空间服务冲突** → 方法改 `installPlugin`（见第 4 节）。
- **lib 产物陈旧** → 改了 src 必跑 `build:lib`；Web 服务加载的是 lib 不是 src。
- **`docs/config-catalog.zh.md` 编辑器视图/磁盘不一致** → 用终端/脚本再生成或修正，
  不要依赖编辑器的所见即所得。
- **新增包的 subpath 导出**（如 `.../types`）必须在 `tsconfig.base.json` 有对应路径别名，
  否则 `gen-cordis-inspect-catalog` 会 TypeScript 内部崩溃。
- 翻译配对门禁改内容后要 `pnpm exec tsx scripts/verify-translation-pairing.ts --write <path>`
  重录 hash；`gen-config-catalog` 只写 `.md`，需同步重录 `.i18n.yaml`。
