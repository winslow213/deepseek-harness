# WebUI Plugin Install — design (draft for review)

Status: proposed. Working notes, not committed docs.

## Goal

Operator installs external plugins into per-user dsh profiles from a Web UI.

Forms (all four requested):
1. `file://` source-dir plugin (the region-router pattern): copy dir under
   `profiles/<name>/plugins/<id>/`, insert a row into the profile's
   `cordis.patch.yml`.
2. npm package declaring `dsh.bundle`: `pnpm add` in profile dir, reconcile
   into `dsh.profile.bundles`.
3. Plain npm Cordis plugin package (no bundle): `pnpm add` only (operator then
   adds its own config row by hand or via form 4).
4. Raw `cordis.yml` patch rows: append/merge entries into the profile's
   `cordis.patch.yml`.

## Constraints discovered

- Web profile runs `patchReload: startup` in this deployment → **install takes
  effect only after process restart**. No in-process bundle reload exists.
- Browser session secret persists in the user's credentials store
  (`client-connection/browser-session`), so **cookies survive a dsh web
  process restart** → auto-restart + auto-refresh is feasible.
- dsh Web stack has **no identity/role model**. Operator gating must be an
  explicit switch (env/config), default off.
- User instances are spawned under a configurable DSH_USERS_ROOT; hub knows
  the registered users but does NOT currently supervise web instances
  (32001 alice is a bare detached process).

## Open architecture decisions (confirmed with operator)

1. Operator gate: explicit env/config switch; install UI + Remote register
   only when enabled. Default off.
2. Restart: install triggers an automatic restart of the target web instance,
   browser auto-reconnects (cookie persists).
3. Install target: operator picks the target user instance (cross-process),
   not only the instance the operator is logged into.
4. Supervision: user dsh web instances are spawned and supervised uniformly
   by the hub control plane (exit auto-relaunches); no more bare nohup.
5. First vertical slice: self-first — the operator's logged-in instance is
   the install target; pick-user hub API lands later.
6. Executor: the target instance process executes the install itself (it
   reads its own profile dir; app-boot logic is reusable in-process).

## Phased plan

- Phase 1: host-side install primitive — reusable function that performs the
  four forms against one profile dir (ports `apps/cli/src/plugin.ts`
  reconcile logic into a shared lib usable in-process).
- Phase 2: hub control-plane endpoints to list users/instances, install, and
  restart a target instance.
- Phase 3: a dsh-side plugin that surfaces the operator UI + Remote service,
  gated by the explicit switch.
- Phase 4: Web UI tab under Settings → Plugins: pick target, pick form, run,
  watch progress, auto-refresh after restart.

Each phase validated before moving on.

## Confirmed delivery path (operator chose approach A)

Host-side minimal vertical slice first, verified by direct Remote/CLI calls;
UI and hub supervision land in later phases.

### Phase A execution plan (LOCKED — operator chose formal product path)

Create `@deepseek-ai/dsh-host-plugin-install` as a full formal host package
(`packages/host/plugin-install/`), wired into web-app + remotes assembly, with
the full doc/catalog gate surface. File plan:

1. **Self-first profile dir resolution (verified mechanism)** — the running
   instance does not know its profile name at plugin runtime, but the bootstrap
   include entry does:
   - `mountRootInclude` (packages/boot/app-boot/src/index.ts:519-568) pins the
     entry `id: 'include'` with
     `config.path = pathToFileURL(join(profile.dir, 'cordis.yml')).href`.
   - `profile.dir` is the profile directory
     (`$DSH_HOME/profiles/<name>`); `PROFILE_ROOT_FILENAME = 'cordis.yml'`.
   - Self-locate by iterating `ctx.loader.entries()` (`EntryTree.entries()`,
     vendor/loader/src/config/tree.ts:27) for `entry.id === 'include'`, read
     `entry.options.config.path` (a file URL), `fileURLToPath` + `dirname`.
   - Fallback for tests/embedders: an explicit profile dir provided through
     the service Config.
   - app-boot module exports to reuse: `initProfile`, `readProfileManifest`,
     `writeProfileManifest`, `resolveBundleDir`, `resolveProfileDir`,
     `reconcileProfileBundles`, `dependencyIsBundle` (new shared module
     `profile-plugins.ts`), `PROFILE_PATCH_FILENAME`.

2. **New package skeleton** `packages/host/plugin-install/`:
   - `package.json`: name `@deepseek-ai/dsh-host-plugin-install`, exports
     `.` → lib/types/index.d.ts+lib/index.js, `./types` → src/types.ts face,
     `./remote` + `./typert` generated (typert host/remote-client artifacts,
     produced by the workspace typert tsdown plugin like
     `packages/host/plugin-inventory`). `files` includes
     `lib/typert.remote-client.js` + `.d.ts`.
   - `tsconfig.json`: extends tsconfig.base.json, rootDir src, outDir
     lib/types, references cordis, loader, typert/protocol, boot/app-boot,
     util/home-paths (match plugin-inventory's reference set, plus
     app-boot/home-paths which the service imports).
   - `src/types.ts` (types only) + `src/index.ts` (service class).
   - Unit tests under `tests/`; package README trio
     (README.md/zh/.i18n.yaml) with Model Experience and Known Limitations
     per the package gates.

