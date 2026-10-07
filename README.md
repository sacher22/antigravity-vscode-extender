# Antigravity Extender

A lightweight VS Code sidebar for the Antigravity CLI. The CLI runs tasks; the extension manages conversation history, streamed output and editor context.

## 当前版本：2.5.2

2.5.2 合并正文、工具和错误的执行顺序，显示紧凑工具摘要，提供流中断恢复提示，并保留截图附件支持。验证结果与限制见 [2.5.2 发布记录](docs/RELEASE-2.5.2.md)。此前全面优化及两小时稳定性验收仍未全部完成。

新增 `/capabilities [refresh]`，查询实际 CLI 启动路径、版本及已验证能力。当前协议证据覆盖本机 v1.2.14 与 v1.2.16；其他版本或查询失败时，侧栏阻止协议执行并保留草稿，可通过 `/cli` 打开独立原生终端。该降级入口不会自动复用侧栏会话或模型/模式参数，需在 CLI 中核对；已验证版本仍使用完整参数交接。MCP/插件修改操作同样要求版本验证，只读查询保留。

探测只执行 `--version`，进程有超时和输出预算，缓存按路径、启动文件身份、工作目录及 60 秒有效期保存；已运行的聊天进程复用，不每轮启动发现进程。包装器内容不变但转发目标更新时，依靠有效期或 `refresh` 重新探测。版本不是 OS 沙箱或所有原生能力的保证：逐工具审批仍不支持，Schema 实验，sandbox 仅验证参数可启动。

## Features

- Real new conversations, per-session drafts, history paging and recovery.
- One **普通 / Plan** selector, model/effort selection and Safe/Danger permissions.
- Project directories follow the currently opened VS Code workspace, including multi-root workspaces.
- File and problem context, tool cards with paged output, file links, diff preview and document-version-checked apply.
- Stop during startup or execution; POSIX tool process-group cleanup.
- Native CLI handoff for verified permission denials and unsupported interactive CLI actions.
- React + TypeScript interface, 30 ms text batching, incremental streaming text and sanitized completed Markdown.

## Installation

Install the **2.5.2** VSIX archive in VS Code using **Extensions → Install from VSIX…**, or run:

```sh
code --install-extension ./antigravity-vscode-extender-2.5.2.vsix --force
```

After active tasks have finished, reload your VS Code window to load an installed update. Open a folder before sending messages. The extension uses your existing `agy` launcher and `antigravity.*` settings. Permission defaults to Safe for new installations; existing explicit Danger configuration is respected.

History migration preserves original data. Rollback instructions and architecture are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); measured results and limitations are in [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md).

## Development

```sh
npm ci
npm test
npm run check:package
npm run test:performance
```

Tests execute the actual React Webview bundle through Provider, Bridge, Controller and a deterministic CLI. Protocol fixtures capture CLI v1.2.14 and v1.2.16 behavior, including Plan and denied actions. Browser stress tests and real VS Code window results are reported separately.

`check:package` checks actual vsce file discovery, including every compiled Host module, and rejects sourcemaps, duplicate browser modules and unexpected files. Before release, preserve debug symbols with `npm run archive:symbols -- /absolute/path/to/new-private-directory`; the output directory must be new. Release packaging uses `npm run package` after assigning an independent version and completing the [release gates](docs/OPTIMIZATION-PLAN.md). The Linux CI workflow covers build/regression/package content; real CLI, WSL windows and long performance acceptance run separately.

### 2.1 更新

新建/切换对话保留后台任务；Plan 使用只读工具并等待“批准并执行方案”；Agent 按钮可查看原生子代理卡片与独立对话日志。独立 token 和完整生命周期缺失时明确显示不可用，子代理工具的直接审批仍需原生 CLI。完整说明与性能证据见 [2.1 发布记录](docs/RELEASE-2.1.md)。


## 2.2 斜杠命令

输入 `/help` 查看完整入口；常用 `/new`、`/stop`、`/plan <需求>`、`/approve`、`/model`、`/skills`、`/open "文件:行号"`。新建不停止后台任务。未知命令明确报错；未经验证的原生交互功能转到 CLI 终端。Schema 属于实验功能。功能范围和限制见 [2.2 发布记录](docs/RELEASE-2.2.md)。
