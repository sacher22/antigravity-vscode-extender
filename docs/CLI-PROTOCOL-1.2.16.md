# CLI 1.2.16 的本机协议核对

日期：2026-10-04。**这是当前优化源码的能力依据；优化源码尚未打包安装，不能当作最终发布验收。**

现有启动器 `/home/ubuntu/.local/bin/agy`，原生二进制 SHA256：
`a759ce7c7a235d9b6c281a25ead97cbbf2e92314a3ffd224e2f9144f3fae7a86`。
所有实际模型轮次使用父代理 `gemini-3.8-flash-high`，high suffix；继续调用原启动器及接口配置。没有降低模型/effort或重写用户配置。Safe 与已明确批准的 Danger 实施测试各有独立临时目录；Plan 不带 Danger。子代理的独立模型、精确时长及用量未另行取得，不伪造数据。

## 已取得证据

| 能力 | 实际核对 | 原始记录 |
| --- | --- | --- |
| Stream-JSON 与进程续聊 | 同一个 CLI ID / generation 连续两轮，真实正文、结果及 usage | `diagnostics/protocol-1.2.16-first/stream-continuation.json` |
| 只读 Plan | 读到 sentinel；面对写文件、shell、子代理要求仍只用已允许读取工具；结束目录仅原 sentinel，hash 未变 | `readonly-plan.json`、`readonly-workspace-audit.json` |
| 批准实施 | 独立普通模式、明确批准、Danger fixture 写入 approved.txt；字节精确等于 APPROVED_116 | `approved-implementation.json`、`approved-workspace-audit.json` |
| Safe 自动拒绝 | headless 实际返回 denied_actions，没有写入 shell 目标文件 | `safe-denial.json` |
| 子代理 | 原生 subagent_info 两个不同 ID、两个非空独立日志；各自公开回复分别含 ALPHA_116 / BETA_116 | `parallel-subagents.json`、`child-log-audit.json` |
| 原生技能 | 临时工作区 SKILL.md 被原生斜杠展开，正文含专用标记 | `native-skill.json` |
| Schema / sandbox | 实际参数组合可 init，返回 json_schema；只验证启动 | `launch-report.json` |
| 原生 ID 恢复 | 相同工作目录和 CLI ID 可恢复 init，再确认停止 | `launch-report.json` |
| control_request 输入 | 原生返回 ERROR：该 stream input event 不支持；num_turns=0，usage 全为0 | `control-request-report.json` |

上表原始记录均在 `diagnostics/protocol-1.2.16-first/`。所有自有 CLI 组停止都确认退出，二进制/版本身份前后一致；仅核对本次创建的目录、ID、日志和进程，不操作用户窗口或已有任务。

## 回放与产品能力

真实事件经路径/ID脱敏保存在 `test/fixtures/cli-1.2.16-captured.json`，保留原始字段。NDJSON 解析器必须接受全部捕获事件；Controller 回放同时核对 Plan/普通 ID 分离、真实拒绝状态、2 Agent卡片及技能正文。能力表仅新增精确版本1.2.16，保留1.2.14；未来版本、预发布版本继续保守阻止。

回放前支持表实际阻止了1.2.16；随后两个失败是回放脚本没有识别 Plan 前缀，以及测试错误理解当前CLI ID与模式历史ID的保存时机。修正fixture/断言后21/21协议与能力回归通过，完整回归250/250。失败记录保留在 `diagnostics/optimization-cli-116-*`。

`toolApproval=false` 保持。现有 control_request 格式有明确拒绝证据，但不能据此排除未来其他未公开格式；没有已验证的逐工具挂起/回复协议，因此侧栏不冒充审批队列，继续提供原生终端入口。Schema 仍是实验能力，不保证模型生成合法JSON；sandbox仅证明参数可启动，不证明OS隔离。

这些结果不证明完整TUI新增对话回流、已安装窗口操作、精确Agent生命周期/Token、所有原生命令、极端性能矩阵或完整2h资源长测。最终发布仍执行 OPTIMIZATION-PLAN 的全部门槛。
