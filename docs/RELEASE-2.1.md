# Antigravity Extender 2.1.0

## 改动

- 每个对话独立执行。新建、切换不会停止旧轮次；后台文本由执行器保存，侧栏只收到背景状态变化。停止只影响选中对话；删除运行中的对话先由 VS Code 原生确认。
- Plan 使用独立的只读自定义 Agent（仅 view_file/list_dir/grep_search/find_by_name），不传 Danger。Plan 与实施分别保存 CLI 会话 ID；方案正文完成后，用户可明确“批准并执行方案”。旧 Plan 执行身份不会直接复用。只读配置被修改或在工作区被同名配置覆盖时拒绝运行。
- 原生 subagent/checkpoint 事件不再被解析器丢弃。Agent 按钮显示实际 ID 去重后的数量；卡片显示角色、最近报告状态和观察到的经过时间。点击卡片按 64 KiB 页读取原生独立 JSONL 日志，仅展示可见消息和工具内容，不把子对话合并到主聊天。
- 非活动且没有待确认子代理的空闲执行器最多缓存两个，避免历史切换积累 CLI 进程；运行中的任务不淘汰。仅打开面板时订阅日志文件变化，不额外调用模型或启动监控 CLI；计时每秒更新，隐藏时暂停。流式文字仍按 30 ms 合并。
- 连续会话的 CLI 用量是累计值，新增统计按 CLI ID 取差额，避免继续把累计值重复相加。旧版已经累计的历史数值未重算。

## 验收证据

- `npm test`：36 项通过，含真实 React bundle → Provider → Coordinator → POSIX 模拟 CLI；覆盖新建时旧任务持续运行、启动期间新建、独立停止、重复点击、历史、IME、Plan 批准、原生子代理事件及独立日志显示。
- 原生 CLI v1.2.14：真实启动两个 research 子代理并行完成；取得 `step_type: subagent`、两个 conversation_id 和 log_uri。记录 `diagnostics/agents-native-probe.json`。
- 原生受限 Plan：对要求写文件、运行命令及启动子代理的请求，只输出规划；独立临时目录没有文件。记录 `diagnostics/plan-readonly-probe.json`。init.tools 是全局广告列表，不作为实际 Agent 工具白名单的证据。
- Chromium 完整性能回放：3 个后台对话、20 张 Agent 卡片、100,021 字、1000 工具卡片、80 MB 工具输出；21 样本文字显示延迟 P95 55 ms，停止 328 ms，输入与向上滚动保持通过。记录 `diagnostics/2.1-performance.json`。这是确定性回放，不能等同于真实模型首字等待。
- 真实 Windows VS Code + WSL 窗口的完整验收见 `diagnostics/2.1-window.json`；不以模拟测试替代该记录。

## 尚不支持的部分

- **主界面直接批准/拒绝子代理工具请求尚未实现。** CLI v1.2.14 Stream-JSON 不接受 control_request/control_response，不能做无效的批准按钮。已返回 denied_actions 的操作在所属主聊天显示，并提供原生 CLI 入口；这不是一个挂起的请求队列，也不能保证每个子代理权限请求都会出现在父流里。Safe 下需在原生 CLI 重试和确认；用户的 Danger 选择仍会自动批准执行阶段的工具请求。
- 原生样本的子代理 JSONL 不含独立 token usage，卡片显示“Token 暂不可用”，不估算或使用父会话用量冒充。
- 生命周期事件不完整：卡片明确标注“最近观察”；父会话结束或恢复后，没有可靠的新状态时标为“状态待同步”，不猜测子代理已经完成。时间是从扩展观察到子代理 ID 开始的经过时间，不是精确 CPU/推理活跃时长。
- 子代理详情使用手动刷新和分页，避免高频全量加载；异常超长或尚未完成的 JSONL 记录不解析。深层子代理发现尚未覆盖。
- 后台任务可以跨侧栏隐藏/重建持续运行；VS Code Reload Window 会重启扩展宿主并停止其进程，未实现跨宿主重启的任务驻留。
- 只读 Agent 是经过本机 CLI 验证的工具能力限制，不能代替 OS 沙箱或保证未来 CLI 版本行为。Plan 不使用子代理。多个普通会话共享工作区仍可能编辑同一文件，并未提供文件级并行写入仲裁。

## 安装和回退

升级包 `antigravity-vscode-extender-2.1.0.vsix`。升级前完整备份在 `/home/ubuntu/.local/share/antigravity-extender-backups/20261002-102742-before-2.1/`，保留 2.0.0 安装、VSIX、历史、用户设置和源码。

只读 Agent 定义位置：`~/.gemini/config/agents/agy-extender-plan-readonly/agent.md`，由扩展独占；不改写 CLI settings.json 或接口密钥。回退时安装备份的 2.0.0 VSIX，不覆盖整份用户设置或新历史。可移除本扩展创建的只读 Agent 定义。
