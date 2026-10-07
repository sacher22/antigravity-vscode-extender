# Antigravity Extender 2.2.0：原生 CLI 功能入口

## 当前实现范围

本版本完成 CLI 对齐方案中的命令基础、会话/模型/Plan/文件操作、配置和工作区/全局技能入口，并为原生专用功能提供明确终端入口。**不代表所有原生功能已在聊天侧栏复刻。** 主界面审批、旁问、语音、调度及精确子代理生命周期仍受原生协议或平台能力限制。

输入 `/help` 查看当前功能与用法。中文输入法组合期间 Enter 不提交，Shift+Enter 换行。`//` 开头作为普通文字发送。未知命令报错并保留输入。命令补全在本地进行，输入时不启动 CLI。单独控制命令不写入模型对话历史，命令草稿不持久化。

## 常用命令

```text
/new                         新建；旧对话继续运行
/stop                        停止当前对话
/history                     列出本地会话 ID
/history <ID>                切换历史
/history sync                同步原生终端新增可见文字
/plan <需求>                 只读方案，等待明确批准
/approve                     批准当前最新完成的方案
/plan off                    退出 Plan
/model                       读取完整原生模型列表
/model <模型ID>              切换原生列表中的模型
/effort high                 设置思考深度
/agents                      列出自定义主 Agent
/agent <名称>                设置主 Agent；default 恢复默认
/subagents                   打开子代理面板
/subagent <ID>               打开子代理独立对话
/parallel <需求>             要求原生多 Agent 执行
/skills                      发现工作区/全局技能
/skills refresh              刷新技能；空闲时重建当前 CLI 配置
/skill <名称> <需求>         原生展开已发现技能
/技能名 <需求>               相同功能；内置命令优先
/open "文件路径:行号:列号"   在 VS Code 打开文件
/context file                原生选择文件作为附件
/context selection           附加当前编辑器选区
/context problems            附加报错
/diff                        Git HEAD 与当前工作树差异，最多 64 KiB
/edited                      Git 改动列表；不是每轮工具文件历史
/copy                        复制最近回答
/workspace                   当前会话目录和配置
/add-dir "目录"              增加本会话 CLI 操作目录
/permissions safe            普通执行权限（Plan 始终只读）
/sandbox on                  使用原生 --sandbox；并非 OS 沙箱
/schema "schema.json"        实验：原生参数＋本地最终 JSON 校验
/schema off                  关闭 Schema
/usage                       已记录 token；不是账号配额或费用
/usage quota                 交接原生配额界面
/artifact                    列出 CLI 会话顶层非隐藏文件
/artifact "文件名"           在 VS Code 打开该文件
/artifact review             原生 Artifact 交互入口
/mcp list                    列表
/mcp enable <名称>           enable/disable/remove
/mcp add                     管理终端显示添加帮助；在那里配置凭据
/plugin list                 列表
/plugin validate [路径]      原生校验
/plugin enable <名称>        enable/disable/uninstall
/plugin install <目标>       原生管理终端执行
/plugin import [来源]        原生管理终端执行
/changelog                   原生版本说明
/version                     原生 CLI 版本
/cli                         空闲时交接原生 CLI
```

别名：`/clear` → `/new`，`/plugins` 与 `/plugin` 相同，`/quota` → 原生配额，`/record` → 原生语音。

## 原生专用入口

`/tasks`、`/btw`、`/goal`、`/schedule`、`/automation`、`/browser`、`/codesearch`、`/grill-me`、`/learn`、`/voice`、`/remote-control`、`/feedback`、`/logout`、`/keybindings`、`/migrate-workflows`、`/agy-customizations`、`/antigravity-guide` 打开原生交互终端并说明在那里输入的命令。不会把这些未经验证的命令作为普通模型提示，也不会自动在终端里提交交互命令。

`/install`、`/mic-serve`、`/update` 使用原生管理终端子命令。安装/更新会改变 CLI 环境，只有用户主动调用时才执行。当前发布验证没有执行用户配置变更、插件安装、账号退出或 CLI 更新。

## 状态与交接

- 按钮和命令复用现有 Controller。命令单独去重，连接中也可以 `/new` 或 `/stop`；旧发送回复不清空后来输入的文字。
- 模型/Agent 发现的异步回复绑定原会话，切换后不能修改新会话。
- `/cli` 和终端回退在忙时拒绝，任务保持运行；先由用户停止或等待完成。
- 空白会话交接先建立原生 ID（不发模型请求）；保留 cwd、额外目录、模型、effort、Agent、模式、权限、sandbox、schema。转移前释放扩展进程，同 ID 执行锁持续到终端关闭。
- 关闭终端后按 CLI 公开 transcript 同步 USER_INPUT 和 PLANNER_RESPONSE。私有推理、GENERIC/system/子代理内部内容不合入主聊天。最多每次读取 1 MiB，仍有记录时 `/history sync` 继续。单行超过读取上限明确失败，原始日志保留。
- 交接后的侧栏创建独立空会话；原历史可恢复。未证明跨扩展宿主重载后可无缝接管仍在运行的终端。
- 管理列表按需调用、短期缓存；技能只索引名称，原生负责展开和优先级。插件声明/内置技能没有完整侧栏索引，去原生 `/skills` 查看。共享管理配置变化不停止其他后台轮次。