3. **Service** — `PluginInstallGateway extends TypertRemoteService`,
   `super(ctx, 'pluginInstall')`. Host plugin shape: default-export service
   class (packages/AGENTS plugin exports rule). Remote surface (first cut):
   - `install(spec)` where
     `spec: { form: 'file-dir' | 'npm-bundle'; ... }`. Two forms:
     - `file-dir`: copy the plugin source dir under
       `profileDir/plugins/<id>/` (mirrors shell/src/remote/inject.ts copy +
       `pluginsDirFor`), write a `{ type: 'module' }` loose-plugin manifest if
       the dir lacks package.json (name-less marker isolates from profile
       manifest per LOOSE_PLUGIN_MANIFEST), append an `- insert:` row naming
       `file://<profileDir>/plugins/<id>/index.ts` into
       `profileDir/cordis.patch.yml` (idempotent: same id replaces, never
       duplicates).
     - `npm-bundle`: run `pnpm add <spec>` with cwd = profile dir
       (spawnSync; Windows via shell shim per apps/cli/src/plugin.ts), then
       `reconcileProfileBundles` to promote dsh.bundle packages into
       `dsh.profile.bundles`.
   - Gate: service registers only when Config `enabled: true` (explicit
     switch, default off). Deployments that do not set it never expose the
     namespace.
   - All errors are `RemoteError`s with actionable messages (missing pnpm,
     unresolvable package, manifest write failure, unknown profile).

4. **Wiring**:
   - `packages/bundle/web-app/package.json` dependencies add the package;
     `packages/bundle/web-app/cordis.patch.yml` gains an operator-gated row
     (id `plugin-install`) mounted with `enabled: !!js ctx.<flag>` or an
     explicit env-derived config so the default deploy keeps it off.
   - `packages/api/remotes/src/client/index.ts` adds the generated remote to
     the `$mount` contribution list so the gated namespace reaches the client
     (per plugin-inventory pattern, lines 145-151).
   - Client UI tab (Phase 4) later registers `settings.plugins.tab` against
     this namespace; not in Phase A.

5. **Verification (Phase A)**:
   - Unit tests: real Loader composition booting a test `cordis.yml` that
     mounts the service with `enabled: true`; temp profile fixtures exercise
     file-dir install + npm-bundle reconcile; assert durable on-disk output
     (manifest, patch rows) and remote invocation success/failure.
   - `pnpm run typecheck`; focused `vitest run` on the new spec; built-bin
     plugin e2e already guards the reconcile extraction.
   - README/doc gates: `pnpm run test:docs`, `pnpm run doc-sync`, config +
     cordis catalog regeneration for the new row, lint, git diff --check.

## Progress

- [x] 2026-09-04 commit `11a30687a5` — extracted bundle reconcile to
  `@deepseek-ai/dsh-app-boot` (`profile-plugins.ts`):
  `dependencyIsBundle` + `reconcileProfileBundles` (+ result type). CLI keeps
  pnpm forwarder + warning stream. app-boot 143 tests pass, built-bin plugin
  e2e (`anchors a relative add spec`, `activates a dependency that gained
  dsh.bundle`) passes, apps/cli + app-boot typecheck clean, lib bundles
  rebuilt.
- [x] New host package skeleton (`packages/host/plugin-install`).
- [x] Service implementation + gate.
- [x] Wiring (web-app bundle + remotes assembly).
- [x] Tests (real composition + fixtures).
- [x] Bilingual README + catalog/doc-sync.
- [x] Agent note.

### Phase B (Phase 4 of the phased plan) execution status

- [x] New client package skeleton (`packages/client/ui-settings-plugin-install`).
- [x] Tab component + bilingual dictionaries + registration (`settings.plugins.tab`,
      id `plugin-install`, order 20, next to the read-only inventory tab).
- [x] Wiring: web-app browser roster row gated by the same
      `DSH_PLUGIN_INSTALL=true` switch (UI + Remote register together), bundle
      dependency, `tsconfig.client.json` reference.
- [x] Tests: jsdom component spec (submit trim, running lock, success facts,
      error rendering) + browser-plugin spec (registration, label, Remote
      failure mapping).
- [x] Bilingual README trio + model-experience audit entry.
- [x] Agent note.

Phase B 追加能力（operator 在在线验证阶段提出，随 Phase B 一并落地）：

- [x] npm 完整命令安装：npm-bundle 表单接受 `dsh plugin --profile web add <spec>` /
      `pnpm add <spec>` 完整命令（`parseNpmSpec` 提取 `add` 后的尾部 spec 并剥引号，
      无 `add` 时原样转发），宿主与组件测试覆盖。
- [x] upload-directory 目录上传表单：`<input type="file" webkitdirectory>` 选择本地目录，
      文件按相对路径 base64 经 Remote 通道落盘 `plugins/<id>/` 后登记同一 patch 行；
      安全上限 512 文件 / 单文件 1 MiB / 总计 10 MiB，路径校验拒绝绝对路径、`..` 逃逸、
      非普通文件（`plugin-install/invalid-spec`）。
- [x] Remote 方法名修复：`pluginInstall/install` 与客户端命名空间服务的内部方法冲突
      （`client api: method "pluginInstall/install" conflicts with its namespace service`），
      改名为 `installPlugin`，调用、测试、README、Agent Note 全量同步。

### Phase B 验证记录（全部通过）

- `pnpm run typecheck` ✅
- `pnpm exec vitest run packages/host/plugin-install/tests/install.spec.ts
  packages/client/ui-settings-plugin-install/tests/components.client.spec.tsx
  packages/client/ui-settings-plugin-install/tests/browser-plugin.client.spec.ts` — 40 tests ✅
- `pnpm run lint` — 0 warnings / 0 errors ✅
- `pnpm run build:lib` — typert host/remote-client 产物重建，lib 含新 `parseNpmSpec` ✅
- `pnpm run doc-sync` — 32/32 ✅（重录 3 对 i18n hash、重新生成 config-catalog）
- 在线验证：`DSH_PLUGIN_INSTALL=true pnpm dsh --profile web`
  → http://127.0.0.1:3080，Settings → Plugins → Install plugin 标签页正常注册，
  无插件加载错误（命名冲突已消除）。
