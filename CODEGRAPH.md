# CodeGraph 代码地图

由 codegraph 生成（索引 3,864 文件）。重新生成：

```sh
CG=~/.nvm/versions/node/v22.23.2/bin/codegraph
$CG sync && $CG files --max-depth 3 --no-metadata
```

快速查询示例：

```sh
$CG query <symbol>      # 符号搜索
$CG callers <symbol>    # 谁调用了它
$CG explore <query>     # 相关符号源码 + 调用路径
$CG node <name>         # 单个符号源码 + 调用链
$CG files --filter <dir>  # 目录文件结构
```

---

[1m
Project Structure (3864 files):
[0m
├── .agents
│   ├── notes
│   │   ├── archived
│   │   ├── implemented
│   │   ├── proposed
│   │   ├── rejected
│   │   └── README.i18n.yaml
│   └── skills
│       ├── dsh-archive-agent-notes
│       ├── dsh-doc-site-sync
│       ├── dsh-pre-push-checks
│       ├── dsh-prose-standard
│       ├── dsh-translate-docs
│       └── record-browser-gif
├── .github
│   ├── ISSUE_TEMPLATE
│   │   └── config.yml
│   ├── issue-management
│   │   ├── policy.mjs
│   │   └── policy.test.mjs
│   ├── workflows
│   │   ├── build-exe-for-python-sdk.yml
│   │   ├── ci.yml
│   │   ├── docs-pages.yml
│   │   ├── e2b-e2e.yml
│   │   ├── e2e.yml
│   │   ├── expected-filenames.yml
│   │   ├── issue-lifecycle.yml
│   │   ├── issue-policy.yml
│   │   ├── landlock-run-release.yml
│   │   ├── landlock-run.yml
│   │   ├── pi-ai-provider-e2e.yml
│   │   ├── python-release.yml
│   │   ├── release-vendor.yml
│   │   ├── release.yml
│   │   └── sandbox.yml
│   └── dependabot.yml
├── apps
│   ├── cli
│   │   ├── config
│   │   ├── reference
│   │   ├── src
│   │   ├── tests
│   │   ├── README.i18n.yaml
│   │   └── tsdown.config.ts
│   └── web
│       ├── src
│       ├── stress-tests
│       ├── tests
│       └── vite.config.ts
├── docs
│   ├── cookbook
│   │   ├── adding-a-conversation-node.i18n.yaml
│   │   ├── adding-a-package.i18n.yaml
│   │   ├── adding-a-settings-card.i18n.yaml
│   │   ├── adding-a-tool.i18n.yaml
│   │   ├── adding-a-vendored-package.i18n.yaml
│   │   ├── adding-an-llm-adapter.i18n.yaml
│   │   ├── extension-cookbook.i18n.yaml
│   │   ├── maintaining-dsh-code-review.i18n.yaml
│   │   └── responding-to-pr-review-on-a-stack.i18n.yaml
│   ├── cordis-api
│   │   ├── context.i18n.yaml
│   │   ├── events.i18n.yaml
│   │   ├── fiber.i18n.yaml
│   │   ├── registry.i18n.yaml
│   │   └── service.i18n.yaml
│   ├── cordis-tutorial
│   │   ├── 01-first-plugin.i18n.yaml
│   │   ├── 02-lifecycle-and-effects.i18n.yaml
│   │   ├── 03-services.i18n.yaml
│   │   ├── 04-events.i18n.yaml
│   │   ├── 05-config.i18n.yaml
│   │   ├── 06-composition-and-hmr.i18n.yaml
│   │   ├── 07-into-the-harness.i18n.yaml
│   │   └── index.i18n.yaml
│   ├── i18n
│   │   ├── README.i18n.yaml
│   │   └── translation-rules.i18n.yaml
│   ├── postmortem
│   │   ├── 0001-acp-default-export-drops-inject.i18n.yaml
│   │   ├── 0002-js-expression-disabled-filesystem-tools.i18n.yaml
│   │   ├── 0003-web-agent-gui-feedback-loop.i18n.yaml
│   │   ├── 0004-landlock-partial-notice-misclassified-child-failures.i18n.yaml
│   │   └── README.i18n.yaml
│   ├── subsystems
│   │   ├── approval.i18n.yaml
│   │   ├── attachment.i18n.yaml
│   │   ├── client-modules.i18n.yaml
│   │   ├── code-runtime.i18n.yaml
│   │   ├── commands.i18n.yaml
│   │   ├── compaction.i18n.yaml
│   │   ├── core.i18n.yaml
│   │   ├── credentials.i18n.yaml
│   │   ├── extensions.i18n.yaml
│   │   ├── feedback.i18n.yaml
│   │   ├── filesystem.i18n.yaml
│   │   ├── goal.i18n.yaml
│   │   ├── invariants.i18n.yaml
│   │   ├── jobs.i18n.yaml
│   │   ├── llm-streaming.i18n.yaml
│   │   ├── lsp.i18n.yaml
│   │   ├── permission-presets.i18n.yaml
│   │   ├── persistence.i18n.yaml
│   │   ├── plan.i18n.yaml
│   │   ├── README.i18n.yaml
│   │   ├── sandbox.i18n.yaml
│   │   ├── schedule.i18n.yaml
│   │   ├── scope.i18n.yaml
│   │   ├── session-projection.i18n.yaml
│   │   ├── session-query.i18n.yaml
│   │   ├── session-reference.i18n.yaml
│   │   ├── session-telemetry.i18n.yaml
│   │   ├── session-title.i18n.yaml
│   │   ├── session.i18n.yaml
│   │   ├── settings.i18n.yaml
│   │   ├── shell.i18n.yaml
│   │   ├── skills.i18n.yaml
│   │   ├── spill.i18n.yaml
│   │   ├── storage.i18n.yaml
│   │   ├── subagent.i18n.yaml
│   │   ├── subprocess.i18n.yaml
│   │   ├── system-prompt.i18n.yaml
│   │   ├── terminal.i18n.yaml
│   │   ├── token-meter.i18n.yaml
│   │   ├── tools.i18n.yaml
│   │   ├── typert.i18n.yaml
│   │   ├── user-questions.i18n.yaml
│   │   ├── web-server.i18n.yaml
│   │   ├── web.i18n.yaml
│   │   ├── workflow.i18n.yaml
│   │   └── workspace.i18n.yaml
│   ├── user
│   │   ├── develop
│   │   ├── guide
│   │   └── index.i18n.yaml
│   ├── agent-lifecycle.i18n.yaml
│   ├── api-gateway.i18n.yaml
│   ├── architecture.i18n.yaml
│   ├── capability-seams.i18n.yaml
│   ├── config-catalog.i18n.yaml
│   ├── cordis-primer.i18n.yaml
│   ├── defensive-patterns.i18n.yaml
│   ├── development.i18n.yaml
│   ├── event-producer-consumer.i18n.yaml
│   ├── glossary.i18n.yaml
│   ├── graph-atlas.i18n.yaml
│   ├── module-graph.i18n.yaml
│   ├── persistence-catalog.i18n.yaml
│   ├── rescope.i18n.yaml
│   ├── testing.i18n.yaml
│   ├── tool-catalog.i18n.yaml
│   ├── tool-execution-pipeline.i18n.yaml
│   └── web-styling.i18n.yaml
├── examples
│   ├── acp-agent
│   │   ├── tests
│   │   ├── advanced.cordis.snapshot.yml
│   │   ├── advanced.cordis.yml
│   │   ├── agent-instructions.cordis.snapshot.yml
│   │   ├── agent-instructions.cordis.yml
│   │   ├── background-job-admission.cordis.snapshot.yml
│   │   ├── background-job-admission.cordis.yml
│   │   ├── both-mode.cordis.snapshot.yml
│   │   ├── both-mode.cordis.yml
│   │   ├── child-question.cordis.snapshot.yml
│   │   ├── child-question.cordis.yml
│   │   ├── code-mode-image.cordis.snapshot.yml
│   │   ├── code-mode-image.cordis.yml
│   │   ├── code-mode-workspace-context.cordis.snapshot.yml
│   │   ├── code-mode-workspace-context.cordis.yml
│   │   ├── code-mode.cordis.snapshot.yml
│   │   ├── code-mode.cordis.yml
│   │   ├── cordis-tools.cordis.yml
│   │   ├── cordis.snapshot.yml
│   │   ├── cordis.yml
│   │   ├── depth-two.cordis.snapshot.yml
│   │   ├── depth-two.cordis.yml
│   │   ├── fs.cordis.snapshot.yml
│   │   ├── fs.cordis.yml
│   │   ├── image-text-route.cordis.snapshot.yml
│   │   ├── image-text-route.cordis.yml
│   │   ├── image.cordis.snapshot.yml
│   │   ├── image.cordis.yml
│   │   ├── partial-landlock.cordis.snapshot.yml
│   │   ├── partial-landlock.cordis.yml
│   │   ├── product-subagent-both.cordis.snapshot.yml
│   │   ├── product-subagent-both.cordis.yml
│   │   ├── product-subagent-codex.cordis.snapshot.yml
│   │   ├── product-subagent-codex.cordis.yml
│   │   ├── pty-snapshot-backend.mjs
│   │   ├── pty.cordis.snapshot.yml
│   │   ├── pty.cordis.yml
│   │   ├── README.i18n.yaml
│   │   ├── retry.cordis.snapshot.yml
│   │   ├── retry.cordis.yml
│   │   ├── session-query.cordis.snapshot.yml
│   │   ├── session-query.cordis.yml
│   │   ├── session-sandbox-root.cordis.snapshot.yml
│   │   ├── session-sandbox-root.cordis.yml
│   │   ├── session-title.cordis.snapshot.yml
│   │   ├── session-title.cordis.yml
│   │   ├── subagent-continuable-inheritance.cordis.snapshot.yml
│   │   ├── subagent-continuable-inheritance.cordis.yml
│   │   ├── subagent-durability-failure.cordis.snapshot.yml
│   │   ├── subagent-durability-failure.cordis.yml
│   │   ├── subagent-report-quiet.cordis.snapshot.yml
│   │   ├── subagent-report-quiet.cordis.yml
│   │   ├── web-fetch-fixture-server.mjs
│   │   ├── web.cordis.snapshot.yml
│   │   └── web.cordis.yml
│   ├── headless-agent
│   │   ├── tests
│   │   ├── advanced.cordis.snapshot.yml
│   │   ├── advanced.cordis.yml
│   │   ├── compaction.cordis.snapshot.yml
│   │   ├── cordis.yml
│   │   ├── credentials.cordis.snapshot.yml
│   │   ├── e2b.cordis.yml
│   │   ├── goal.cordis.snapshot.yml
│   │   ├── goal.cordis.yml
│   │   ├── pty.cordis.snapshot.yml
│   │   ├── ralph.cordis.snapshot.yml
│   │   ├── README.i18n.yaml
│   │   ├── retry.cordis.snapshot.yml
│   │   ├── semantic-checkpoint.cordis.snapshot.yml
│   │   ├── subagent-diagnostic.cordis.snapshot.yml
│   │   ├── subagent-inheritance.cordis.snapshot.yml
│   │   ├── subagent-settlement.cordis.snapshot.yml
│   │   └── workspace-context-resume.cordis.snapshot.yml
│   ├── jsonrpc-agent
│   │   ├── tests
│   │   ├── cordis.snapshot.yml
│   │   ├── cordis.yml
│   │   ├── minimal.cordis.yml
│   │   ├── minimal.py
│   │   ├── minimal.snapshot.cordis.yml
│   │   └── README.i18n.yaml
│   ├── mcp-memory
│   │   ├── engram.cordis.yml
│   │   ├── mcp-reference-memory.cordis.yml
│   │   ├── memorix.cordis.yml
│   │   └── README.i18n.yaml
│   ├── web-cordis
│   │   ├── cordis.yml
│   │   └── README.i18n.yaml
│   ├── web-schedule
│   │   ├── cordis.yml
│   │   └── README.i18n.yaml
│   └── README.i18n.yaml
├── native
│   ├── landlock-run
│   │   ├── packages
│   │   ├── scripts
│   │   ├── test
│   │   └── README.i18n.yaml
│   └── README.i18n.yaml
├── packages
│   ├── acp
│   │   ├── acp
│   │   └── README.i18n.yaml
│   ├── api
│   │   ├── gateway
│   │   ├── remotes
│   │   └── README.i18n.yaml
│   ├── attachment
│   │   ├── attachment
│   │   ├── attachment-local
│   │   └── README.i18n.yaml
│   ├── boot
│   │   ├── app-boot
│   │   ├── cmdline
│   │   └── README.i18n.yaml
│   ├── bundle
│   │   ├── base
│   │   ├── headless
│   │   ├── web-app
│   │   └── README.i18n.yaml
│   ├── client
│   │   ├── connection
│   │   ├── hmr
│   │   ├── locale
│   │   ├── modules
│   │   ├── runtime
│   │   ├── schema-form
│   │   ├── ui-agent-preset
│   │   ├── ui-attachment
│   │   ├── ui-commands
│   │   ├── ui-conversation
│   │   ├── ui-deliverables
│   │   ├── ui-directory-picker-browse
│   │   ├── ui-directory-picker-native
│   │   ├── ui-goal
│   │   ├── ui-input-trigger
│   │   ├── ui-jobs
│   │   ├── ui-layout
│   │   ├── ui-message-feedback
│   │   ├── ui-model-selection
│   │   ├── ui-permission-presets
│   │   ├── ui-plan
│   │   ├── ui-primitives
│   │   ├── ui-settings
│   │   ├── ui-settings-general
│   │   ├── ui-settings-models
│   │   ├── ui-settings-plugin-inventory
│   │   ├── ui-settings-plugins
│   │   ├── ui-sidebar
│   │   ├── ui-skill
│   │   ├── ui-slots
│   │   ├── ui-subagent
│   │   ├── ui-theme
│   │   ├── ui-tool
│   │   ├── ui-trajectory
│   │   ├── ui-user-questions
│   │   ├── ui-workflow-run
│   │   ├── ui-workspace
│   │   ├── web
│   │   ├── web-react
│   │   ├── README.i18n.yaml
│   │   └── tsdown.client.ts
│   ├── code-runtime
│   │   ├── code-runtime
│   │   ├── code-runtime-worker-thread
│   │   └── README.i18n.yaml
│   ├── compaction
│   │   ├── command-compact
│   │   ├── compaction
│   │   ├── compaction-basic
│   │   ├── compaction-tool-result-pruner
│   │   └── README.i18n.yaml
│   ├── context
│   │   ├── agent-instructions
│   │   ├── session-reference
│   │   ├── time-context
│   │   ├── tmux-context
│   │   └── README.i18n.yaml
│   ├── core
│   │   ├── agent
│   │   ├── agent-default-model
│   │   ├── agent-loop
│   │   ├── agent-tool-presentation
│   │   ├── scope
│   │   ├── session
│   │   ├── system-prompt
│   │   ├── tools
│   │   └── README.i18n.yaml
│   ├── credentials
│   │   ├── credentials
│   │   ├── credentials-local
│   │   └── README.i18n.yaml
│   ├── e2b
│   │   ├── e2b
│   │   ├── fs-e2b
│   │   ├── subprocess-e2b
│   │   └── README.i18n.yaml
│   ├── examples
│   │   ├── acp-demo
│   │   ├── agent-spine-demo
│   │   ├── jsonrpc-demo
│   │   └── README.i18n.yaml
│   ├── extensions
│   │   ├── cordis-client-runner
│   │   ├── cordis-host-runner
│   │   ├── tool-cordis
│   │   ├── ui-cordis
│   │   └── README.i18n.yaml
│   ├── feedback
│   │   ├── command-feedback
│   │   ├── message-feedback
│   │   └── README.i18n.yaml
│   ├── fs
│   │   ├── fs
│   │   ├── fs-local
│   │   ├── fs-observation-policy
│   │   ├── fs-sandbox
│   │   ├── tool-fs
│   │   ├── tool-fs-search
│   │   ├── tool-str-replace-editor
│   │   └── README.i18n.yaml
│   ├── goal
│   │   ├── command-goal
│   │   ├── goal
│   │   ├── goal-round-driver
│   │   ├── tool-goal
│   │   └── README.i18n.yaml
│   ├── guard
│   │   ├── repeat-tool-reminder
│   │   ├── timeout-policy
│   │   └── README.i18n.yaml
│   ├── hooks
│   │   ├── hook-protocol
│   │   ├── hooks-claude-code
│   │   ├── hooks-codex
│   │   └── README.i18n.yaml
│   ├── host
│   │   ├── apiproxy
│   │   ├── directory-picker
│   │   ├── directory-picker-auto
│   │   ├── directory-picker-browse
│   │   ├── directory-picker-native
│   │   ├── frontend-static
│   │   ├── plugin-inventory
│   │   ├── webserver
│   │   └── README.i18n.yaml
│   ├── identity
│   │   ├── anonymous-user-id
│   │   └── README.i18n.yaml
│   ├── interaction
│   │   ├── commands
│   │   ├── permission-presets
│   │   ├── tool-ask-user
│   │   ├── user-approval
│   │   ├── user-questions
│   │   └── README.i18n.yaml
│   ├── jobs
│   │   ├── jobs
│   │   ├── jobs-local
│   │   ├── tool-jobs
│   │   └── README.i18n.yaml
│   ├── llm
│   │   ├── llm
│   │   ├── llm-deepseek
│   │   ├── llm-pi-ai
│   │   ├── llm-retry
│   │   ├── token-meter
│   │   └── README.i18n.yaml
│   ├── lsp
│   │   ├── lsp
│   │   ├── lsp-stdio
│   │   ├── tool-lsp
│   │   └── README.i18n.yaml
│   ├── mcp
│   │   ├── mcp-client
│   │   └── README.i18n.yaml
│   ├── plan
│   │   ├── plan-mode
│   │   └── README.i18n.yaml
│   ├── preset
│   │   ├── agent-presets
│   │   ├── persona
│   │   └── README.i18n.yaml
│   ├── runtime-diagnostics
│   │   └── invariants
│   ├── sandbox
│   │   ├── sandbox
│   │   ├── sandbox-local
│   │   ├── sandbox-policy
│   │   ├── sandbox-windows-acl
│   │   └── README.i18n.yaml
│   ├── schedule
│   │   ├── schedule
│   │   └── README.i18n.yaml
│   ├── sdk
│   │   ├── client
│   │   ├── protocol
│   │   ├── server
│   │   └── README.i18n.yaml
│   ├── session
│   │   ├── session-checkpoint-policy
│   │   ├── session-persistence
│   │   ├── session-persistence-jsonl
│   │   ├── session-persistence-sqlite
│   │   ├── session-projection
│   │   ├── session-projection-cache
│   │   ├── session-stats
│   │   ├── session-telemetry
│   │   ├── session-telemetry-otel
│   │   ├── session-title
│   │   ├── session-title-all-prompts-llm
│   │   ├── session-title-first-prompt-llm
│   │   ├── session-title-llm
│   │   └── README.i18n.yaml
│   ├── session-query
│   │   ├── session-log-export
│   │   ├── session-query
│   │   ├── session-query-sqlite
│   │   ├── tool-session-query
│   │   └── README.i18n.yaml
│   ├── settings
│   │   ├── settings
│   │   ├── settings-file
│   │   └── README.i18n.yaml
│   ├── shell
│   │   ├── bash-local
│   │   ├── bash-sandbox
│   │   ├── pwsh-local
│   │   ├── pwsh-sandbox
│   │   ├── shell
│   │   ├── shell-env
│   │   ├── tool-bash
│   │   ├── tool-bash-persistent
│   │   ├── tool-pwsh
│   │   └── README.i18n.yaml
│   ├── skill
│   │   ├── skill
│   │   ├── skill-badge
│   │   ├── skill-filesystem
│   │   ├── tool-skill
│   │   └── README.i18n.yaml
│   ├── spill
│   │   ├── spill
│   │   ├── spill-local
│   │   ├── spill-policy
│   │   └── README.i18n.yaml
│   ├── storage
│   │   ├── storage
│   │   ├── storage-domain
│   │   ├── storage-json
│   │   ├── storage-sqlite
│   │   └── README.i18n.yaml
│   ├── subagent
│   │   ├── subagent
│   │   ├── subagent-acp
│   │   ├── subagent-claude-code
│   │   ├── subagent-codex
│   │   ├── subagent-dsh-sdk
│   │   ├── subagent-fork-in-process
│   │   ├── subagent-in-process-driver
│   │   ├── subagent-spawn-in-process
│   │   ├── tool-subagent
│   │   ├── tool-subagent-control
│   │   ├── tool-subagent-report
│   │   └── README.i18n.yaml
│   ├── subprocess
│   │   ├── subprocess
│   │   ├── subprocess-local
│   │   └── README.i18n.yaml
│   ├── terminal
│   │   ├── terminal
│   │   ├── terminal-bash
│   │   ├── tool-terminal
│   │   └── README.i18n.yaml
│   ├── test-support
│   │   ├── acp-snapshot
│   │   ├── agent-loop-testkit
│   │   ├── client-runtime
│   │   ├── llm-mock-server
│   │   ├── llm-replay
│   │   ├── loader-smoke
│   │   └── README.i18n.yaml
│   ├── todo
│   │   ├── tool-todo
│   │   └── README.i18n.yaml
│   ├── typert
│   │   ├── generator
│   │   ├── loader
│   │   ├── protocol
│   │   ├── registry
│   │   └── README.i18n.yaml
│   ├── util
│   │   ├── atomic-write
│   │   ├── brand
│   │   ├── home-paths
│   │   ├── launch-environment
│   │   ├── native-command
│   │   ├── output-retention
│   │   ├── timeout
│   │   └── README.i18n.yaml
│   ├── web
│   │   ├── tool-a2ui-surface
│   │   ├── tool-web
│   │   ├── web
│   │   ├── web-fetch-http
│   │   ├── web-search-deepseek
│   │   ├── web-search-exa
│   │   ├── web-search-perplexity
│   │   └── README.i18n.yaml
│   ├── workflow
│   │   ├── tool-ralph
│   │   ├── tool-workflow
│   │   ├── workflow
│   │   ├── workflow-worker-thread
│   │   └── README.i18n.yaml
│   ├── workspace
│   │   ├── workspace
│   │   └── README.i18n.yaml
│   └── README.i18n.yaml
├── python
│   ├── sdk
│   │   ├── src
│   │   ├── tests
│   │   └── README.i18n.yaml
│   ├── sdk-runtime
│   │   ├── src
│   │   ├── hatch_build.py
│   │   └── README.i18n.yaml
│   ├── development.i18n.yaml
│   └── README.i18n.yaml
├── scripts
│   ├── release
│   │   ├── bump.ts
│   │   ├── families.spec.ts
│   │   ├── families.ts
│   │   ├── pack.ts
│   │   ├── process.ts
│   │   ├── publish.ts
│   │   ├── tarball.ts
│   │   ├── verify-packed-install.ts
│   │   └── verify.ts
│   ├── agent-note-tree.ts
│   ├── archived-agent-notes.spec.ts
│   ├── archived-agent-notes.ts
│   ├── attribute-chunk-bytes.mjs
│   ├── build-exe-for-python-sdk-native-pty.spec.ts
│   ├── build-exe-for-python-sdk-native-pty.ts
│   ├── build-exe-for-python-sdk.ts
│   ├── build-python-release.py
│   ├── change-scope.spec.ts
│   ├── change-scope.ts
│   ├── check-macos-deployment-target.py
│   ├── check-workspace-constraints.ts
│   ├── ci-workflow.spec.ts
│   ├── clean.spec.ts
│   ├── clean.ts
│   ├── client-bundle-css.spec.ts
│   ├── client-bundle-purity.spec.ts
│   ├── client-tsconfig.spec.ts
│   ├── cordis-config-files.spec.ts
│   ├── cordis-config-files.ts
│   ├── cordis-core-api.spec.ts
│   ├── cordis-core-api.ts
│   ├── cordis-walk.ts
│   ├── coverage-exempt.spec.ts
│   ├── coverage-exempt.ts
│   ├── coverage-uncovered-locations.cjs
│   ├── demo-code-mode.mjs
│   ├── demo-cordis.mjs
│   ├── dev-web.spec.ts
│   ├── dev-web.ts
│   ├── doc-typecheck-paths.spec.ts
│   ├── doc-typecheck-paths.ts
│   ├── doc-typecheck.ts
│   ├── gen-client-catalog.spec.ts
│   ├── gen-client-catalog.ts
│   ├── gen-config-catalog.ts
│   ├── gen-cordis-api.ts
│   ├── gen-cordis-catalog-partition.spec.ts
│   ├── gen-cordis-catalog-record.spec.ts
│   ├── gen-cordis-catalog.ts
│   ├── gen-cordis-inspect-catalog.ts
│   ├── gen-doc-graphs.spec.ts
│   ├── gen-doc-graphs.ts
│   ├── gen-module-graph.ts
│   ├── gen-persistence-catalog.ts
│   ├── gen-scoped-events.ts
│   ├── gen-third-party-notices.spec.ts
│   ├── gen-third-party-notices.ts
│   ├── gen-tool-catalog.ts
│   ├── gen-translation-brief.ts
│   ├── install-lefthook.mjs
│   ├── install-lefthook.spec.ts
│   ├── jsdoc.ts
│   ├── lint-rule-fingerprint.spec.ts
│   ├── markdown.ts
│   ├── merge-translation-pairing.ts
│   ├── migrate-packed-session-fixtures.ts
│   ├── oxlint-contract.spec.ts
│   ├── package-graph.ts
│   ├── package-invariants.spec.ts
│   ├── package-invariants.ts
│   ├── paired-markdown-derivatives.spec.ts
│   ├── paired-markdown-derivatives.ts
│   ├── project-doc-site.spec.ts
│   ├── project-doc-site.ts
│   ├── project-reference-faces.spec.ts
│   ├── project-reference-faces.ts
│   ├── publication-payload.spec.ts
│   ├── publication-payload.ts
│   ├── publint-all.spec.ts
│   ├── publint-all.ts
│   ├── publish-npm-baseline.ts
│   ├── repo-files.ts
│   ├── rescope-vendor.spec.ts
│   ├── rescope-vendor.ts
│   ├── run-gates.spec.ts
│   ├── run-gates.ts
│   ├── run-oxlint.spec.ts
│   ├── run-oxlint.ts
│   ├── session-fixture-layout.snapshot.ts
│   ├── session-fixture-layout.spec.ts
│   ├── session-fixture-layout.ts
│   ├── slot-walk.ts
│   ├── smoke-python-runtime.py
│   ├── test-fixture-cleanup.ts
│   ├── test-invariants.spec.ts
│   ├── test-invariants.ts
│   ├── translation-brief.spec.ts
│   ├── translation-brief.ts
│   ├── translation-pairing-git.ts
│   ├── translation-pairing-merge.spec.ts
│   ├── translation-pairing-merge.ts
│   ├── translation-pairing-record.ts
│   ├── translation-pairing.spec.ts
│   ├── translation-pairing.ts
│   ├── translation-prompt.snapshot.ts
│   ├── translation-prompt.spec.ts
│   ├── translation-prompt.ts
│   ├── ts-project.ts
│   ├── verify-agent-note-classification.ts
│   ├── verify-agent-note-format.ts
│   ├── verify-archived-agent-notes.ts
│   ├── verify-built-package-invariants.mjs
│   ├── verify-built-package-invariants.spec.ts
│   ├── verify-client-domain-graph.ts
│   ├── verify-config-source-ownership.spec.ts
│   ├── verify-config-source-ownership.ts
│   ├── verify-cordis-config.spec.ts
│   ├── verify-cordis-config.ts
│   ├── verify-doc-budgets.ts
│   ├── verify-doc-refs.ts
│   ├── verify-doc-site-fragments.spec.ts
│   ├── verify-doc-site-fragments.ts
│   ├── verify-dsh-package-licenses.spec.ts
│   ├── verify-dsh-package-licenses.ts
│   ├── verify-export-jsdoc.ts
│   ├── verify-md-links.spec.ts
│   ├── verify-md-links.ts
│   ├── verify-md-wrap.ts
│   ├── verify-mermaid.ts
│   ├── verify-node-next-types.ts
│   ├── verify-optional-dependency-imports.spec.ts
│   ├── verify-optional-dependency-imports.ts
│   ├── verify-package-invariants.ts
│   ├── verify-package-paths.ts
│   ├── verify-package-readme-limitations.ts
│   ├── verify-package-readme-model-experience.ts
│   ├── verify-public-repository-links.spec.ts
│   ├── verify-public-repository-links.ts
│   ├── verify-runtime-closure.ts
│   ├── verify-skill-invocation-metadata.spec.ts
│   ├── verify-skill-invocation-metadata.ts
│   ├── verify-translation-pairing.ts
│   ├── verify-translation-prompt.ts
│   ├── verify-type-equiv.ts
│   ├── verify-vendored-links.ts
│   └── vitest-environment.compat.spec.ts
├── website
│   ├── .vitepress
│   │   └── config.ts
│   └── docs.ts
├── .gitlab-ci.yml
├── CONTRIBUTING.i18n.yaml
├── lefthook.yml
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
├── README.i18n.yaml
├── tsdown.config.ts
├── vitest.config.ts
├── vitest.e2e.config.ts
├── vitest.shared.ts
├── vitest.snapshot.config.ts
├── vitest.web-stress.config.ts
├── vitest.web.config.ts
└── vitest.web.perf.config.ts