## 已知原生限制

- 本机 Gemini 模型以后缀选择深度。实际 CLI v1.2.14 拒绝 gemini-3.8-flash-high 配合 --effort max；扩展不默默降级。`max` 仅对不使用后缀且原生支持的模型开放。
- 两次实际 Schema 样本均返回拼接的两段 JSON，第二段含 toolAction/toolSummary。扩展保留原文并标记失败。单个有效 JSON 也需本地 Ajv 校验所选 Schema，不猜选其中一段。Draft 07、2019-09、2020-12 和常见格式有回归；外部未提供的引用不联网解析。该功能仍标实验。
- `--sandbox` 的启动参数已实际使用；本次没有证明其每一种终端限制或 OS 隔离。
- Safe/Danger 不等于逐次审批界面。现有 Stream-JSON 不接受 control_request/control_response；denied_actions 仍是已拒绝，主界面对子代理逐操作批准仍未实现。
- `/artifact` 文件列表不等于原生完整 Artifact 评审；`/tasks` 仍用终端，不用工具卡片猜造任务状态。
- 不保证子代理准确 token、开始/结束时间及深层子代理发现；原有独立面板和后台会话行为保留。

## 性能修复

2.1.3 文件路径识别在 100k 连续文字上发生正则回溯，首次压力回放停止耗时 8812 ms。2.2 在匹配前限制起始边界，保留原文件跳转功能并增加 100k 回归。正常流仍约 30 ms 合并增量、结束后才解析 Markdown，隐藏会话不传文字。

校验依赖只在使用 Schema 时初始化；打包进 VSIX，不依赖用户安装 npm 包。不通过降低模型、effort 或权限来获得性能结果。

## 验收记录

最终测试、性能和窗口结果见 diagnostics/2.2-*.json、diagnostics/2.2-tests.txt；真实窗口结果已记录。首次失败及重跑分别保留，功能未验证部分不算通过。

备份：`/home/ubuntu/.local/share/antigravity-extender-backups/20261002-135104-before-2.2/`，包含 2.1.3 VSIX、源码、测试、历史与 AGENTS.md。回退安装其中 2.1.3 VSIX，不覆盖新历史和整份用户设置。

### 已完成结果

最终构建复跑 57 项测试通过；3 后台会话、20 Agent、100021 字、1000 工具卡片和 80 MB 完整输出，21 样本 P95 53 ms、停止 323 ms、输入和滚动保持通过，diagnostics/2.2-performance-final.json。这是确定性回放，不是模型响应保证。

真实原生技能返回 marker；Schema＋sandbox 参数启动成功，但最终多段 JSON 两次均被拒绝为合格结果，本地校验防护通过，nativeSchemaConformant=false，diagnostics/2.2-native-capabilities.json。不把这算作原生 Schema 生成稳定性通过。

真实 Windows VS Code + WSL 开发窗口完成帮助、11 模型、max 拒绝、工作区报告、原生技能、文件行号跳转、Plan 等批准、批准执行、历史恢复、重载与命令继续可用。首次 CLI 批准轮次 102.710s，第二次 345.277s，分别超过脚本 90/180s 等待；保留失败记录，结束后另行恢复验证。开发窗口恢复时的输入时序失败也保留，布局阶段恢复草稿后重跑通过。未由这些耗时断言接口或模型内部原因。普通安装窗口验证见下。


### 普通安装窗口与最终复跑

隔离的普通 Windows VS Code + WSL 窗口从 `~/.vscode-server/extensions/antigravity.antigravity-vscode-extender-2.2.0/media/chat.js` 加载实际安装包；通过 `/help`（无模型消息）、11 模型、工作区报告、原生 `/parity-installed` 技能、文件打开、`/new`、`/history`、空闲 `/cli` 交接、关闭自己的终端后同步、重载历史和帮助恢复。记录 `diagnostics/2.2-installed.json` 与截图。没有在该终端另发模型轮次，新增公开终端文字的投影与增量回流由真实协议记录及 Controller 测试覆盖；不把打开/关闭终端当成完整 TUI 对话回流验收。Plan 批准的真实执行在开发窗口单独验收。

最终全套复跑首次 56/57：批准测试误把模式改变后的短暂空闲当成完成，尚未等到新增 assistant 消息。修改测试等待实际新回复后 57/57，通过记录 `diagnostics/2.2-tests-final-rerun.txt`；首次记录 `diagnostics/2.2-tests-final.txt` 保留。未用放宽业务边界规避此失败。

测试窗口均已关闭；没有重载用户窗口、停止用户任务或修改用户设置。真实窗口仅覆盖上述路径，管理配置写入、语音、调度及完整 TUI 回流未逐项操作验收。
