# Antigravity Extender 当前交接入口

这是 2026-10-05 从本机冻结源码重建的交接文档，非已丢失旧文档的原文恢复。

当前仓库 /home/ubuntu/project/antigravity-vscode-extender；本轮目标 2.5.2：执行事件顺序、中断可见性、恢复边界、紧凑工具摘要、清理 Mermaid 无意义文件操作栏。性能和正确性优先。详见 [RELEASE-2.5.2.md](RELEASE-2.5.2.md) 与 diagnostics/2.5.2-*。

恢复证据：20261004-233505-2.5-completion-final-freeze 可读源码；升级前真实 2.5.1 安装包/JS 与截图链路恢复；恢复时只有后端七个文件不同，图片前端需要重建。源码恢复说明见 RESTORATION.md。

升级前备份 /home/ubuntu/.local/share/antigravity-extender-backups/20261005-224948-before-2.5.2。不得覆盖新历史或整份用户设置，不自动重载用户工作窗口。独立验收窗口工作区 /tmp/agy252-owned-window，Windows 独立 profile C:\Users\Public\agy252-acceptance\profile。该工作区使用测试 CLI，不是用户 blender1 任务；测试对话保留可审计记录。

原用户对话 sess_6bb9ceff-ee38-4452-8f8b-8b74404c583a，实施原生 ID 60911e9d-63d2-4859-885d-273007846071。日志证实 11 次流中断，最后工具后反复内部规划而未写模型；不能断言中断来自网络、代理或 CLI 的哪一方。blender1 开始检查时已为空，不归因于扩展删除。不要自动重新实施建模任务。

保留 agy-gemini / stream_compat.py 的现有 SSE DONE 兼容处理与 API 配置，未改密钥或原生二进制。模型任务质量（测绘来源、2% 比例、贴图预算、商业交付）仍由任务执行与资产验收判断，不靠界面证明。

原 2.5.0 全面优化/两小时稳定性计划仍未全部完成，不能用本轮短时回归冒充长期通过。原生逐工具审批、子代理精确生命周期/Token、跨宿主持续运行仍受既有协议限制。

最终安装 2.5.2；独立窗口从真实安装路径验收通过且已关闭。用户已有工作窗口没有重载，仍需任务结束后自行 Reload Window。完整 388 项回归、最终 55 项重点复测通过；最终压力回放 P95 66 ms、停止 107 ms。不能用早期候选 46 ms 宣称最终稳定提速。所有安装运行文件与最终 VSIX 校验见 diagnostics/2.5.2-installation.json（清单忽略 VS Code 注入的 __metadata）。用户主设置、agy-gemini 和 stream_compat.py 哈希未变。
