# 全面优化验收矩阵（实施中）

依据：OPTIMIZATION-PLAN.md 全文，尤其 §4–8、§11.2–11.5。这里只登记可核验范围，不把候选交付、测试数量或阶段回放当作最终发布通过。

当前用户安装仍为2.2.0。当前完整回归362/362已覆盖Coordinator清理修复和经独立审查集成的agy种子辅助模块；随机链399操作/75自有CLI组清理通过。2.5.0 候选运行时已冻结，完整回归仍362/362。正式渲染矩阵18项及真实pipe压力1项已通过；完整2h测试仍运行。证据见 diagnostics/optimization-2.5-final-matrix/matrix.json 与 optimization-2.5-final-render-summary.json；已完成的模块证据和待完成的安装窗口门槛分开登记。

## 功能与资源边界

| 原要求 | 当前模块/专项证据入口 | 最终判定需要 |
| --- | --- | --- |
| 不可变cwd/model/effort/permissions/Agent/sandbox/schema/CLI身份，实际与请求配置 | executionProfile.test相关优化用例、executionProfileResolver.test.js、cliCapabilities.test.js；/workspace | 固定源码全回归+安装窗口实际配置；不降低model/high/权限获得性能结果 |
| 新建普通继承设置、后台不停止、每会话draft/context，选择事务 | concurrency-agents.test.js、webview.test.js、randomOperations.test.js | 随机链+安装窗口new/background/history/reload |
| Plan只读、跨项目重定向、Agent覆盖/实际init核对、明确批准对象 | planPolicy.test.js、reconstruction.test.js、webview.test.js；CLI-PROTOCOL-1.2.16.md真实样本 | 固定源码回归与真实窗口Plan→批准；审批前无写操作 |
| 启动停止、stdin不确定、迟到事件、崩溃、清理及执行锁 | turnRunner.test.js、processManager.test.js、executionLease.test.js、processGroup.test.js、coordinatorDisposal.test.js | 随机真实POSIX链+故障矩阵；停止指标独立记录退出/提交/按钮 |
| 物理释放失败可观察且可重试，不忘callback，不掩盖原错误 | C017实际fs/真实Webview链，C021 Coordinator disposal实际EIO | 完整回归；真WSL安装窗口停止/恢复，Windows组清理不冒充通过 |
| 有界请求、去重/回复重放、无盲重发、序列重同步、草稿revision | optimization.test.js、draftCheckpoint.test.js、webviewRuntime.test.js、requestTimingBridge.test.js、webview.test.js | 随机链/固定完整回归/安装窗口重建与错误 |
| IME/Shift/补全、autoScroll、文本选择、复制、长路径链接 | composerInput.test.js、webview.test.js、fileReference.test.js、longText.test.js | 最终完整负载的输入/滚动/选择/复制；安装窗口路径点击+IME |
| 异步初始化/迁移/分页，原子写dirty revision，预算/缓存淘汰 | storageInitialization.test.js、storageAtomic.test.js、writeBudget.test.js、fingerprintCache.test.js、transcriptBudget.test.js | 慢盘/满盘/部分提交/重开/删除+最终资源趋势与100次切换 |
| 大工具独立完整原文，bounded preview，工具增量/全量语义 | realPipePressure.test.js、toolPreviewBudget.test.js、toolPreviewRetention.test.js、webview.test.js | 最终1k/10k卡、80MB/更大输出；原文与末尾核对 |
| 公共JSONL、超长UTF8/未完尾行/替换截断，不混主对话 | agentLogAsync.test.js、nativeLogCursor.test.js、optimization.test.js、concurrency-agents.test.js | 样本/固定回归；100次开关面板资源，最终Agent上限探查 |
| Agent计数与本轮分开、按需watch、未知状态/Token不伪造 | agents.ts及以上专项；CLI-PROTOCOL-1.2.16.md | 安装窗口真实子ID/独立对话；没有可靠深层关系不承诺递归发现 |
| 附件URI/range/version/byte预算、多附件、预览目标/ID/版本 | contextAdapter.test.js、editorActions.test.js、fileReference.test.js、webview.test.js | 安装窗口文件/选区/报错/同名不同目录/过期preview拒绝 |
| 命令注册/help/补全/参数/能力一致，本地零模型、缓存失效 | commands.test.js、commandDispatcher.test.js、cliCapabilities.test.js、contextAdapter.test.js | 同配置管理查询计时，安装窗口命令；权限/凭据配置不进入模型历史 |
| 原生交接同ID/cwd/config/锁、实际TUI新增回流、重复同步 | nativeHandoff.test.js、nativeLogCursor.test.js、workspaceTerminal.test.js、reconstruction.test.js | 真WSL窗口侧栏→TUI新一轮→关闭→回流→侧栏续聊，重载外部终端归属明确限制 |
| request/turn/session/generation诊断，不跨进程直接相减/泄漏正文 | C020 requestReceiptLedger/RequestClient/Bridge/Journal/实际UI；renderReceiptLedger/Observer/Bridge测试 | 最终负载中生产Provider回执开销，测量本地分段/往返上界，真实CLI等待分开报告 |
| Controller/Provider/Webview职责、统一build/watch/package/CI/符号 | C010–C020提取；scripts/watch-build.cjs、check-package-content.cjs、archive-debug-symbols.cjs、.github/workflows/ci.yml | 最终源/构建/符号/VSIX/install manifest一致；CI本机不可运行远程不冒充green |

