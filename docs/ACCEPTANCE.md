# 2.0.0 验收记录（2026-10-02）

## 功能与协议

- `npm test`：29 项通过。真实 React Webview → Provider → Bridge → Controller → 模拟 CLI；新建、重复点击、生成中停止/新建、历史与草稿恢复、模式失败重试、侧栏重建、CLI 双击、工作区与跨项目恢复、损坏记录、迁移回滚、分页、进程崩溃、迟到事件、跨窗口锁和存储失败重试。
- CLI v1.2.14 的真实 Plan / Safe denied-action 样本经实际 NDJSON 解析器回放通过。正常和 Plan 均明确传入 `--mode`。
- 真实 Windows VS Code 1.140.0 + WSL 开发宿主完成：发送并获得 `WINDOWPASS` → Plan → 新建普通空白对话 → 切回历史及中文草稿 → 重载 → 再新建。项目名与 CLI `init.cwd` 匹配。证据：`diagnostics/reconstruction-window.json` 和截图。
- 真正的微软拼音 OS 输入已验证：`nihao` + Enter 结束 composition，未发送消息；空格选出“你好”，仍为草稿。事件与零用户消息计数：`diagnostics/reconstruction-ime.json`。测试结束恢复此前键盘布局；未修改输入法或剪贴板配置。
- 专门创建的工具子进程在 Stop 后已退出（Linux /proc 检查允许已退出的 zombie 状态）。没有对用户进程使用全局 pkill。

## 压力与延迟

实际 React bundle、Bridge、Controller、模拟 CLI 的 POSIX 进程和真实 Chromium 布局/动画帧，包含主机 30 ms 合并与异步传输。100,021 字、1000 个工具卡片、80,000,000 字节完整工具输出：P95 **54 ms**，21 次；Stop **269 ms**；输入和向上阅读的滚动位置正常。完整工具输出分文件保存、64 KiB 分页，未截断历史原文。

首次同负载 P95 为 851 ms；原因是检查点反复序列化 80 MB 工具输出。改为只保存变化的输出、检查点保存摘要后达到上述结果。此确定性测试包含浏览器，不代表真实模型等待时间。

## 同配置 CLI 对照

模型 Gemini 3.8 Flash High，high effort，Danger，普通模式，同一个仓库目录，同一个无工具短提示。每类冷启动和续聊各 5 次；原生及直接 JSON 的续聊先有一次未计入的预热轮次，侧栏续聊复用最后一次冷启动对话。冷启动计入 CLI 启动时间；续聊测发送到回复。表中为中位数 / 最近秩 P95（秒）；n=5 的 P95 即最大值。

| 方式 | 冷启动 | 已有对话续聊 |
| --- | --- | --- |
| 原生交互 CLI | 5.550 / 6.382 | 3.117 / 30.366 |
| 直接 Stream-JSON | 4.976 / 5.213 | 3.758 / 5.078 |
| 真实 VS Code 侧栏 | 5.129 / 5.682 | 3.874 / 6.422 |

数据：`reconstruction-cli.json`、`reconstruction-sidebar.json`。原生 CLI 有一次 30.366 s 的续聊离群值；未获得模型侧 token 时间线，不能将原因归咎于模型接口或 CLI。Stream-JSON 首个 agent_response 与原生可见回答不是完全相同的内部 token 指标。真实窗口的额外 IPC 延迟字段没有有效样本，未用它宣称真实窗口 P95≤100 ms；该门槛由上面的完整确定性回放验证。样本少，无法保证每次真实请求与 CLI 同速。没有降低模型或思考深度。

## 安装与回退

预重构备份：`/home/ubuntu/.local/share/antigravity-extender-backups/20261002-010303-before-2.0/`。包含已安装 1.4.0、VSIX、原历史/设置和未完成的 1.4.1 工作树。2.0 使用相同扩展 ID，保留用户 `agy` 启动器、设置名称、已有显式 Danger 值，旧存储保留。

回退：通过 WSL `code --install-extension` 安装备份中的 1.4.0 VSIX 并 Reload Window；不覆盖整份用户设置。v3 新历史不删除，v1/v2 原件未覆盖。

## 范围与限制

- POSIX 进程组清理以本机 WSL 为目标；Windows 原生扩展宿主的工具子进程树清理未验收。
- 权限交互只使用真实 `denied_actions`；未经验证的斜杠/权限快捷回复继续隐藏，提供原生 CLI 交接。
- 执行锁覆盖扩展窗口与扩展创建的 CLI 交接终端；无法阻止用户另外手动启动同一 CLI 会话。
- 真实窗口的差异预览/应用版本检查、多文件夹、磁盘故障主要由模块/链路测试覆盖，未对每个组合逐项人工点击。
- 当前读者已加载的旧页面保留在内存；工具输出在轮次持久化后只保留摘要，原文按需分页读取。

## 安装后验证

已通过 WSL 安装并确认 `antigravity.antigravity-vscode-extender@2.0.0`。独立的普通 WSL VS Code 窗口（非开发宿主）加载的 script URI 位于实际安装的 `antigravity.antigravity-vscode-extender-2.0.0/media/chat.js`。完成实际 CLI `INSTALLEDPASS` 回复、Plan 切换和再次新建普通空白对话；安装文件与构建脚本 SHA256 一致。记录：`diagnostics/reconstruction-installed.json`。测试窗口已关闭，本次创建的测试对话已归档到备份目录，原有三份记录保留。已有 VS Code 窗口需要 Reload Window 加载新版。