## 冻结构建后的性能与真实验收

| 门槛 | 状态 | 必须保留的原始证据 |
| --- | --- | --- |
| 基础10万字+1k工具80MB+3后台20Agent，≥1000增量×3 | 固定候选3轮通过，P95 52.091/52.371/51.960ms | 每轮样本/校准/输入/选择/滚动/停止/CPU/RSS/IPC/预算/构建hash；旧阶段回放不替代 |
| 百万字普通/混合Markdown/闭合与未闭合代码，完成长任务 | 普通/长段Markdown/闭合/未闭合各3轮通过；复杂结构Markdown补验待执行 | ≥1000增量×3各场景、trace/完成解析任务、完整复制/链接/末尾内容；目标未达明确原因 |
| 10k工具、更大输出、10后台100Agent、1k/10k历史上限探查 | 高负载与内存历史UI探查通过；100次后端/JSDOM/Chromium面板开关通过；磁盘初始化已排队待补验 | 探查高负载单独标记，不能冒充基础门槛；输入/停止/缓存及可恢复结论 |
| idle/hidden60s与完整连续2h | idle/hidden各60s通过；完整2h仍运行，最终资源趋势待判定 | 真Provider/Service/Chromium/pipe、CLI及工具组、Host/Webview资源/订阅/IPC趋势、最后complete报告 |
| 停止click→受理/组退出/保存commit→按钮恢复 | 固定回放分段通过；实际CLI工具停止后端通过；安装窗口按钮待验 | 分开本地时钟/跨进程上界；不能把按钮时间替代组退出或磁盘提交 |
| 同API/model/high/permission三路径各5cold5warm×短/读取/工具 | 修正后的native/directStream60/60通过；安装侧栏30样本待验 | 原生TUI/directStream/安装侧栏各原始样本/成功率/配置、模型内部时线缺失如实标记 |
| 真实安装窗口完整按钮/命令/后台/Plan/Agent/文件/TUI回流/reload | 待执行 | 独立profile/工作区/窗口、安装路径+hash、实际文件/原生日志/会话恢复 |

## 保留与条件范围

- 成功message/session原子写入是存储提交点，events.ndjson是追加的诊断索引，不能用它证明fsync或断电持久性。迁移保留原记录/可恢复staging，未提交临时文件只清理本次owned文件。最终发布文档需明确events保留/手动压缩策略，不自动删除用户历史。
- 没有可信逐轮修改记录时，/diff、/edited继续明确Git工作树/HEAD范围；不能声称所有修改来自本轮。原生Artifact review保留原生终端入口。
- S4仅在当前CLI提供可靠协议后实现：逐工具挂起批准、精确子代理生命周期/token、深层关系、btw/任务/调度/语音/配额费用/跨重载常驻执行。当前能力结论以真实1.2.14/1.2.16样本与能力表为依据，未证明的字段显示未知或明确原生入口。
- 旧版文件锁/活跃外部终端不能自动删；任何离线归档必须先确认归属，不操作用户现有锁。

## 发布门槛

- [ ] 固定源码完整回归、协议样本、随机链和故障矩阵。
- [ ] 固定最终构建性能三轮、上限探查、60s/完整2h及资源解释。
- [ ] 同配置真实三路径对照与隔离已安装窗口链路。
- [ ] version/源码快照/CLI范围/bundle/符号/VSIX/install hashes。
- [ ] README/命令/发布文档指向实际版本，包依赖检查与本机验证范围。
- [ ] 旧安装/VSIX/历史/settings备份及可执行回退步骤，不覆盖整份settings或新历史。
- [ ] AGENTS.md追加实际发布/验证/限制，逐项完成审计后才能标goal complete。
