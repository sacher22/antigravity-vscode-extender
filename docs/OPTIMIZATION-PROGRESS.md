# 全面优化实施记录

目标仍为完整实施 `OPTIMIZATION-PLAN.md`；本文记录阶段进度，不表示已全部交付。

最新状态（2026-10-04，C021/C022 随机链与清理故障）：完整362/362，399次真实Coordinator/POSIX随机操作及75自有CLI组清理通过，Coordinator.dispose失败可重试。最后阶段持续性能仍C019，最终发布未完成，安装仍2.2.0。

## 新增执行方式（2026-10-04，待启动）

用户要求加入由 Codex 指挥本机 agy / Gemini 3.8 Flash High 完成任务的方案，已写入计划第十二节。采用当前工作树快照、隔离源码副本、专用 CLI 会话和限定工作包；默认一次一个，Codex 独立审查补丁与验收，性能优先。首包拟处理执行归属边界审查与测试，后续覆盖故障矩阵、工程收尾和验收辅助。此次只更新文档，未启动 agy、未运行测试、未安装新版；最终交付缺口及最后两处源码未验证状态保持如实记录。

## agy 委派试点与执行归属修复（2026-10-04，未发布）

- 委派前完整 `npm test` **194/194**，`diagnostics/optimization-pre-agy-delegation-tests.txt`；已验证上一轮最后两处保守恢复规则。完整源码副本位于 `/home/ubuntu/.local/share/antigravity-extender-delegation/20261004-003952-A001`；任务输入文件哈希、合同、启动脚本和原始结果保留在 `diagnostics/agy-delegation/`。
- A001 使用现有 agy 启动器、`gemini-3.8-flash-high`（high suffix）、Safe 和只读 Agent。七文件审查在180秒内没有公开回复，按合同停止；自有进程组退出确认、输入副本未变化。失败记录保留，没有把超时当作审查通过，也没有改变接口/权限或降低模型。
- 核对退出及文件后，A002 缩小为 ID 转换单一问题，直接提供代码，要求不使用工具。真实 init 确认模型、Agent和目录；一轮产生审查结果，自有进程组退出确认、副本未变化。启动374.8ms、首公开文字115804.5ms、总127047.8ms；CLI result报告 input8651、output17487、thinking16004、total26138，字段按原协议保留，不把 thinking 再重复加到 total。原始 usage不等于费用或精确内部时间线。见 `diagnostics/agy-delegation/A002-id-conversion/result.json` 和 `response.md`。
- Gemini 指出 ensureReady 先释放本地ID锁再获取真实CLI ID锁，若新锁获取/绑定失败且停止未确认，会丢原持久归属。Codex 独立增加实际Coordinator→Controller→模拟CLI故障链路，先复现原锁可被另一Repository取得。首次注入影响了版本查询而不是ID转换；改为先完成版本发现后准确复现，两个初次失败日志均保留。
- 修复采用先取得新声明、保存意图和绑定PID，成功后再释放旧声明；保存/绑定失败时暂存组合释放函数，直到确认退出才释放两把锁；新声明获取失败则继续保留旧声明。同一ID无需重新获取；缺少实际PID拒绝转换。未采用 Gemini 建议中立即释放半成品新锁的部分，避免退出不确定期间丢掉新ID保护。
- 专项覆盖新锁获取、pending持久化、PID绑定失败，加退出未确认及成功重试，核对同仓库独占与跨Repository磁盘互斥。另新增真实Adapter脚本的三项PromiseLike/关闭后迟到PID/绑定失败测试；失败只记录结构化说明，不关闭用户终端，不暴露原异常路径。自有宿主/CLI/工具孤儿锁专项重复两轮各4/4通过（在新增pending用例前），不将它们冒充真实窗口验收。
- 最终完整回归首跑199/200：旧内存服务测试替换了start但未提供PID，触发新增检查。补齐该替身的PID合同（无真实进程/磁盘锁），保持生产检查，最终 `npm test` **200/200**，`diagnostics/optimization-agy-A002-final-tests-rerun.txt`。失败记录 `optimization-agy-A002-final-tests.txt` 保留。

结论：缩小范围并直接提供代码的委派可产生可核验结果，但本次审查等待与token开销较大，不能宣称比主控直接处理更快。后续限定工作包、减少无关上下文，并继续独立审查。当前安装保持2.2.0；真实窗口重载/原生新增轮次回流、故障资源矩阵、固定性能三轮/2h、工程发布仍未完成，全部计划保持活动。

## agy 故障工作包与停止重试验收（2026-10-04，未发布）

- 新增执行锁真实文件操作故障专项：pending/bind各注入writeFileSync/renameSync的ENOSPC，共4种；此前owner原文保持不变、临时owner文件清理、原独占仍有效，恢复I/O后绑定与释放可重试。`optimization-owner-persistence-fault-tests.txt` 12/12（含已有锁专项）。
- Codex通过实际消息临时文件写入与rename注入，复现ENOSPC部分写/EIO重命名失败后临时文件残留。Repository.atomic失败时只清理本次未提交tmp；旧完成文件保持不变，dirty数据可重试。成功写入无新增文件系统调用；清理失败产生结构化warning并保留原写入异常。`optimization-atomic-temp-before-tests.txt` 2失败；修复后after-tests.txt 2/2。
- 委派B001生成真实Webview停止重试测试，180秒截止时仅取得部分代码，未取得result；首公开文字176175.9ms，自有组退出确认、输入副本未变化。没有将它记作成功交付。Codex审查并完成测试，修正模型草稿中过早的暖会话等待、英文字样断言和可跳过按钮的回退逻辑，使用明确真实按钮与中文版错误。
- Webview专项首次被用户中断，保留`optimization-webview-stop-retry-tests.txt`。随后trace显示已经到停止失败断言附近；最终发现等待条件对缺失Stop返回真，断言尝试输出整个JSDOM按钮对象，定位过程受干扰。修正为等待实际可用Stop、使用紧凑布尔断言，完整重试链路通过；没有删除互斥、保存输出、再次发送等验收。
- 加入消息顺序断言后独立复现：turnComplete清除active时，最近runtime.terminationPending仍false。abort/send异常先发布退出未确认runtime，再完成失败轮次；防止两条消息之间临时暴露发送/设置。只在异常路径增加状态通知，正常流保持原批量。`optimization-webview-stop-state-order-before-rerun.txt`失败、after.txt通过。实际React→Provider→Service→模拟CLI验证两次Stop点击、设置和发送拒绝、原锁保留、确认组退出后释放、旧输出保留及新轮次成功；不当作真实已安装窗口验收。
- B002让Gemini完成“rename原EIO＋rm清理EPERM”的完整实际I/O测试。57.093s完成，真实init配置一致、退出确认、输入副本未变化；首公开文字54.429s，CLI报告input6120/output22728/thinking21950/total28848（原字段保留，不重复相加）。Codex审查后将返回代码加入storageAtomic.test.js；3/3通过，验证原错误优先、仅一个脱敏warning、失败tmp仍在、旧记录及dirty原文保留、恢复后重试保存成功。任务原始记录在`diagnostics/agy-delegation/B002-atomic-cleanup-failure/`。
- 最终 `npm test` **208/208**，`diagnostics/optimization-agy-B002-full-tests.txt`。当前故障覆盖增加，不据此宣称慢盘/满盘/异常退出资源矩阵全部完成。

工程包准备：vsce ls发现121个交付文件中仍有sourcemap与重复out/webview。已启动C001，让agy输出限定的包files白名单与独立调试符号归档脚本；运行证据和输入记录保存在任务目录。该任务尚待结果与独立审查。未打包、安装或改用户窗口；当前安装2.2.0，完整性能矩阵、2h、真实CLI/窗口及发布仍待完成。

## agy C001 包内容与调试符号工程包（2026-10-04，未发布）

- C001完成一轮，70.672s，首公开文字67.246s；init确认`gemini-3.8-flash-high`与Safe只读Agent，自有组退出确认、输入副本未变。CLI报告input6491/output27127/thinking26050/total33618，原字段保存，不推算费用或重复累加。
- 模型交付files负向模式＋归档脚本。实际vsce3.9.2对files正向白名单转义时，负向模式不能这样使用；首轮候选反而扩大到803文件，验证失败记录保留，未从该候选生成VSIX。改为正向列出Host目录/runtime/资源/文档；最终候选61文件，43个Host.js全部保留，无map与out/webview。`optimization-package-files-before.txt`121文件、after.txt失败候选、after-rerun.txt正确候选。
- 调试符号脚本经独立审查改为从脚本目录解析项目、输出目录exclusive mkdir、canonical路径拒绝out/media及其符号链接别名、跳过源符号链接、0700/0600权限、按复制内容核对hash、对应JS hash及失败保留。源码symbols不删除。实档`diagnostics/debug-symbols-C001/`52份map逐项核对通过；独立脚本测试覆盖外部cwd、hash/权限、已有输出、直接/别名递归目录、symlink与缺参数。未声称主动攻击下任意文件系统竞态均受沙箱保护；归档在固定构建且无并发写入时执行。
- 候选包排除2,524,913原始字节（约2.41MiB），不能当作压缩VSIX大小或启动提速。`optimization-package-symbols-C001-verification.json`记录模块与符号范围。
- 新增`check:package`，实际调用vsce发现，检查正向patterns、全部Host模块与Webview/icon存在，拒绝其他文件/调试符号/重复浏览器编译；prepublish先统一compile再检查。新增Linux Node24 CI构建/回归/包内容配置，未远程运行，不把本地通过当作CI成功。真实API/Windows窗口/性能门槛另行本机验收。
- README安装入口改为实际现有2.2.0包，明确工作树未发布，补独立符号留档与发布门槛；未把优化源码称为已安装新版。`npm test`最终**209/209**，`optimization-agy-C001-full-tests.txt`；最终包检查`optimization-package-check-C001-final.txt`通过61文件/43模块。

下一步保留完整目标：初始化原子记录与磁盘/恢复资源故障收尾、Controller/Provider剩余职责提取及路径语义核查，随后冻结候选构建，完成全部最终性能三轮/2h、真实原生回流与CLI同配置对照、隔离已安装窗口和发布。当前没有因模型交付而降低验收门槛，也没有改接口、权限、用户历史、GUI或用户窗口。

## agy C002 路径提取与共享原子记录（2026-10-04，未发布）

- C002完成31.391s、首公开文字27.278s；init模型/只读Agent/目录正确，自有组退出确认、输入副本未变。CLI input5758/output12847/thinking11984/total18605，原字段保留。返回纯core/fileReference模块与Provider薄适配；Codex修正返回示例的import位置后采纳，原有Provider/Service回归保持通过。
- 独立边界测试复现继承的解析缺陷：file URI先整体decode会把编码后的`#L12`当行号，把`%2520`二次解码；Windows file URI未转换WSL盘符；模拟win32路径仍受Host path类型影响。改为原始显式行号先解析、URI仅由URI解析器解码一次、普通编码文件名在scheme分类后解码、Windows URI转/mnt盘符、按目标平台选path flavor。原始未知URI scheme仍拒绝；编码分隔符作为文件名经文件路径入口处理。模块仅在文件操作时使用，无流式/每token新开销。
- 3项路径测试覆盖Unicode/空格、根目录优先和去重、缺文件、tilde、字面百分号、行列、Windows drive/URI和未知scheme。`optimization-file-reference-edge-before.txt`保留原缺陷；首修edge-after.txt 21/22暴露普通编码冒号被scheme判断拒绝，调整分类先后，最终完整通过。未声称Windows原生宿主或真实窗口点击已验收。
- 迁移atomic也有失败后残留问题，两项完成标记writeFile部分写ENOSPC/rename EIO测试先复现失败。新增共享`conversation/atomicFile.ts`，Repository与初始化均使用独立UUID+wx临时记录，失败只清理本次文件，正常写入无额外fs调用。迁移清理失败通过进度说明，日常保存通过结构化warning；清理/报告的次级异常不覆盖原写入失败。完成标记失败不提交migration.json、不遗留迁移锁，保留legacy backup和已迁移消息；重试保持稳定ID和interrupted状态且无重复。
- 新增临时名称collision测试：EEXIST不删除已存在tmp、不改变已提交内容；报告回调抛异常仍保留原EIO。`optimization-shared-atomic-tests.txt`9/9（此前基础共享实现）；最终新规则纳入完整回归。旧宿主崩溃遗留tmp的离线恢复/保留策略仍需整理，不能把运行中失败清理当作全量历史垃圾清除。
- 最终 `npm test` **216/216**，`optimization-agy-C002-full-tests.txt`。`optimization-package-check-C002.txt`实际候选63文件/45Host模块，无maps/重复浏览器产物。此前C001的52份symbols归档属于C001构建，新增模块后不当作最终版本完整符号档。

当前安装继续2.2.0，未发布。剩余工程拆分、完整故障/资源矩阵、真实原生新增轮次回流和CLI对照、固定最终性能三轮/2h、已安装窗口及发布门槛继续保留。

C002构建持续回放已结束exit0：`optimization-agy-C002-sustained.json/txt`，1001有效文字样本/1000次40ms增量，最终200001字、20000次工具替换、1000工具卡片/80MB原文、3后台/20Agent。文字到显示P95 **50.667ms**，输入自动化P95 **12.809ms**，时钟漂移0.093ms，errors为空；选择/滚动保持通过。这轮`termination=completed`，字段stopMs=23.417ms实际测量结果完成到发送按钮恢复，**不是点击停止到进程组退出**；完成窗口未观察到longtask条目（最大值字段0，非零渲染耗时）。此为一轮阶段基础回放，不替代最终三轮极端矩阵、真实模型延迟、资源趋势或2h验收。

## agy C003/C004 编辑器预览与应用职责（2026-10-04，未发布）

- C003用了完整编辑器模块合同，CLI152.402s返回SUCCESS但公开正文与result.response都为空，input7056/output0。没有实现交付；已记no-deliverable，确认自有组退出与输入副本未变后缩小为C004预览/apply包。运行器新增空交付检查及result-only正文恢复；原始SUCCESS与空响应仍保留，不把协议成功等同任务完成。
- C004128.518s完成一轮，首公开文字120.958s；init模型/只读Agent/目录一致，自有组退出确认、输入副本未变。CLI input6082/output49711/thinking48504/total55793，原字段保留。这轮token/等待开销较大，不能宣称委派提速；后续任务合同需包含依赖API定义，避免模型猜构造器。
- 候选CodePreviews无release callback，隔离副本tsc报错；文档关闭处理只留占位代码。Codex补齐现有diffProvider释放与closeDocument订阅后隔离类型检查通过，再集成EditorActions；Provider保留薄转发，模块负责代码归属、previewId/target/version/hash核对、注册表与订阅释放。未替换CLI或引入额外模型调用/定时器。
- 新增11项直接模块测试覆盖同basename独立ID/差异URI、切换活动编辑器后应用仍指向预览目标、版本/原文/会话变化拒绝、旧代码与open期间会话变化、失败apply可重试、diff命令失败、diff打开期间session/version/source变化、关闭预览与dispose期间迟到打开。初始四项故障复现后增加：失败清理本次预览；await后重新核对会话/文档/代码和预览存在；dispose幂等并阻止迟到操作。原错误记录保留。
- 首完整224/225、再226/227均是同一Webview预览测试超时：旧测试在构造后替换Provider私有diffProvider，组件已捕获构造依赖。改为harness构造时注入mock，保留真实按钮/URI/文档版本/外部编辑拒绝断言；没有删测试。最终`npm test` **227/227**，`optimization-agy-C004-final-tests-rerun.txt`。模块首次5/5、故障前失败及隔离编译原日志均保留。
- 最终`optimization-package-check-C004-final.txt`64文件/46Host模块；新增模块在实际候选中，map/重复浏览器产物仍排除。当前Provider1041行，EditorActions新增预览职责；文件打开/上下文与命令Dispatcher及Controller/前端其余工程边界仍待收尾，不能将本次提取当作全面重构完成。

当前没有活跃委派或测试进程；所有C003/C004停止均只处理本次自有CLI组。后续继续完整目标：剩余工程边界、故障/资源矩阵、固定最终构建三轮与2h、真实原生回流/同配置CLI对照、已安装窗口验收与发布。当前未生成或安装新版，未触碰用户窗口。

## agy C005 文件打开职责与点击链路（2026-10-04，未发布）

- 新建当前源码/构建独立输入副本，仍用原agy、Gemini3.8FlashHigh/high和Safe只读Agent，一轮300s/48KiB预算；72.474s返回交付，首公开文字62.281s，启动334.4ms，自有组退出确认、输入副本hash未变。原usage input7746/output12050/thinking10299/total19796，保留字段不重复累加。原记录diagnostics/agy-delegation/C005-open-resource/。
- 候选错误引用./pathResolver，独立编译失败后修为../core/fileReference。模型建议测试没有fixture实现，未算通过。主控独立15项EditorActions测试通过后集成；文件打开/位置解析迁入EditorActions，Provider保留薄兼容入口，当前997行。无新增轮询或正常对话模型请求；保留现有同步exists查询，不能将职责提取称为消除全部Host同步I/O。
- 补root优先级、一次URI解码、Unicode/空格、行列clamp、缺失/打开/显示失败重试、会话切换与dispose迟到检查。实际React→Provider→EditorActions点击完整file URI、精确行列、对应请求ID、打开错误恢复与切换期间迟到failure测试通过。
- 首targeted50/51因测试mock模块加载后添加Position导致缺绑定，补齐前置mock后51/51；首full230/232因薄兼容入口遗漏和旧测试探测真实系统CLI，恢复入口且单元测试改用模拟版本。最终**232/232**，diagnostics/optimization-agy-C005-full-tests-rerun.txt；初次失败/隔离编译保留。包检查64files/46Host模块，diagnostics/optimization-package-check-C005-final.txt。
- 新观察：本机原agy --version现为**1.2.16**，当前源码能力支持仅验证1.2.14，未知版本保守阻止保持。C005正常init/交付不等于新版本完整协议验收；已在计划12.5加入新版身份冻结/Plan/Agent/权限/停止/原生回流核对。

当前安装仍2.2.0，未打包/安装新优化源码，未触碰用户窗口或任务。下一步继续Controller/Provider命令与上下文/Webview剩余职责、生产Webview可见时间线、故障/资源矩阵及新版本协议核对，再固定最终构建完成三轮/完整2h、真实CLI同配置对照、原生新增轮次回流与安装发布。阶段232项回归不能替代全部门槛。

## agy C006 上下文模块与并发附件（2026-10-04，未发布）

- 独立源码副本、原agy/Gemini3.8FlashHigh/high、Safe只读Agent，201.735s交付、首公开文字190.615s，CLI原usage input7588/output32318/thinking30474/total39906；自有组确认退出、输入副本hash未变。diagnostics/agy-delegation/C006-context-adapter保存合同/原始代码/失败/审查及集成hash。不能把委派时长当性能优化收益。
- 候选泛型队列独立tsc失败，初始测试8/11，三个dispose提示为英文未通过；修复为void尾Promise、中文动作错误、最大16项提交、每项16附件/1MiB及分批提前验证。代码hash对应实际code，使用Buffer字节统计避免额外编码复制。独立编译与13/13通过后集成。
- ContextAdapter负责文件/选区/诊断请求、快照与上下文合并；Provider按原会话ID捕获runner保存并抑制dispose/切换后的UI发布。异步文件阶段无部分保存，提交时向最新上下文合并，失败不毒化队列。文件选择器返回和每次读取后核对原会话。诊断支持workspaceRoot fallback、路径边界、100项和字节限额。
- 真实Webview初次46/48：空白对话新建按既定约定保持ID；此外真实去重把所有requestContext合并，导致读文件时选区按钮被忽略。测试改从有内容旧对话开始，生产按上下文类型去重。最终targeted48/48和**完整247/247**，diagnostics/optimization-agy-C006-full-tests.txt；失败保留。实际包65文件/47Host模块，无map/重复浏览器bundle。Provider900行，其他提取范围仍待完成。
- scripts/probe-current-cli-protocol.cjs增加显式版本/二进制身份冻结的1.2.16隔离协议验证，普通两轮续聊、只读Plan恶意要求、批准实施、真实Safe拒绝、两个真实子代理ID与日志、原生技能。每轮300秒、输出预算、自有组退出确认；不是生产自动探测，也不修改用户配置或能力支持表。当前运行结果待核对，不算新版本已支持。

安装仍2.2.0，完整优化未发布。下一步继续协议结果/职责收尾、生产可见时间线、故障资源矩阵和固定最终构建三轮/完整2h、真实CLI/回流/隔离安装验收。

## CLI 1.2.16 实际协议与能力支持（2026-10-04，未发布）

- 原agy/父代理Gemini3.8FlashHigh/high，冻结版本与二进制hash，独立临时目录实际六组通过：同进程两轮、只读Plan面对写/shell/子代理要求、明确批准后普通模式写入、Safe实际denied_actions、两个真实子代理ID及独立日志、原生技能展开。Plan目录最终仅原sentinel且hash一致；批准文件字节精确；两个子日志公开回复分别匹配专用marker。原始数据diagnostics/protocol-1.2.16-first/，未改用户设置/权限/API/启动器或触碰已有任务。
- Schema/sandbox组合init与原生会话恢复init两组通过；仅参数启动/ID/cwd，不证明JSON生成、OS隔离或完整TUI回流。control_request实际ERROR明确“不支持此event”，num_turns和全部usage为0。每组自有进程退出确认，二进制/版本前后一致，未经验证逐工具审批仍false/原生入口。没有检查或伪造子代理独立模型/精确生命周期/token。
- 脱敏真实事件保存test/fixtures/cli-1.2.16-captured.json，增加解析器全部事件计数及Controller Plan模式ID、拒绝、2Agents/卡片、技能消息回放。首次1/3因能力表尚未支持；随后回放未识别Plan前缀及测试误解当前/模式历史CLI ID时机失败，均保留。最终21/21协议/能力测试通过。
- 能力表现在支持精确1.2.14与1.2.16，未来/预发布继续保守阻止。**完整250/250**，diagnostics/optimization-C006-cli116-full-tests.txt；详细范围docs/CLI-PROTOCOL-1.2.16.md。包检查66files/47Hostmodules，无map/浏览器重复。新增支持源码尚未安装。

当前无活跃委派/协议任务；安装仍2.2.0，整体优化继续实施。下一步补生产Webview收到/DOM/下一帧时间线，再继续Controller/Provider命令/Webview职责与故障资源矩阵，固定最终构建三轮/完整2h、同配置CLI/TUI/侧栏对照、真实TUI新增轮次回流和隔离安装发布验收。不得凭250项测试宣布全部完成。

## S0 工作树修复（尚未发布）

- 恢复重定向保留 Plan 与执行限制；普通新建仍默认普通模式。发送前检查本轮模式一致。
- 完整记录 JSONL 读取器共享于父/子日志；跨 UTF-8 和 64 KiB/1 MiB 不丢记录；8 MiB 以上明确拒绝并保留游标及原日志。未知私有记录不投影。
- Agent 关闭订阅清空 debounce 引用，再打开可接收通知。
- 请求结果重放，已完成结果缓存最多 1024，运行中的去重项不淘汰。独立 RequestClient 用实例 ID 隔离，超时报告结果未确认，不重复提交；关闭回收定时器。
- 序列缺口只发一个快照恢复请求。
- 新建/切换/删除通过选择队列，复合 slash 命令捕获执行器；同步选择的后续操作不会被旧新建覆盖。
- 工具持久化用对象预览标识区分完整输出与已落盘摘要；失败后输出增长可重试；写盘期间新输出不会被旧检查点截断。

备份：`diagnostics/optimization-backup.json`。源码快照包含此前未跟踪改动；历史是不中断用户任务的尽力快照。

证据：`diagnostics/optimization-s0-final-tests.txt` 67/67，包含批准对象校验后的复跑。

基础压力回放：`diagnostics/optimization-s0-performance-rerun.json`，3 后台对话、20 Agent、100021 字、1000 工具、80 MB 输出、21 样本，P95 51 ms、停止 275 ms、输入与向上滚动通过。该样本范围沿用旧基线，不能证明计划 S2 的持续吞吐/千样本/内存目标。

初始编译失败和压力回放初始化失败原记录保留。回放页面缺少 randomUUID 暴露初始化兼容问题，实例 ID 已使用 getRandomValues 后备路径。

## 待完成

S0 还需扩大故障/按钮链路覆盖与实际安装窗口验收。基础性能门槛已复跑通过。尚未升级版本或安装；原 2.2.0 保留。
S1、S2、S3 均待实施。S4 按原计划依赖原生协议证据，不以猜测实现。

## S1 已推进（阶段尚未完成）

- `core/cliArguments.ts` 共用 Stream-JSON/原生终端参数，Plan + Danger 组合直接拒绝。
- `conversation/executionProfile.ts` 固定启动参数及目录副本，Schema 内容指纹参与复用签名；轮次开始捕获配置，设置变化不会改写连接中的轮次。
- 原生交接统一使用已核验的恢复入口与启动配置；旧 CLI cwd 不匹配不能直接交接错误项目。
- Webview 自动滚动服从 `autoScroll=false`。
- `npm run watch` 改为串行合并构建 Host/Webview/Schema，实际启动和源文件 mtime 变化的两次构建记录见 `diagnostics/optimization-watch-build.txt`；只停止本次自己的监听进程。
- 本机 CLI help 未提供可验证的规则关闭选项，`includeProjectRules` 标为弃用并明确无法禁止原生规则。

验证：`diagnostics/optimization-s1-tests.txt` 69/69；新增参数一致、Plan 参数拦截、不可变目录及 Schema 内容变化测试。尚未证明完整阶段退出条件：每会话权限、模块职责拆分、诊断时间线、命令元数据和真实安装窗口仍需推进。

S1 当前基础 Chromium 回放通过：21 样本 P95 50 ms、停止 302 ms，输入与滚动保持通过；见 `diagnostics/optimization-s1-performance.json`。仍只代表基线回放范围，完整 S2 性能目标待验证。当前版本仍为 2.2.0，尚未发布安装优化版本。

## 每会话权限、诊断与缓存推进

- Safe/Danger 改为会话持久化字段；旧记录首次恢复采用当时全局默认并标注 migrated-default，不推断旧历史权限。新建继承当前选择，界面快照显示当前会话值；全局用户设置不再被权限按钮重写。Plan 仍强制只读且不带 Danger。
- `TurnDiagnostics` 使用单调时钟，记录 accepted/cli-ready/stdin-submitted/first-cli-text/阶段/结束的首次里程碑，无提示词、工具正文或逐 token 日志。
- 草稿使用合并的 metadata 队列，避免遍历和序列化已加载聊天/工具。完整检查点是合并排序边界。
- 未选中、无轮次/串行操作/原生交接的会话可释放持久化聊天缓存；保留执行器与 Agent Registry，不终止状态不明的子代理。切回现有执行器时重新载入记录。lastMessageStatus 保留历史状态。
- 隐藏侧栏不发送带序列号的执行事件，重新显示发送快照；运行记录由执行层保持。流式期间不再每增量扫描完整回答提取代码块。
- 迁移工具摘要只有原文文件实际存在才标记为已落盘预览，保留旧格式完整工具输出的迁移路径。

证据：权限测试 70/70；缓存首次 70/71 暴露历史切回缺少重加载，修复后 71/71；诊断完整回归 72/72。初次失败保留在 optimization-metadata-tests.txt。
基础 Chromium 回放 `optimization-cache-performance.json`：21 样本 P95 49 ms、停止 300 ms，输入与滚动通过。千样本、持续吞吐、完整资源分析及真实窗口仍待完成。

扩大回归 `optimization-cache-hidden-tests.txt` 74/74：覆盖 100 会话创建与再次访问，释放后 loaded/saved/files 缓存归零且全部原文可恢复；真实 React/Provider 链路验证隐藏侧栏无可见输出更新、重新显示快照恢复回答。缓存边界测试不等于两小时系统内存 soak 验收。

## S3 命令与文件交互推进（仍未发布）

- 补全支持上下键、Tab、Escape；选中行按 Enter 填入，未选中仍发送完整命令。IME 组合期间上述按键不触发命令提交。
- 每个已闭合代码块都有复制/预览/应用操作。previewId 绑定会话、消息、代码块、目标 URI、版本和原文 SHA256；切换活动编辑器不改变应用目标。应用前再次核对会话、来源代码和文件版本/内容。
- Diff 虚拟 URI 含独立随机标识，同名文件不共享。关闭预览文档、成功应用或缓存淘汰释放内容；注册 Provider/资源 dispose。预览注册表最多 32 项，原文件只保存摘要，不保留额外完整副本。
- 预览/应用/复制错误出现在所属代码块；文件链接错误出现在所属文本块。没有目标文件不再静默返回。
- `/diff` 改为 stdout 有界读取（64 KiB），继续排空输出，不被 128 KiB execFile 缓冲限制击穿；禁止 Git 外部 diff/textconv，5 秒超时，保留 Git 错误原因。无 HEAD 与不存在目录均有具体错误。
- 删除未实现的旧界面请求类型。

证据：补全回归 75/75；多代码块及 token 单元回归 77/77；编辑器链路 78/78；大 Git 输出/具体错误回归 79/79。预览链路的初次测试替身缺 API 和第二次过早观察异步按钮状态失败均保留，最终用实际请求到达及按钮状态验证。完整真实 WSL 窗口仍待验收。

当前最终功能回归 `optimization-interaction-final-tests.txt` 79/79。代码预览阶段基础 Chromium 回放 `optimization-interaction-performance.json` P95 49 ms、停止 272 ms（21 样本）；该回放发生在最后文件链接错误/旧类型清理前，不作为完整最终发布性能证明。

## 附件与异步历史推进

- ContextAttachment 保存真实 URI、文件名、范围、文档版本、内容 SHA256 与 UTF-8 字节数；items 保留多份上下文，旧单附件可兼容读取。
- 文件选择支持多选；侧栏新增选区按钮，`/context selection` 共用入口。相同 URI/范围更新原附件，不同选区分别保留；附件按项移除，草稿/历史恢复保留列表，新建清空。
- 总上下文预算 1 MiB、最多 16 项，超出报错且原附件不被修改；显示实际字节数，没有把字节声称为 token。附件来源/版本/范围入站校验。
- 项目诊断只收集工作区目录下内容，最多 100 条并标注省略数。
- getSessionAsync/pageAsync 使用 fs.promises 读取当前页/历史页，工具文件目录仅读取一次；Provider ready 与会话切换预载入异步页，历史请求等待真实读取完成。保留同步兼容 API，初始化元数据/迁移、文件跳转/Agent 等仍有同步路径，不能声称存储已完全异步。
- 历史页读取在 Controller 串行操作内，避免缓存释放期间丢页；分页顺序验证禁止调用同步 readFiles。

证据：`optimization-attachments-tests.txt` 81/81；异步历史及附件校验回归 82/82。`optimization-attachments-performance.json` 基础 Chromium 回放 P95 48 ms、停止 279 ms（21 样本），输入与滚动保持通过；发生在最后入站验证和文件选择链路测试前，不作为最终发布性能证明。

当前完整回归 `optimization-context-current-tests.txt` 83/83，包含多文件选择的 Provider 链路、选区范围/版本与历史恢复。优化源码仍未发布安装，原 2.2.0 不变；完整计划和真实窗口/持续吞吐/最终交付门槛继续保留。

## 持续负载与工具批量推进

- 新增 `scripts/benchmark-sustained.cjs`：不等待每段显示后再生成下一段；40 ms 间隔持续注入 1000 段，每段 100 字，保留 3 后台对话/20 Agent/1000 工具/80 MB 初始输出。采样先确认对应 step 文本长度，再等待 requestAnimationFrame；同机 epoch 时钟，不将任意 DOM 变化当正文已显示。
- 三轮基线各 1001 个确认样本：P95 59.8/59.1/59.2 ms，100 次输入自动化探测 P95 34.77/36.44/34.24 ms，完整停止 308/309/287 ms。输入指标包含 Playwright 自动化成本；停止仍为最终按钮恢复，未将它声称为“受理状态”时间。Host CPU/内存另存，未声称包含 Webview/CLI 资源或长时间内存稳定性。见 optimization-sustained-summary.json。
- 本轮检查点只序列化指定 dirty 消息（本轮 user/assistant）；全局状态兼容路径仍保存全历史，防止丢旧消息。草稿仅写元数据。
- 修复最终工具输出未变化时仍保留完整内存副本的路径：提交成功后裁剪捕获的同版本对象，完整文件保留；并发新输出不会被旧检查点裁剪。针对性完整回归 85/85。
- 检查点优化后的独立持续复测 1001 样本，P95 59 ms、输入 P95 32.75 ms、停止 313 ms；发生在工具批量实现前。
- 工具变化按 step 合并至约 30 ms，同一 step 只传最新预览；每批最多 32 工具且估算上限 192 KiB。完整输出仍由执行/存储层保留。Webview 单批用索引应用，避免每项复制整数组；工具阶段名称变化也合并。结束/停止前 flush，不丢最后状态。
- 工具批量首次测试 84/85：手工构造的旧 ActiveTurn 测试对象缺新 pendingTools，更新测试构造并加入快速 500 次同 step、100 工具停止冲刷验证后完整 86/86。失败记录保留在 optimization-tool-batch-tests.txt。

连续工具流的新负载复测进行中，旧三轮不作为本次工具批量后的最终验收。大代码完成解析、1M 文本/10k 工具、隐藏/闲置 CPU、慢盘、2h soak、真实 CLI 同配置对照和实际安装窗口仍未完成；完整目标不变。

连续工具流首两轮（工具批量版、工具修订/滚动修复前）各 20000 次工具更新、1000 文字增量并通过。第三轮向上滚动验收失败（81400 != 0），原失败保留 `optimization-sustained-tools-3.txt`。修复滚动标记与 scroll 事件的时序：布局更新前核对真实 scrollTop 与此前预期位置，向上移动即暂停跟随，兼顾内容变短的自然位置钳制。

工具预览原来只初始化一次 output，后续替换内容未同步；加入本地输出修订号、按修订更新预览/重置分页、忽略过时详情。仅已展开工具在变化稳定 300 ms 后按需刷新，无全局轮询，关闭卡片不请求详情。工具错误显示在卡片。

对应测试首次选择了参数 pre 而非输出 pre，保留初次失败并改为选择输出节点；实际 React/Provider 替换输出链路针对性 19/19 通过。滚动修复后的连续工具流第三轮复跑通过（见 optimization-sustained-tools-3-rerun.json），仍需额外两轮相同最终代码复测才能作为该场景最终三轮门槛。

当前完整回归 `optimization-sustained-current-tests.txt` 87/87；最新连续工具流复测 1001 样本 P95 61.4 ms、输入自动化 P95 36.83 ms、完整停止 238 ms、向上滚动保持。当前构建哈希 `optimization-current-build-hashes.json` 供后续相同代码三轮复测核对。尚未安装优化版本，完整计划继续执行。

## 全面计划复核与百万字缺口

同构建持续工具流额外两轮已完成：`optimization-sustained-tools-final-2.json` 和 `optimization-sustained-tools-final-3.json`。三轮汇总 `optimization-sustained-tools-final-summary.json`，各 1001 样本/20000 次工具更新，正文 P95 61.4/59.5/49 ms，输入自动化 P95 36.83/36.07/40.79 ms，完整停止 238/235/213 ms。此构建早于后续 Markdown 提取。

已读取此前运行的百万字分段计时结果（本次未启动新测试）：`optimization-million-render-stages.json/.txt`。21 样本文字 P95 133 ms，完成 700 ms，完成长任务 289 ms；长块解析 23 ms、清理 6.3 ms、DOM 写入 1.4 ms、路径识别 5 ms。该运行因 P95 超过 100 ms 返回失败，保留原结果。分段指标未包含全部布局/绘制，根因需浏览器 trace 继续定位；不能认为单独移到 Worker 即可解决。

`OPTIMIZATION-PLAN.md` 第十一节补充了最新证据、七个剩余工作包、具体验收、协议受限能力的决策及发布检查；正文状态更新到已有 87 项回归的实际范围。最新 Markdown 计时提取尚未完整回归，不能沿用之前结果称最终构建通过。仍未打包/安装优化版本，完整交付未完成。

## 百万字正文与完成阶段改造（仍未发布）

- 浏览器 trace 明确追加单字也会触发整段排版：百万字未分段时 Layout 可达约 76 ms，完成约 96 ms。原始 trace 与失败结果保留。
- `webview/longText.ts` 将超长正文/代码文本分成有界的显示段，保留全部 DOM 文本、Unicode 边界、Markdown 内联格式与文件链接；使用 content-visibility 减少离屏排版。正常短块保持原路径，已显示的前缀不反复替换。
- 分段初始 block 布局会给选中文本添加换行，已改为 inline-block；混合 Markdown 又暴露边界空格被吞掉，已将可折叠边界空白留在外层行内流。没有截断完整回答或代码原文。真实 Chromium 选择与未分段原生选择对照；代码复制按钮继续使用完整源代码。
- 完成/失败/停止使用 `turnComplete` 的对象绑定差异更新，避免重发完整回答、全部工具和重复 result.response；正文仅在结果没有对应 stream 或 Schema 格式化改变时发送。重建/主动 ready 仍用完整快照，累计用量和会话摘要随完成更新。过时轮次不能清除新轮次 busy。
- 快照复用没有改变的工具对象及列表，减少无关工具卡片重渲染。替换参数/正文时仍更新。
- 百万字探查：正文 P95 133→46 ms，完成长任务 289→59 ms，见 optimization-million-finalization.json。这是 21 样本定位结果，不作为千样本验收。
- 扩大持续脚本：初始百万字、1000 文字增量、每增量 100 字/40 ms、20000 工具替换、1000 卡片/80 MB 工具原文、3 后台/20 Agent。普通正文三轮 P95 57.1/56.0/57.9 ms，输入自动化 P95 32.57/33.15/34.88 ms，完成长任务 65/63/64 ms；闭合代码三轮 P95 57.7/57.3/57.7 ms，输入 P95 32.13/37.36/32.48 ms，长任务 50/0/0 ms（0 表示未观察到 ≥50 ms longtask）。各 1001 样本，选择/滚动通过。汇总 optimization-million-summary.json。
- 这些普通/代码三轮发生在后续混合段落与异步初始化变更之前；不当作最终发布构建证明。最新固定构建的混合 Markdown 三轮已通过，各 1001 样本/20000 工具更新，正文 P95 56.0/56.3/56.3 ms，输入自动化 P95 31.25/31.73/32.40 ms，完成长任务 71/77/82 ms，格式/文件链接/原生选择/滚动通过。记录 optimization-million-markdown-rerun-{1,2,3}.json；固定构建 optimization-worker-markdown-build.json。
- 回归新增完成差异、result-only、恢复完整快照、工具身份、迟到完成、Unicode 与内容保存。初次新测试未等模拟 CLI 的真实初始 step，混入迟到模拟事件导致等待；保留失败日志，修复同步点并加超时后通过。仅终止自己已卡住的测试进程及其已核对的模拟 CLI 进程组。

## 异步初始化、迁移和工具详情

- 生产 activate 使用 `SessionStore.open()`，异步准备元数据/迁移并预载当前会话页，Window 进度显示阶段。直接构造的同步接口保留兼容测试/旧调用，不能把它称为已删除。
- `storageInitialization.ts` 使用每会话 staging 再发布，稳定迁移消息 ID；已提交 v3 不被旧源覆盖，既有不完整目录另存 quarantine，旧源/备份保留。I/O 失败不写完成 marker，可以重新迁移。
- 多窗口首次迁移使用填充后的目录原子发布锁；WSL 用 boot ID + /proc start time 识别 PID 重用，失效锁按属主 token 归档且不覆盖新属主，释放先原子移走自己的目录。此锁仅覆盖迁移；原执行/写入锁加强仍待完成。
- 少量元数据异步并发上限 8；≥500 份元数据用短时 Worker 离开 Host 进行读取/解析，每批至多 32 条及估算 512 KiB（单条例外），完成等待 Worker 退出。无常驻 Worker、CLI 或模型请求。Worker 内部同步磁盘调用不等同 Host 同步 I/O；超 8 MiB 元数据保留原文件并记录隔离原因。
- 工具落盘详情使用异步 64 KiB 页，UTF-8 边界明确，不合法页码/内容报错；捕获来源会话并拒绝迟到回到其他会话。活动工具完整原文的内存/spool 优化仍待完成。
- 普通逐文件异步启动的实测是总时长变慢：1000 元数据约 203–206 ms，10000 约 1800–1985 ms，但 Host 心跳最大间隔约 6–14 ms；原同步 10000 约 191–239 ms 且心跳阻塞约 195–243 ms。保留 optimization-startup.json。
- 加 Worker 后三轮 1000 元数据 72/71/102 ms、心跳 6.2/6.0/5.5 ms；10000 元数据 329/308/307 ms、心跳 29.2/14.9/14.1 ms，见 optimization-startup-worker.json。是本地暖缓存合成 Repository 测量，无 CLI/Webview；仍比同步总时长略慢，改善的是宿主响应性并明显快于逐文件异步版本。未证明远程/慢盘、冷缓存或真实窗口启动时间。
- 完整回归最新 `optimization-worker-selection-final-tests.txt` **97/97**，覆盖生产无 Host 同步读取、Worker/坏记录、并发迁移、较新记录保护、不完整记录保留、磁盘失败重试、UTF-8 工具分页等。

完整计划仍待列表虚拟化、持久化积压/资源预算、活动原文及时落盘、原生日志身份与锁恢复、命令元数据/草稿、同配置真实 CLI 对照、慢盘与长时间资源、真实安装窗口及发布。未打包安装，2.2.0 保持；不更新 AGENTS 为已交付。


## 删除恢复、虚拟列表与原生日志异步读取（仍未发布）

- 删除以记录目录原子重命名为提交点。失败保留历史/草稿/选择并允许重试；提交后清理失败保留 tombstone，重复删除仅重试对应清理。重复请求共享操作；加载等待删除，避免旧异步读取把缓存复活。执行器仅在存储删除成功后释放，其他背景任务保留。临时故障链路已通过，未删除用户真实历史。
- `heightIndex.ts` 使用 Fenwick 索引，`VirtualRows.tsx` 对消息和工具窗口化，并保留展开详情、选择范围及键盘焦点。真实 Chromium 一万卡片初始 22 / 底部 33 张挂载；一千消息约 12 条挂载。加载 30 条不同高度的旧历史时，锚点由 45px 恢复至 45px。修复前旧估计高度导致锚点被卸载的失败日志保留。
- 恢复历史锚点时先同步测量有限的已挂载行并更新高度索引，再更新占位和滚动，恢复期间暂停旧 viewport lookup。展开的离屏工具高度改变保持滚动锚点；键盘焦点和选中文字随滚动保留。详情见 optimization-virtual-browser-focus.json、optimization-virtual-browser-resize-rerun.json；末条实际可见验证也通过（optimization-virtual-browser-visible.json）：底部24张挂载，工具锚点645→645px，不仅检查 overscan DOM 存在。
- `/copy [last|loaded]` 包含检查点前当前完整回答；停止后完整正文保留；loaded 明确仅复制已加载会话正文，不伪造完整未加载历史或工具原文。完整链路回归覆盖10万 UTF-16 单元的 Unicode 文本，不依赖虚拟 DOM 文本聚合。
- 同固定构建扩大持续负载：百万字混合 Markdown、10000 工具/80MB 原文、1000 个增量及 20000 工具替换、3 背景会话/20 Agent。三轮各1001样本，正文 P95 57.9/57.7/58.2ms；输入自动化 P95 24.90/26.47/28.40ms；完成长任务63/62/63ms，末尾挂载11张工具。汇总 optimization-virtual-focus-summary.json，构建 manifest optimization-virtual-focus-build.json。第三轮短暂并行运行浏览器正确性探查；未作机器负载隔离。此构建早于后续原生异步读取，不能充当最终发布验收。stopMs98/100/102ms为完整按钮恢复指标，不代替进程树退出专项时序。
- `readJsonlPageAsync` 保留完整 UTF-8 记录及不完整尾行游标、8MiB 单记录限制。Controller 原生交接日志大小读取和终端关闭/主动同步回流改用异步 I/O；同步 API 仅保留兼容调用。公开投影与原格式/ID一致，拒绝日志链接路径，不把磁盘读取错误当作空日志。日志文件替换/截断 identity 与 Agent 日志异步化仍待完成。
- 最新完整回归 optimization-native-async-tests.txt **104/104**。新增复制测试初次使用不存在的 stopGeneration，改为实际 abortTurn 后通过；额外浏览器 resize 探查初次 pre 匹配两个元素，明确选择输出 pre 后通过。失败与复跑均保留。

当前仍未打包/安装优化版本，2.2.0 保持；完整计划中存储积压/活动原文 spool、缓存预算、锁/日志身份、命令元数据/诊断、真实 TUI 回流、资源长测、同配置三路径对照、安装窗口及发布待完成。不追加 AGENTS 已发布记录，不标记目标完成。


## 慢盘检查点合并与活动工具原文释放（仍未发布）

- Repository 为每会话合并尚未开始的完整检查点，按消息文件/工具文件保留最新版本并保留不同 dirty 消息。开始写入即从合并入口移出，后续更新进入独立批次；metadata/config 提交封闭前一合并入口，保留原队列顺序。已编码的消息正文仅序列化一次写入，不再磁盘写入前重复序列化。
- 暂停磁盘写入后连续100次正文/Unicode工具输出更新的回归：一条 in-flight 消息写入＋最新两条不同消息写入，工具原文仅最新一份；还原后正文99及完整原文99均正确。见 optimization-coalesced-slow-disk-tests.txt；合并降低过时快照积压，但尚未实现全局字节预算/输入背压，不声称任意慢盘负载已被硬性限制。
- 活动轮次的工具原文在成功检查点提交后保存于独立tools文件。Repository与执行器都只保留2048字符预览，WeakMap区分已落盘预览，后续检查点不能以预览覆盖完整原文；活动详情改为读取完整异步页。更新工具输出取消已存预览标记，重新提交新版本。每会话持久化通知绑定session/message/step，旧通知仅在原文仍相等时释放执行器输出；dispose取消监听。
- 真实 Controller/POSIX 模拟 CLI 回归覆盖运行中释放、40万字节Unicode工具分页完整复原、重复检查点原文不缩短、新输出重新保存、暂停旧工具写入后新输出抵达、旧写入完成通知不能截断新版本、停止后完整保存。失败提交仍保留原文供重试。旧测试的“运行时保留全部原文”断言改为本计划要求的运行时释放，并增强磁盘全文/失败保留验证；初次失败日志保留 optimization-active-tool-spool-tests.txt。
- 最新完整回归 optimization-spool-final-tests.txt **106/106**；补充竞态/存储子集 optimization-spool-race-tests.txt **26/26**。无真实用户历史或任务操作。
- 同当前构建扩大回放 optimization-active-tool-spool-performance.json：百万字Markdown、10000工具/80MB原文、1001文字样本，P95 **56.3ms**，输入自动化P95 **28.17ms**，完成长任务 **63ms**，完整按钮恢复 **101ms**，末尾工具挂载11。固定关键构建哈希 optimization-active-tool-spool-build.json。本次单轮探查，中途短暂运行竞态测试，无负载隔离；不替代最终三轮矩阵、进程树退出时序、资源长测或真实CLI耗时比较。

下一步继续全局积压字节/背压、缓存预算、日志与锁身份；完整计划其余真实回流、长测、三路径对照及发布验收仍未完成。安装版保持2.2.0，不更新AGENTS为已发布，不标记目标完成。


## 写入字节计量与 CLI 输出背压（仍未发布）

- `conversation/writeBudget.ts` 以保留字符串的UTF-16长度估算队列payload，包含正在写入的检查点和metadata。Map按owner更新估算值，合并版本替换旧计量；成功/失败/锁获取异常均在finally释放。工具输出与trim引用保守重复计入，不把该值称为实际堆大小或精确磁盘字节。
- 默认高水位64MiB暂停、低水位16MiB恢复，带滞回；阈值测试可注入。`writeQueueStats`报告当前/峰值估算、批次数、阈值、暂停及失败会话数。每次队列变化不输出消息/逐字符IPC，只有阈值或失败来源状态改变通知执行器。
- `AgyProcessManager`持有当前readline读取器。初始化先接受init，再应用暂停；正常运行暂停stdout读取，管道自然向CLI传递背压。恢复读取保留原字节；停止先关闭读取器并丢弃已被generation fence隔离的旧输出，避免暂停流阻止stdio关闭；暂停期间停止和新进程重启均通过真实POSIX模拟CLI验证。
- 保存失败的会话保持暂停直到同会话完整检查点成功提交或明确删除；metadata成功不能证明未保存工具原文已恢复。该失败只影响来源会话，全局预算超限影响所有执行器。预算全局状态变化时强制通知，即使另一失败会话仍保持暂停，也能让无故障会话正确暂停/恢复。periodic checkpoint仍能重试，失败原文保留；dispose取消压力监听。
- 最新完整回归 optimization-write-budget-scope-tests.txt **109/109**。覆盖owner替换/释放/滞回、慢盘100次合并预算归零、压力期间初始化/无损续读/停止/重启、Controller接收到背压与排空恢复、磁盘失败保持原文及来源暂停、metadata不足以恢复、独立失败会话与全局阈值组合。未操作用户真实CLI任务或窗口。
- 当前固定构建单轮百万字Markdown/10000工具/80MB原文持续回放 optimization-write-budget-performance.json：1001文字样本，P95 **59.5ms**，输入自动化P95 **25.61ms**，完成长任务 **71ms**，完整按钮恢复 **124ms**，末尾挂载11张工具，errors为空。构建manifest optimization-write-budget-build.json。模拟负载直接emit工具事件，不经过CLI stdout流控，因此该回放证明新增计量不明显破坏渲染，不能证明高负载真实CLI背压硬上限。脚本已补充writeQueue字段，后续复跑会记录；本次报告在此字段增加前生成。
- 背压是软阈值：一个已读的大事件、readline当前chunk、多个窗口/CLI自身内存均可能越过阈值；不声称64MiB是进程RSS/堆硬上限。无globalStorage的兼容路径不采用此磁盘队列计量。长期资源趋势、实际快/慢盘全链路、满盘持续故障及最终三轮矩阵仍需验收。

下一步继续缓存按数量/字节预算、Agent/原生日志身份与锁恢复；完整计划所有剩余真实窗口/长测/CLI对照/发布项保留。安装仍2.2.0，未更新AGENTS为发布记录，不标记目标完成。


## 原生交接日志身份与完整行游标（仍未发布，2026-10-03）

- `NativeLogCursor`持久化offset、observedSize、device/inode/birthtime身份及游标头/尾各至多256字节的SHA256。Controller交接保存该身份；主动同步/终端关闭回流在读取前后检查原游标身份与边界，成功才更新双格式cursor/offset。文件替换、缩短、边界改写或建立后消失会报错并保留原历史/游标，不把它当作空日志或从旧偏移读取新文件。终端回流错误现在包含明确失败原因。
- 初始交接从尾部异步扫描最后newline，最多8MiB，避免size落在不完整UTF-8/JSONL记录中间；后续补完的记录可完整导入。已验证公开记录投影与原消息ID格式保留。同步兼容API继续存在，生产Controller改用带identity的异步API。
- 旧版本只有数字offset的记录首次同步沿用原offset并建立当前身份基线，无法追溯证明该次同步前日志是否已替换；不会声称旧记录自动拥有过去的身份保证。头尾指纹采样不能证明文件中间任意字节未被同inode等长改写；针对通常append/replace/truncate日志行为，未加全文重复哈希或常驻监控。
- 新增真实临时日志测试：UTF-8跨分片、不完整尾行不推进、补完后导入一次、重复同步不重复、不同inode替换、原inode截断/边界改写、建立前不存在可创建、建立后消失拒绝、游标offset不一致拒绝。Controller→Repository持久化/重启后身份仍在，追加正常导入，替换失败保留已有两条历史及原游标。全部只用独立测试CLI ID/临时存储，不操作用户日志。
- 首次专项测试暴露async try/finally提前关闭FileHandle（cursorFor未await），已修复为等待完整身份/指纹读取后close；失败日志 optimization-native-cursor-regression-tests.txt保留。最新完整回归 optimization-native-cursor-controller-tests.txt **113/113**，构建manifest optimization-native-cursor-build.json。未重跑性能矩阵，本变更仅原生交接/主动回流按需I/O，不增加正常流模型请求。

执行/写入锁目前仍是PID/token文件，身份与原子锁属主加强尚未实现；已检查迁移目录lease可复用的bootID/starttime依据，下一步继续锁模块及Agent日志。缓存预算、真实TUI新轮次回流、长测、三路径对照与安装发布仍保留。安装版仍2.2.0，未追加AGENTS发布记录，不标记目标完成。


## 执行锁进程身份与原子属主（仍未发布，2026-10-03）

- 新增 `conversation/executionLease.ts`，沿用原 `.lock` 路径但原子发布已包含 owner.json 的目录；记录 PID/token 与 Linux boot ID/start time，区分 PID 重用。仍是短小同步锁操作，不宣称所有 Host I/O 已异步。
- 新格式失效锁按原 token 重命名并保留非空归档。同一旧属主的迟到观察者不能把新锁覆盖到该归档；发布候选在成功/失败后清理。正常活跃属主释放先校验 token，再移到自己独立释放路径清理；重复释放无效。Repository 的每个引用释放函数均幂等，避免重复调用提早释放其他引用。迁移锁同步补充 token 校验/幂等释放。
- 老版本文件锁不能通过“检查 PID 后 unlink”安全回收：旧宿主不参与新协议，检查与删除之间可能出现新属主。新实现保留旧文件并报出旧版锁原因；活跃旧窗口完成释放后可正常获取新目录锁，死属主遗留文件需在相关旧宿主全部退出后离线核对并归档。本次未操作真实旧锁或停止用户任务。这是明确的混用版本升级限制，不能声称旧格式自动恢复已完成。
- 五项专项测试覆盖完整 owner 发布、活跃排他、PID 重用恢复、旧归档防覆盖、替换属主后旧释放不得删除、新旧损坏锁保留、Repository 嵌套引用/重复释放。真实子进程先持锁后 SIGKILL，再由四个独立进程同时争抢：只有一位获锁，三位拒绝，后续释放可重获。测试全部只使用临时目录/自身子进程。
- 首次完整回归 **117/117**；补上多进程后专项 **5/5**。迁移释放修改的首次完整构建发现局部变量 released 重名，改为 retired 后最终完整回归 **118/118**，见 `optimization-execution-lock-final-rerun-tests.txt`；失败构建 `optimization-execution-lock-final-tests.txt` 保留。构建哈希见 `optimization-execution-lock-build.json`。未重测性能或真实终端重载，尚不声称跨宿主外部终端接管完成。

下一步仍需 Agent 日志异步化/身份、缓存预算、命令元数据/诊断、真实 TUI 新轮次回流、资源长测、固定最终矩阵及同配置 CLI 对照、打包安装窗口验收。安装版保持2.2.0，未追加AGENTS发布条目，目标保持进行中。


## 子代理异步日志与监听属主（仍未发布，2026-10-03）

- `AgentRegistry.detailAsync` 串行处理同一子代理的按需读取。生产 Provider 等待读取结果，Controller 捕获 registry/session 并在返回时核对来源/未释放状态；异步路径解析、O_NOFOLLOW 打开、完整 JSONL 页读取及文件身份核对均不执行 Host 同步磁盘读取。同步 detail 仅保留兼容，公开投影共用同一函数。
- 新增共享 `logCursor.ts`，原生回流与子代理页复用已验证的文件身份、长度、完整行边界头尾指纹。子代理 offset 0 表示用户重新打开并建立新基线，后续 offset 必须对应已成功页的 cursor；失败不推进。替换、截断、边界改写、日志消失均报错。读取后再次核对路径指向的 dev/inode/birthtime，防止读取期间 rename 后仍从旧句柄导入；原生回流同步补充此核对。
- Agent watcher 路径解析异步化，使用 epoch、logUri 和 pending key 防止隐藏/释放后迟到解析重新挂上 watcher，日志来源变更会关闭旧监听。只在面板开启/原生事件/显式刷新建立监听，无新轮询/模型请求。监听故障保留按需重试；尚未实现跨日志递归发现或可靠原生 lifecycle/token。
- 首轮完整回归117/118，旧 debounce 测试在异步 watcher 尚未就绪就写入导致失败；改为等待 watcher 实际建立后验证取消/重开，而不是增加固定启动等待。失败保留 optimization-agent-async-tests.txt。
- 新增六项回归覆盖 UTF-8 emoji 中间不完整记录补完、只投影公开内容、异步路径无需 realpathSync、替换/截断/等长改写失败保留 cursor、重新打开建立新基线、来源路径拒绝/消失、隐藏期间迟到监听取消、dispose不通知、子代理及原生路径在读取期间替换不得提交。最新完整回归 **124/124**，`optimization-agent-identity-module-tests.txt`；模块提取前124/124见 optimization-agent-identity-final-tests.txt。构建manifest optimization-agent-identity-build.json。
- 校验仍为有限头尾指纹，不证明任意中间字节未等长修改；检查完成后仍可能发生下一次文件变更，后续页继续校验。游标为当前 registry 按代理保存，重新打开offset0明确重建基线，未宣称跨宿主子代理页持续接管。未重跑最终性能矩阵/真实安装窗口。

下一步继续缓存数量/字节预算、命令元数据/诊断、真实TUI新增轮次回流、资源长测、固定最终矩阵/同配置CLI对照及发布安装验收。当前安装仍2.2.0，未修改用户窗口/任务/设置/GUI，完整目标仍进行中。


## 有界指纹去重缓存（仍未发布，2026-10-03）

- 新增 `conversation/fingerprintCache.ts`。消息/工具去重不再通过Map保留整个JSON/工具原文，保存SHA256指纹、key和估算长度。默认消息4096条/2MiB、工具2048条/1MiB，LRU同时按数量与UTF-16 key/digest字节估算淘汰；超预算的单key不缓存。估算不包含JS对象/Map开销，不把该值称为堆/RSS硬限制。
- 指纹仅是去重提示；淘汰最多造成之后候选多写一次，源消息、独立工具文件、失败重试数据及队列预算不依赖该缓存。每候选计算一次哈希，已落盘工具预览先短路，不哈希/覆盖完整原文。读取分页也只缓存指纹；cacheStats报告条数/估算字节/淘汰数及loaded/fileList数量。
- 会话缓存key增加NUL分隔，释放a不再匹配ab的去重提示。release/delete/storageFailure沿用清理路径，clear会恢复估算为0。旧同步兼容路径也采用同一指纹类。
- 最新完整回归 **128/128**，见 optimization-fingerprint-cache-final-tests.txt。新增数量/字节双预算、LRU、超大key/禁用缓存、内部不含原文、低预算连续10条大正文/Unicode工具输出再保存及恢复全文、会话前缀隔离验证。失败/原文spool/慢盘合并/背压等原有回归继续通过。浏览器回放后发现未提交工具在LRU淘汰时重复入队，后续修复与复跑见下文；128/128不足以证明原实现正确。

本步只限制去重提示，不宣称活动正文、所有历史页、元数据或执行器已拥有完整字节上限。非选中已保存正文继续按原Coordinator路径释放；缓存页预算、订阅预算、长期资源趋势和完整计划其他验收/发布仍待完成。安装保持2.2.0，未改用户窗口或任务，目标保持进行中。


### 去重淘汰与未提交原文的交叉验证

- 第一轮固定构建回放百万字Markdown、10000工具/80MB原文、1001文字样本：P95 59.7ms、输入24.61ms、完成长任务72ms、完整按钮恢复153ms，但写入估算峰值1,965,739,044字节，Host结束RSS928,321,536/heapUsed678,776,544。虽渲染门槛通过，资源表现不合格，不以此验收缓存优化完成。原始记录 optimization-fingerprint-cache-performance.json保留。
- 必要持久化状态与可淘汰提示分离：pendingToolFingerprints按session/message/step记录未提交SHA256，不保留原文；普通LRU淘汰不能重复排队相同pending版本。按稳定key而非工具对象保存，因为Controller检查点会重建工具对象。成功提交匹配版本才删除pending；旧提交不得删除新版本标记，保存失败清理指纹让原文正常重试，释放/删除按精确会话前缀清理。该Map是与未完成写入关联的必要账本，数量随pending工具数变化，不宣称受可淘汰LRU上限约束。
- 新增低预算慢盘测试：暂停第一份工具写入，10份Unicode原文、100次重建工具对象的完整检查点；后续合并批次工具写入为0，恢复只写原10份，磁盘分页全文完整。全部原有失败/更新竞态/背压回归继续通过。最新完整 **129/129**：optimization-fingerprint-pending-reconstructed-tests.txt。
- 第二轮同场景回放：P95 **55.8ms**、输入 **29.74ms**、完成长任务 **67ms**、完整按钮恢复 **108ms**、errors为空；写入队列结束0，pending账本0，消息指纹8条/2208估算字节，工具指纹0条，末尾11张挂载卡片。记录 optimization-fingerprint-pending-performance.json；manifest optimization-fingerprint-pending-build.json。该单轮不替代最终三轮矩阵或独立进程树停止测量。
- 第二轮队列估算峰值仍1,106,731,446字节，Host结束RSS705,449,984/heapUsed192,221,744，不能声称已满足长期资源目标。此合成负载直接emit工具而绕过stdout背压；计量还保守重复计同一字符串引用。数字不能直接等同堆大小，但仍需真实背压负载/慢盘资源曲线、正文序列化/工具revision增量、缓存页预算和长测继续解释/改善。未掩盖首轮坏结果，不以P95通过替代资源验收。

安装保持2.2.0，无本轮发布/用户窗口操作；完整计划目标仍进行中。


## 草稿与检查点合并、预览引用释放（仍未发布，2026-10-03）

- 排查合成资源峰值发现 saveDraft→saveMetadata 会封闭未开始检查点合并入口，频繁输入在慢盘时留下多批全文/工具预览快照。新增 saveDraftMetadata：有待写检查点时仅更新该批raw里的draft/attachment，保留原批execution/config字段；无待写批次沿用metadata保存。显式配置saveMetadata继续封闭边界，不以草稿合并覆盖此前配置。
- 已落盘的工具预览不再进入trimCandidates，不反复保留预览/发送成功裁剪通知。原文及新输出仍按已有完整提交路径处理，失败保留与版本匹配不变。写入预算计算集中到accountCheckpoint，两种更新沿用相同保守payload计量。
- 检查点消息write只保留name/text/messageId/status，不再同时保留序列化前的整份m对象（含所有toolCalls/预览slice/参数）；工具write只保留file/output，trim只保存必要tool/output/messageId，不再通过message对象拖住整条历史。事件ndjson和持久化通知继续使用捕获的ID/status。
- 新增三项验证：暂停第一份消息写入后正文/草稿各连续100次，只有in-flight和最新pending两批，实际消息写两次，恢复最新正文/草稿正确；草稿仅更新draft不能顺带提交未配置的model；显式配置形成前后两批并恢复最新config；已落盘Unicode工具原文在正文更新时trims/tools均0、无重复裁剪通知、原文分页完整。加强断言确认待写消息不含m对象。
- 最新完整 **132/132**，optimization-checkpoint-retention-final-tests.txt；编译及此前完整结果 optimization-checkpoint-retention-tests.txt，初步draft/preview结果 optimization-draft-preview-final-tests.txt。
- 去除草稿边界及重复预览trim后的单轮回放 optimization-draft-preview-performance.json：百万字Markdown/10000工具/80MB原文/1001样本，P95 **60.6ms**、输入 **27.26ms**、完成长任务 **74ms**、按钮恢复 **116ms**。队列估算峰值 **571,069,282**，结束0，pending指纹0；Host结束RSS656,666,624、heapUsed124,432,296。相较前轮1,106,731,446估算峰值有所减少，但不同短测/GC时点，不称为RSS硬上限/长期收益证明。去掉m对象后的复测结果见下文，不以单轮内存结束值证明改造收益。

活动正文/历史页/订阅预算、真实stdout压力/慢盘/满盘、长期资源趋势、真实TUI新增轮次回流、命令诊断、最终三轮矩阵/CLI对照和发布验收仍未完成。安装保持2.2.0，未操作用户窗口/设置/任务，目标仍进行中。


### 去除多余对象快照后的复测

- optimization-checkpoint-retention-performance.json：相同百万字Markdown/10000工具/80MB原文、1001样本，P95 **47ms**、输入 **27.09ms**、完成长任务 **71ms**、完整按钮恢复 **110ms**，errors为空；队列估算峰值 **572,657,934**、结束0，pending工具指纹0。manifest optimization-checkpoint-retention-build.json。
- Host结束RSS **1,026,838,528**、heapUsed **762,507,960**，高于前轮，未达到资源验收结论；两轮都未控制GC/测量存活对象。源码/回归证明移除不必要强引用，但不能把它等同长期内存下降。保留完整高值，不用P95改善掩盖内存问题。下一步需要GC后存活堆/采样曲线与真实背压负载、长测区分未回收垃圾/持续保留，另继续历史缓存预算。
- 当前所有性能回放仍是合成直发工具事件，不受CLI stdout背压控制，当前peak软预算不能当作64MiB硬上限；不能据此完成S2或发布完整目标。安装仍2.2.0。


## GC后存活资源测量与工具预览预算（仍未发布，2026-10-03）

- sustained脚本新增可选 `AGY_BENCHMARK_RESOURCES=1` 模式，要求node --expose-gc；500ms采样Host memory/writeQueue，仅在正文/输入/完成/滚动测量后诊断性强制GC，读取Chromium Runtime heap并GC，记录当前完成测试历史释放后及自己的背景任务dispose后存活堆。生产扩展没有强制GC或新增采样。
- 原构建测量 optimization-resource-gc-performance.json：百万字Markdown/10000工具/80MB原文/1001样本，P95 **59.9ms**、输入 **26.54ms**、完成长任务 **68ms**、按钮恢复 **113ms**；93次Host样本，峰值heapUsed **775,955,752**、RSS **1,012,957,184**。HostGC后heapUsed **71,642,976**，释放已完成历史后 **67,854,824**，dispose自己背景任务并释放全部测试历史后 **66,934,544**；Webview usedSizeGC前57,640,136/后 **9,135,788**。测试缓存/文件列表/pending指纹释放后0。manifest optimization-resource-gc-build.json。
- 这次证据支持大量峰值为短期垃圾分配，而非全部存活对象；不证明不存在长期泄漏。GC后RSS仍约617MB，不能把heap下降说成已把内存归还OS。第一版资源模式report缓存/队列及CPU/elapsed取在diagnostic teardown后，不能和原性能路径同口径比较；样本曲线及标注的GC阶段数据有效。脚本已改为在诊断前捕获原queue/caches/CPU/elapsed，诊断释放状态单独报告。
- 新增toolPreview.ts：每条消息全部工具的输出预览预算2MiB（UTF-16字符*2估算），单工具最多2048字符。多工具时按数量公平缩短，10000工具每条上限104字符；避免半个surrogate pair。完整独立原文仍正常保存/异步分页，点击展开获取原文。失败时仍保留原始输出不裁剪。Repository的磁盘消息预览/成功提交裁剪与Controller持久化确认后的活动输出、快照预览使用同一逻辑。
- 不将2MiB称为全历史/对象/参数/IPC硬预算：这是单消息工具输出预览预算，正在流入的未保存原文、工具参数与已打开原文页另计。流式工具事件仍最多2048字符的实时预览，未增加同步轮询或模型请求。
- 新增预算/Unicode与600工具完整持久化回归：总预览估算≤2MiB，保存/恢复后首尾工具原文完整，重复保存不以缩短预览覆盖原文。完整 **134/134**，optimization-tool-preview-budget-final-tests.txt；此前132/132原有回归继续通过。新构建GC/资源回放已完成，结果见下文。

当前安装仍2.2.0，未操作用户窗口/任务/设置；缓存页/订阅预算、真实背压资源/长测、完整验收矩阵/TUI回流/CLI对照/发布等仍未完成。目标保持进行中。


### 工具预览预算构建资源复测

- optimization-tool-preview-resource-performance.json（manifest optimization-tool-preview-resource-build.json）：百万字Markdown/10000工具/80MB原文/1001样本，P95 **57.1ms**、输入 **24.64ms**、完成长任务 **72ms**、完整按钮恢复 **102ms**、errors为空。诊断前队列结束0、估算峰值 **493,931,350**，pending指纹0，消息提示8条/2208估算字节，工具提示0。
- 91次500ms采样：Host峰值heapUsed **610,202,312**、RSS **819,163,136**；HostGC后heapUsed **71,661,240**，完成历史释放后 **67,873,056**，测试任务teardown/全部测试历史释放后 **66,941,296**，WebviewGC后 usedSize **9,134,132**。释放后 loaded/fileList/指纹/pending均0。
- 单轮峰值低于前构建采样775,955,752/1,012,957,184，且显示门槛保持，但未控制GC时点/进行三轮稳定性比较，不能以差值宣称必然收益或完整S2验收。GC后RSS仍590MB左右，存活堆几乎相同，仍需长期趋势/真实stdout背压/慢盘与全缓存预算验收。直emit合成负载仍能软预算越界，峰值不等同生产硬上限。

目标继续进行；版本和安装仍2.2.0，真实窗口/任务/设置未改，未追加AGENTS发布完成条目。


## 真实管道背压与预览字符串保留修复（仍未发布，2026-10-03）

- 新增隔离pressure-agy.cjs：通过真实POSIX stdout输出JSONL，生产工具流逐write检查drain，不在子进程无视背压无限排队；独立cwd保存pid/写入进度。hang测试启动忽略SIGINT/SIGTERM的工具子进程，并确认ready后才开始停止验证。所有进程/记录都属于本次测试，不访问用户CLI会话/配置/API。
- Repository→Controller→真实CLI.stdout链路两项新增回归：512KiB/128KiB测试预算下，门限触发后扩展接收及CLI写入进度稳定，恢复后300份Unicode原文全部分页逐字验证，队列归零；暂停且磁盘未释放时停止，CLI及工具子进程都已退出，再释放磁盘完成已停止内容保存。最新完整137/137见 optimization-preview-retention-final-tests.txt，编译及前136/136见 optimization-preview-copy-full-tests.txt；管道初版2/2/完整136/136记录保留。低门限完整测试一次观测停收10条、生产者14条，工具/CLI树退出3.24ms（单样本，不是P95/硬保证）。
- scripts/benchmark-real-pipe.cjs改用生产Repository.open默认64MiB/16MiB预算，真实2000工具/163,560,000字节原文、100ms资源采样。慢盘gate触发暂停后验证扩展/producer均停止，恢复每一份全文，记录队列/压力变化/GC后存活堆。不是GUI/模型性能，也不是2h验收。
- 首轮真实日志GC后heapUsed176,018,720、释放后175,940,536，暴露V8 slice预览仍保留大JSONL字符串问题。原始记录 optimization-real-pipe-resource-before-preview-copy.json/txt保留。首次stress fixture结果文案仍写300，实际循环/验证为2000；已修正文案按count，未用该文案计算条数。
- toolPreview现在用UTF-16 Buffer encode/decode生成独立小字符串，避免短预览引用整份解析日志；保留UTF-16 code units，不因复制改变内容。仅在需要预览时做本地复制，完整原文和已有大小预算不变。新增独立--expose-gc子进程回归：30份各1,000,008字符的Unicode源，只保留≤128字符预览，GC后heap差27,552字节，低于4MiB验证限值，确认小预览不拖住约60MB源文本。
- 同配置真实管道复跑 optimization-real-pipe-resource.json：2000份/163.56MB全文完整；暂停时扩展420条、producer423条，恢复后2000条、队列0，估算峰值98,668,660（门限是软预算/保守重复引用计量，非64MiB硬cap）。Host采样峰值heapUsed182,182,968/RSS415,633,408；GC后heapUsed **11,888,160**，释放后 **11,830,176**。首轮采样峰值heapUsed296,068,432/RSS474,423,296，两个短测不是长期RSS承诺；原文逐字验证证明缩小预览没有截断保存。
- 固定后构建及脚本sha见 optimization-preview-copy-build.json。百万字/10000工具浏览器回放已完成，结果见下文。

真实管道背压的暂停/恢复/停止已获证据；单样本资源不能替代慢盘/满盘矩阵、缓存页/订阅预算、2h持续趋势及最终固定三轮性能/真实TUI回流/同配置CLI对照/安装发布。安装保持2.2.0，目标仍进行中，未操作用户窗口/任务/设置。


### 独立预览复制后的浏览器回放

- optimization-preview-copy-browser-performance.json：百万字Markdown/10000工具/80MB原文/1001可见文字样本，P95 **60.3ms**、输入 **27.67ms**、完成长任务 **76ms**、完整按钮恢复 **124ms**、errors为空；队列结束0，保守估算峰值493,931,350。显示/输入/完整文字/选择/向上滚动断言通过。
- 500ms采样Host峰值heapUsed605,870,728、RSS814,403,584；GC后heapUsed71,675,152、历史释放后67,886,992、teardown后66,953,488，WebviewGC后usedSize9,135,760。合成ASCII工具输出未呈现真实Unicode JSONL那种大源字符串保留，因此不把真实管道176MB→11.9MB收益套用到本场景；短期分配峰值仍需后续优化/长期验证。
- 当前单轮资源/渲染门槛通过，不替代最终三个重复构建矩阵/2h趋势/真实安装窗口/CLI对照。原生CLI本身如何管理stdout内部缓冲仍非本模拟producer证据；本次证明扩展reader管道背压与损失/停止行为。

完整目标继续进行，未发布，安装版2.2.0不变。

## 会话正文缓存预算与并发淘汰（仍未发布，2026-10-03）

- 新增transcriptBudget.ts，默认最多4份已加载会话、32MiB正文/工具对象/文件列表payload估算。按实际访问顺序LRU淘汰；计量字符串/键UTF-16字节及标量，循环/共享对象只遍历一次，重复字符串仍计量。此值不是heap/RSS上限，不包括保留的会话元数据、Webview页面或活动CLI。
- Coordinator使用预算淘汰替代立即清空所有非选中历史，保留少量最近历史以便暖切换。选中、正在运行、排队操作和原生终端交接会话受动态保护；预算不足时如实显示overBudget，不清空活动任务。失败写入源保留；删除/释放清理访问记录，未知ID查找不增加recency。
- 淘汰先等待提交，再复核保护。发现并发请求原先只共用Promise而忽略最新guard/预算，已改为最新策略及revision；正在等待的release也核对最新guard，策略变化重新扫描。成功后全部共用调用才完成；不增加常驻定时器或模型调用。此预算是可回收缓存的软预算，受保护数据可超限，扫描期间新加载/变化的payload仍可能在下一次触发才重新核对。
- 新增7项回归：数量LRU/逐字恢复、字节上限/保护超额、磁盘等待期间切换、满盘失败/重试、循环估算与未知ID、并发静态guard/预算替换、Coordinator预算0保护真实模拟运行背景及openNativeCli交接状态。完整144/144：optimization-transcript-protection-final-tests.txt；此前142/142及143/143结果保留。
- 同构建百万字Markdown/10000工具/80MB原文/1001可见样本/20000工具替换单轮复测optimization-transcript-budget-performance.json（哈希optimization-transcript-budget-build.json）：正文P95 60.6ms，输入自动化P95 30.17ms，完成长任务62ms，按钮恢复97ms，errors空，选择/向上滚动通过。缓存4份/7,939,078估算字节，无超额；队列结束0、峰值492,653,414估算字节，合成emit负载仍绕过stdout背压。
- 90次500ms资源采样：Host峰值heapUsed573,818,896/RSS798,281,728；GC后heapUsed71,738,464、释放已完成历史后67,950,728；WebviewGC后usedSize9,124,688。短测不能作为2h稳定性/生产硬内存上限，当前仍有短期分配峰值，需要完整长期/故障矩阵。

安装保持2.2.0，未操作用户窗口/任务/设置。命令草稿、历史页面/订阅预算、资源长测、最终固定构建矩阵、真实终端回流及发布验收继续推进。

## 安全命令草稿恢复与成功后清理（仍未发布，2026-10-03）

- registry新增persistentDraft策略：普通文字/转义文字、已知侧栏非管理命令可保存；原生、MCP/插件、技能、未知或引号未闭合命令不写磁盘。new/stop等瞬时命令也不恢复，避免反复触发。Controller在执行层强制此过滤，Webview自动保存所有输入经此入口；敏感命令留在当前输入框，落盘草稿置空而不覆盖附件。未通过记录输入正文进行诊断。
- 安全命令执行失败保持原草稿，切换历史后恢复；成功的本地命令在UI清空后再清理持久化草稿，保留附件。模型轮次沿用执行层已有清理，不额外添加一次保存。成功后保存故障明确“命令已完成，草稿清理失败”，不误报命令执行失败或自动重试。
- 新增策略单测及真实React→Provider→Coordinator→Controller链路：失败effort切换恢复、help成功清理、不增加模型消息、MCP哨兵敏感值在当前UI可见但不在自己的全部持久化文件中、成功命令清理失败只执行一次且错误说明准确。
- 首次新增链路测试145/146：在空白会话按新建按约定不另建，测试错误等待不同ID；补充自己的已完成模拟轮次后复跑146/146。最后错误说明分支测试新增后完整147/147：optimization-command-drafts-cleanup-tests.txt；编译和此前146/146见optimization-command-drafts-final-tests.txt。初次失败保留，不更改空白会话行为迁就测试。

本策略不把任意正文里的敏感数据自动识别为凭据；普通正文/Plan需求仍按用户聊天草稿保存。未知命令保留当前输入但不跨重建持久化。当前已安全支持的命令草稿可恢复，完整参数schema/能力条件/管理后缓存失效仍待实现。安装2.2.0保持；后续完整验收及发布目标未完成。

### 命令草稿改动后的固定构建复测

optimization-command-drafts-performance.json（构建哈希optimization-command-drafts-build.json）：百万字Markdown、10000工具/80MB、3后台/20Agent、20000工具更新、1001正文样本，正文P95 **61.9ms**，输入自动化P95 **27.94ms**，完成长任务 **71ms**，按钮恢复 **109ms**，errors空，完整文字/选择/向上滚动断言通过。缓存4份/7,931,398估算字节、overBudget false，队列结束0、pending指纹0；直emit合成负载估算峰值492,972,890，不是stdout生产硬上限。单轮验证此次草稿改动未破坏显示门槛；尚非最终三轮/全部场景/真实安装或长期资源验收。

## 命令规则集中与管理查询缓存预算（仍未发布，2026-10-03）

- CommandSpec新增参数schema（min/max、枚举值、管理子命令forms及名称规则）、可能副作用、能力来源及草稿策略。每个内置命令均有这些元数据，别名引用同一spec。Provider在进入执行分支前统一validateCommand，移除分散exact/枚举/管理语法校验；动态模型/Agent是否存在、Plan权限及工作区/文件事实等仍由执行器/对应服务复核。
- 帮助和补全使用同一commandDescription，展示需当前对话空闲/运行中可用及实验来源。无效skills参数在清缓存之前拒绝，无效MCP/插件参数在subprocess/终端之前拒绝，Plan技能前置拒绝。注册表的capability是实现来源/实验声明，尚不是按本机CLI版本探测后的能力授权，不能据此声称未知版本安全兼容。
- 新增metadata/别名/有效无效参数/忙闲/Plan单测及真实Provider链路无副作用验证。第一次148/149暴露插件名称--all仍可作为CLI选项；具名MCP/插件操作也拒绝旗标后149/149。原失败optimization-command-schema-final-tests.txt保留，最终schema结果optimization-command-schema-rerun-tests.txt。
- NativeManagementAdapter使用PayloadCache：查询缓存64项/2MiB、技能32目录/4MiB，LRU及payload估算（包含键与文字）可观察，超大单项不缓存，清理释放引用。保留60s查询TTL，不新增固定轮询或额外模型/版本请求。
- 管理查询key包含实际解析后的启动文件realpath/dev/ino/size/mtime/ctime、cwd、参数及cacheEpoch。clear后旧pending不能重新填入缓存，清理后的请求也不复用旧pending；正常同key仍去重。非cached管理操作成功或失败都失效缓存，防止CLI已部分改动配置而返回失败时继续使用旧发现数据。空输出使用同一“操作完成”结果，缓存前后行为一致。
- 新增PayloadCache预算/访问/清理回归；真实隔离可执行CLI fixture：暂停第一次查询→clear→第二次查询→迟到第一次，第三次仍命中新结果且只启动两次；替换启动文件暖缓存失效；模拟失败管理操作清除已存结果。全部是本次fixture与临时目录，不调用用户接口/模型/会话。
- 最新编译及完整**151/151**：optimization-command-cache-complete-tests.txt，此前optimization-query-cache-final-tests.txt保留。本机agy是launcher，启动文件身份不等于其转发二进制/配置内容身份；转发目标更换但launcher未变仍依靠TTL/显式refresh，按真实版本缓存能力的完整实现仍待推进。pending调用受CLI20s timeout，不声称其数量被上述可淘汰缓存预算限制。

完整目标未完成，安装保持2.2.0。持续/隐藏资源、历史页预算、真实TUI新增轮次回流、能力版本探测、诊断导出、完整最终性能矩阵/CLI对照与发布继续保留。

命令规则/缓存构建的单轮百万字Markdown回放：optimization-command-schema-cache-performance.json，10000工具/80MB、20000替换、1001样本、3背景/20Agent，正文P95 **59ms**、输入自动化P95 **25.31ms**、完成长任务 **63ms**、按钮恢复 **99ms**，errors空。构建optimization-command-schema-cache-build.json。这发生在随后历史选项memo改动之前，不作为其验证或最终三轮矩阵。

## 万份历史列表渲染边界（仍未发布，2026-10-03）

- SessionOptions单独memo，只有会话列表引用变化才重新生成选项；正文/草稿/工具增量不再遍历并重建所有历史option。保留原下拉交互及全部历史，不通过截断历史数获得收益。
- 新增实际React链路10000历史getter探针：首次生成所有10001选项，编辑草稿不再读取任何历史标题，最后历史仍有真实选项可选择。首跑151/152被初始化迟到的真实Coordinator列表覆盖，保留optimization-history-options-tests.txt；待初始化列表发布结束后单项通过optimization-history-options-focused.txt，完整编译/回归**152/152**见optimization-history-options-final-tests.txt。
- sustained脚本增加可选AGY_SUSTAINED_HISTORIES，独立填充本次Repository内存元数据index、记录实际全部option可见时长。它用于生产列表/IPC/React负载，明确不代表磁盘启动恢复；磁盘10000记录Worker测量仍见此前独立证据。真实Chromium的10000历史/百万字/10000工具资源回放进行中。

当前仍未发布安装，全部范围继续保留；历史初始下拉DOM成本、列表状态变化/序列化成本和2h趋势仍需测量，memo不等于已经完成历史列表分页或全部资源预算。

### 万历史极端回放失败及列表传输修复（仍未发布）

- 首次10000历史/百万字/10000工具资源回放约68s以exit134终止，Node堆约2GB上限，FATAL ERROR heap out of memory；原记录optimization-history-extreme-performance.txt保留，没有完整JSON结果，不视为任何门槛通过。独立benchmark Host失败，不是用户扩展窗口崩溃。
- 原脚本abort未执行finally。仅通过本次AGY_BENCHMARK_OUTPUT唯一环境标记识别自己4个fake-agy进程224114/224144/224158/224172，按自身POSIX组TERM/KILL清理；未按进程名全局杀进程，未触碰用户CLI/窗口。此次Chromium已自行退出。
- Coordinator原先scheduleList每次直接发送全量sessionList。新增最后列表对比：仅可见标题/顺序/phase或currentId变化才发送；checkpoint更新时间单独变化且排序不变不发送。sendSnapshot强制完整列表用于重建/序列缺口恢复，其他更新仍携带真实状态。仍有每次扫描排序/对象构造成本，尚非真正差量/分页列表。
- 新增10000元数据/100次timestamp-only更新的Coordinator链路，IPC只有初次一条；标题变化发送，snapshot重复仍发送完整10001条。增强UI测试：真实列表改名仍更新，草稿保持。完整153/153：optimization-history-list-dedupe-tests.txt。
- 回放新增仅测试启用的半秒progress JSONL及消息类型计数，失败时保留资源曲线而不采正文/凭据。下一次极端复测optimization-history-extreme-rerun-performance.txt/json及samples.jsonl正在运行。采样至约37s显示sessionList20次，GC后自然采样heap约110MB；RSS仍约1GB。尚未完成、不能声明成功/长期内存受控或确定首轮全部根因。

### 列表去重极端复测仍未通过完成门槛

optimization-history-extreme-rerun-performance.json完整输出：10000历史/百万字/10000工具/80MB、1001正文样本，正文P95 **70.4ms**、输入自动化P95 **42.65ms**、完成长任务 **142ms**、按钮恢复 **423ms**、首次完整历史选项 **959.82ms**，errors空。复测不再OOM，采样峰值heapUsed901,275,128，GC后64,106,528；但completion<=100ms断言失败、exit1，不作为门槛通过。sessionList总22次，turnState2015/streamDelta1005/toolUpdates1334；计数用于分析，不冒充真实模型吞吐。构建哈希optimization-history-extreme-rerun-build.json。

- 后续ViewStore复用未变sessionList行及完整相同数组，每个SessionOption单独memo，仅改变的标题/phase/时间行重新渲染。全部历史仍保留；不是历史虚拟化/分页，初始10000option DOM成本仍存在。
- UI getter验证从“草稿不重建整表”扩大为“最后历史改名更新但其余9999行不重绘”，读取该行旧标题一次用于比较属必要读取。初次断言误把这一读取当额外渲染，152/153记录optimization-history-row-reuse-tests.txt保留，纠正断言后编译/完整**153/153**：optimization-history-row-reuse-final-tests.txt。
- 最新同极端场景复测optimization-history-row-reuse-performance.json/txt与samples.jsonl进行中。未追加发布AGENTS，当前安装2.2.0；完整资源/负载/故障/真实窗口/发布目标继续进行。

### 行复用后的极端结果及选择控件进一步隔离

optimization-history-row-reuse-performance.json：10000历史/百万字/10000工具资源复测，正文P95 **54.6ms**、输入自动化P95 **34.78ms**、完成长任务 **141ms**、按钮恢复 **397ms**、初始全部历史option **932.03ms**，errors空，GC后HostheapUsed64,119,352、采样峰值654,743,344。相较前次输入/正文有所改善且未OOM，但completion<=100ms仍失败(exit1)。不算完成门槛/发布通过。

React受控select更新路径在父App提交时仍遍历全部options；进一步将SessionSelect整体memo，并使用固定初始defaultValue及layoutEffect仅在实际value与currentId不一致时设置原生value。稳定callback通过runRef使用最新操作闭包，不忽略过时callback；disabled变化也复核真实选中值，以恢复切换失败后的选择。全部历史option保留，初始DOM仍需测量，不声称已实现列表虚拟化。新增失败切换恢复选项测试。当前最新完整回归/极端复测结果将在下一项记录；工作树尚未发布。

选择控件隔离编译及完整153项回归通过optimization-history-select-isolation-tests.txt，新增切换失败选项恢复后完整**154/154**：optimization-history-select-final-tests.txt。最新10000历史极端回放已启动，记录optimization-history-select-performance.json/txt及samples.jsonl，固定构建哈希optimization-history-select-build.json；尚未获得结果。安装2.2.0保持，完整计划未完成。

选择控件隔离后的极端复测仍失败：optimization-history-select-performance.json，正文P95 **67.3ms**、输入自动化P95 **34.26ms**、完成长任务 **141ms**、按钮恢复 **412ms**、首次全部历史option **867.24ms**，errors空。两条completion longtask分别约68ms与141ms，后者跨上述三次改造几乎不变，因此不能把全部完成延迟归因历史选项React渲染；此前去重/行复用/选择隔离保留其功能证据，但141ms根因仍未证实。

sustained新增仅按AGY_SUSTAINED_TRACE启用的完成阶段CDP timeline+CPU profile，开始于完成observer前，结束于completionTasks读取后；不在生产启用，不替代无trace三轮门槛。当前隔离trace复测输出optimization-history-completion-trace.json及optimization-history-trace-performance.json/txt进行中。154/154回归仍为当前源码编译结果，最新版benchmark trace脚本独立验证尚未结束。

## 完成阶段测量工具对照（仍未发布，2026-10-03）

- 首次完成trace+CPU profile（optimization-history-completion-trace.json，performance见optimization-history-trace-performance.json）显示扩展bundle FunctionCall约76.4ms，与79ms完成longtask对应；另129ms longtask尚无扩展栈对应。该次trace测量仍不合格，不以只看JS函数忽略longtask。
- 保持源码/bundle、10000历史/百万字/10000工具负载不变，只将按钮等待从Playwright waitForSelector替换为直接document.getElementById + 非空client rect、RAF轮询的对照：optimization-history-primitive-performance.json。1001正文样本P95 **67.7ms**、输入自动化P95 **41.85ms**、完成longtask **95ms**、按钮恢复 **252ms**、初始完整历史option **1049.81ms**，errors空，全部断言通过。仅一条95ms longtask，无第二个约129–141ms任务；trace（optimization-history-primitive-trace.json）扩展FunctionCall93.86ms，与page longtask一致。整个trace其他线程也有RunTask206.98ms，不把跨线程事件当Webview主线程longtask。
- 该对照支持旧按钮查询给页面增加测量负载，但单次trace不足以证明完整因果/稳定门槛。sustained改以直接DOM ID/可见rect作为默认按钮恢复测量，保留AGY_ACK_LEGACY=1复现旧方式；明确report字段buttonRecoveryMeasurement，旧stopMs不直接当成修复后的产品性能下降百分比。默认未开启trace/profile，生产代码没有移除正文或选项。
- 10000完整option首次创建仍约1s，不能视为初始历史加载性能已经解决；正文/输入/完成仍需无trace固定构建三次验证。完整2h资源、故障/原生回流/CLI对照/真实窗口/发布门槛继续保留；安装2.2.0未变。

## 最近历史与原生全量搜索入口（仍未发布，2026-10-03）

- 下拉框保留最近200条及不在最近列表里的当前会话（最多201个option）；其余记录通过“全部历史（数量）”打开VS Code原生可搜索QuickPick，全量ID/项目目录可搜索。/history search共用此入口，/history <ID>/sync兼容。没有截断或删除历史记录，仅将全量选择移到原生虚拟列表，普通轮次不创建原生picker或CLI。
- pickSession统一经过Bridge请求/回复去重、UI待操作状态及草稿保存。选择后用原选择ID检查会话是否已改变，迟到结果不能覆盖新会话；取消保留当前会话/草稿。背景任务不停止，旧会话选择后其选项加入下拉可见列表，模型/Plan/权限沿用原Controller恢复边界。
- 增强10000历史UI验证：只产生200最近项、完整数量入口仍可用、草稿不重绘、改名反映到可见项；新增真实React→Provider→Coordinator→模拟CLI原生picker替身验证：全10002条传给原生picker、旧条目可选、最多201项、旧草稿恢复/原草稿保存、正在运行背景继续、取消不切换、迟到返回不覆盖新会话。
- TypeScript/Webview编译及完整**156/156**：optimization-history-picker-final-tests.txt。nativeQuickPick的真实VS Code窗口搜索和可用性仍待最终安装窗口验收，不把替身当作人工验收。
- sustained的10000历史负载仍保留全部Repository元数据和Host公开列表，只将UI就绪判断改为最近列表>=200个真实option，report明确bounded recent list + native picker。三轮无trace固定构建极端资源回放进行中：optimization-history-recent-{1,2,3}.json/txt；构建哈希optimization-history-recent-build.json。按钮恢复用直接DOM/rect的RAF确认，旧Playwright等待原始失败保留。

当前安装保持2.2.0，所有优化未发布。完整2h趋势/隐藏/故障/CLI同配置对照/原生新增回流/最终安装和发布门槛仍未满足，目标继续执行。

### 原生历史入口固定重复门槛尚未通过

三轮执行在第一轮exit1停止，原结果optimization-history-recent-1.json/txt保留；没有第2/3轮数据，不算三轮通过。第一轮1001正文样本P95 **68.1ms**、输入自动化P95 **32.93ms**、初始最近列表就绪 **637.96ms**、按钮恢复 **213ms**，完成longtask **78ms及137ms**。虽默认直接DOM等待，第二个任务仍出现，此前单次trace/primitive对照不足以归因旧waitForSelector或保证测量工具已排除。初始时长包含实际bundle加载/ready/IPC，不等同仅200个option创建时间。

新增timeline-only诊断（CPU profiler仅AGY_TRACE_PROFILE=1开启）及agy-completion-window-start标记以对齐page longtask和trace；不调整100ms门槛、不筛掉未知任务。当前复测optimization-history-timeline-only-trace.json及performance.json/txt进行中。生产功能回归156/156保持，完整发布门槛继续未完成。


## 完成阶段 IPC 证据与计时校准（仍未发布，2026-10-03）

- timeline-only前次已结束exit1，optimization-history-timeline-only-performance.json中正文P95为-558.4ms，属于无效计时，不作为性能通过/改善证据。脚本原先Host Date.now与浏览器performance.timeOrigin+performance.now混用；墙钟调整可能破坏两者比较。最新回放改用Host单调epoch时间，并通过9次往返选最小RTT样本校准浏览器offset；报告原始样本/半RTT不确定度及结束校准漂移，任何负数/非有限延迟或漂移>5ms明确失败，生产日历/历史时间不变。
- 前次trace第二条174.928ms主线程RunTask内部Receive mojo message174.545ms，ThreadControllerImpl::RunTask源ipc/ipc_mojo_bootstrap.cc:Accept；其内部JS调用最大约0.933ms。支持IPC接收/反序列化假设，而非证明Markdown/React占用了第二条长任务。第一次81.155ms任务中bundle FunctionCall79.152ms。保留全部trace与无效测量，不删掉第二条任务或放宽门槛。
- Coordinator公开sessionList缩小为最近200+当前+运行/等待输入/拒绝记录，另外发送totalCount。完整Repository元数据、原生QuickPick及按ID切换均保留；大量活动/拒绝记录仍可能超出200，是保留状态的软预算。Webview原生select展示这些例外记录，完整历史按钮使用总数量。时间戳/标题/状态/总数量变化仍按现有去重语义发布；snapshot强制恢复投影。
- 新增10000记录链路验证：老当前会话、真实后台fakeCLI及历史拒绝记录保留，普通旧记录不传；总数变化即使投影不变也发布。原生picker现有链路仍验证全10002项、旧草稿和后台任务；下拉预期更新为200最近+旧当前+运行背景=202。初次156项回归失败因旧测试仍预期201，接着新增测试错误限定hang一定处于waiting（实际上启动期间也允许connecting/submitted），原输出optimization-history-ipc-tests.txt/optimization-history-ipc-final-tests.txt保留。修正为实际活动状态集合并核对isSessionRunning后，编译后完整**157/157**通过optimization-history-ipc-rerun-tests.txt。
- 校准后相同10000历史/百万Markdown/10000工具/80MB/20000替换的timeline回放运行中，optimization-history-bounded-ipc-performance.json/txt及trace；固定构建SHA256见optimization-history-bounded-ipc-build.sha256。尚未获得门槛结果，IPC假设待测量确认。

当前安装仍2.2.0，优化工作树未打包/安装。2h持续使用尚未启动；隐藏/空闲资源、故障、CLI三路径同配置、真实TUI新增回流、能力版本边界、脱敏诊断/模块收尾、最终矩阵/窗口/发布仍未完成。目标继续执行，不以157项测试或单次性能代替完整验收。


校准后首次同极端timeline回放已完成exit0：optimization-history-bounded-ipc-performance.json，1001有效样本，正文P95 **65.343ms**、最小38.811ms、输入自动化P95 **32.897ms**、完成longtask仅一条**90ms**、按钮恢复 **120.627ms**；errors空。最小RTT0.986ms、校准半RTT不确定度0.493ms、结束offset漂移-0.019ms。trace没有>100ms RunTask；此前第二条137–174ms IPC长任务本轮不再出现。支持缩小公开历史IPC修复此场景，但单轮trace不是最终稳定验收。

相同固定构建三轮无trace重复已启动optimization-history-bounded-ipc-repeat-{1,2,3}.json/txt，失败即停止，不改变bundle/源码，不将缺失轮次算通过。完整最终场景矩阵及2h资源仍未完成。


固定构建无trace三轮已全部exit0，optimization-history-bounded-ipc-repeat-{1,2,3}.json，汇总optimization-history-bounded-ipc-summary.json。每轮1001正文样本；P95 64.956/64.305/64.219ms，输入自动化P95 29.823/31.871/39.353ms，完成最长任务 71/77/71ms，按钮恢复 100.776/108.085/102.096ms；errors均空，校准漂移均<5ms。构建SHA256复核一致。此场景的第二条IPC卡顿未再出现，完整最终矩阵/真实窗口/资源2h等仍保留。补充ViewStore总数单独变化复用行及旧列表无totalCount兼容测试，完整回归复跑进行中。

最新完整回归**158/158**通过，diagnostics/optimization-history-ipc-total-count-tests.txt；本轮所有benchmark/测试进程均已结束，无2h soak正在运行。当前源码/已编译功能与固定三轮一致（只追加一项测试），仍未打包安装。


## 实际Provider资源持续测试（仍未发布，2026-10-03）

- 新增scripts/benchmark-soak.cjs与test/fixtures/soak-agy.cjs，经过实际Provider→Service→Coordinator→Controller→真实POSIX模拟CLI stdout，使用真实Chromium bundle；VS Code API为替身，明确不是已安装窗口验收，也无用户接口/模型调用。100份真实磁盘历史各10万字并独立保存完整工具原文，3个后台流及其自有工具子进程；使用实际Webview输入/新建/切换/发送，轮换历史、滚动、草稿并核对后台存活。
- 宿主采CPU/堆/RSS/句柄/FD，Chromium SystemInfo提供自己browser/renderer/GPU/network CPU与PID，按这些明确PID采RSS/FD；Performance.getMetrics采Webview堆/TaskDuration/DOM/listeners，记录IPC数量/字节、写队列、缓存、runner数量。仅本次fixture在临时工作区写自己的PID标记，按PID+start time识别，不全局扫描/杀同名进程。持续阶段每5秒采样，无测量期间强制GC；样本不证明瞬时峰值或硬内存上限。
- 初次smoke因测试脚本写错#new-btn而timeout退出，optimization-soak-smoke.txt/jsonl保留（未启动CLI）；修正到真实#new-session-btn并等待选择事务/按钮恢复，optimization-soak-smoke-rerun.json通过。
- 固定运行时改进：out/media/fixture复制至本次临时frozen-runtime，模块从副本加载，node_modules共享只读依赖；报告全部运行时文件、package-lock及脚本SHA256。后续源码改造不改变该次baseline，发布固定最终构建仍需要重新验收。optimization-soak-frozen-smoke.json通过：连续阶段约8.2s/4次历史轮次，1s可见空闲和1s隐藏活动探查；隐藏源继续、文字/工具IPC停止、草稿恢复、完整历史及工具读取通过，errors空，关闭后本次12个活跃fixture父/子PID均已退出。此短smoke不替代60s/2h验收。
- 2h baseline已启动，optimization-soak-2h-baseline.json/txt/jsonl。预计先完成60s可见空闲、60s隐藏活动，再连续7200000ms；尚未有最终结果，不能称长期资源通过。后续按本次明确进程/工具handle跟踪，不根据未变化日志重启。

完整目标仍未完成，安装保持2.2.0，未追加AGENTS发布声明或更改用户窗口/任务。真实CLI对照/TUI新增回流、故障/恢复/能力版本/诊断/维护收尾、固定最终矩阵与发布继续推进。

持续测试执行handle **46984**、Host PID **334203** 已复核/proc存在且工具返回running；最新样本阶段continuous、约132.7s。未完成结论，下一轮继续轮询相同handle/进程。


## CLI 路径/版本能力探测与保守降级（仍未发布，2026-10-03）

- 新增core/cliCapabilities.ts，独立只读 --version 探测，1500ms超时、8KiB输出预算，POSIX仅终止自己创建的探测进程组；输出仅接受完整版本字符串，任意/失败/过大输出不保留正文或凭据。当前已捕获证据只覆盖1.2.14；未知版本不声称Stream-JSON/只读Plan/原生技能/子代理可用。schema保持experimental、sandbox保持launch-only、逐工具approval=false。
- 路径/realpath/启动文件dev/ino/size/mtime/ctime/cwd/epoch缓存，上限32项/64KiB估算；同键并发共用探测。60秒TTL使用单调时钟，checkedAt仅为日历时间；刷新和管理操作清缓存，迟到探测或文件替换后重新探测并返回当前结果，旧成功版本不能授权新文件执行。未检测任意launcher内部转发目标内容，包装器未变仍靠TTL/refresh，不宣称零竞态身份保证。
- Controller仅在要启动Stream-JSON时探测；已有进程且配置未变直接复用，不每轮启动发现子进程。不可变ExecutionProfile保存本次capabilities，/workspace可看到CLI版本/协议状态和requested/effective model。启动里增加capability-check-start/end诊断里程碑，探测延迟不伪装为模型等待。
- 未验证版本阻止侧栏执行，保留输入；/capabilities [refresh]查询实际信息。/cli降级打开同工作区的独立原生launcher终端，明确不自动传入旧ID/模型/模式参数、不导入未验证记录；已验证版本保留原完整参数/公开历史交接。Unknown版本MCP/plugin修改操作被拒绝，只读查询保留。侧栏模式控件可保存选择，实际发送启动必须通过版本验证，不把未知版本当已支持。
- 补充模块和真实Webview→Provider→Service→CLI替身：版本来源/实验标签、并发去重/TTL/替换/refresh、迟到旧probe的授权fence、未知/失败/超限输出不导出秘密、超时自有父/子退出、未知版本草稿和独立终端、管理修改不执行、两轮发送仍仅1次version+1个Stream-JSON进程、capabilities本地命令零模型记录、未知版本UI提示不冒充可恢复交接。版本查询fixture补齐--version=1.2.14；soakfixture的新源码也更新，正在运行的baseline副本不变。
- 初次新增回归失败：执行层直接发送未持久化草稿；补存草稿后旧启动停止测试期望保留已有preserved却被hello覆盖；改为有草稿保留、无草稿才填入安全displayText。UI命令测试误用了仅运行时才出现的command-send按钮，改为实际空闲send按钮并等待启用。全部失败记录optimization-cli-capability-*.txt保留，未通过删测试或放宽语义获得通过。
- 最新完整功能**169/169**通过：optimization-cli-capability-webview-tests.txt（最近编译全回归168/168见handoff-tests.txt，随后只新增一项UI测试）；之前monotonic167/167及warm168/168均保留。实际本机launcher只读探测确认为1.2.14：optimization-local-cli-capability-final.json，单次首查210.424ms、缓存3.609ms，build SHA256记录；更早单次282.194/0.462ms保留。不是多样本性能保证，最终CLI对照必须计入首查开销。已验证进程复用测试证明暖轮没有新增version进程。
- 新能力构建的短Provider资源冒烟optimization-soak-capability-smoke.json通过，约8.2s/4轮，自己的12个活跃父/子进程关闭后退出；不是最终2h或负载矩阵。
- **下一步启动取消专项**：代码审查发现新version查询当前由自身1500ms超时回收，Controller.abortTurn尚未取消这个共享探测。需补消费方取消/引用计数及停止后自有探测组退出验证，不能为停止某轮杀掉其他会话共同等待的探测，也不能把已有CLI停止测试当成此新路径通过。该缺口必须在发布前修复。

2h baseline仍确认运行，handle46984/PID334203，最新约22.3分钟/381轮，最近样本loadedSessions4、写队列已提交；只报告进行中事实，不由短趋势宣称最终内存稳定。baseline固定副本在能力改造之前，最终版本仍需完整重验。安装2.2.0未改变；CLI同配置/原生新增回流/诊断导出/工程与故障/最终窗口发布仍未完成。


## 启动版本探测的共享取消与取消结果（仍未发布，2026-10-03）

- CliCapabilityCache的pending改为探测及消费者集合，discover接收可选AbortSignal；取消一方立即退出其等待，其他消费者继续。最后消费者取消时终止本次探测POSIX组并等待close，不缓存取消结果。已取消请求不启动进程，缓存命中也校验信号；旧查询finally按对象身份清理，不能删除取消后立即重试的新pending。刷新/文件替换导致的重探测继续传递取消信号。
- Controller每轮独立startupAbort和capabilityCheck，abortTurn/销毁取消本轮探测，并把探测退出等待纳入停止；后续epoch检查继续阻止迟到版本结果启动CLI。探测leader正常退出也清理其自有进程组，避免wrapper留下忽略stdio的helper。未扩大到终止其他用户/会话的查询，也未使用全局同名pkill。
- 新增真实POSIX父/子fixture专项：最后消费者取消后退出与再查询、两个消费者取消一方另一方正常完成且只有一次query、预取消无进程、Controller启动停止草稿恢复及组退出、旧pending清理不吞立即重试、成功wrapper忽略stdio helper也退出。原169项基线通过cancel-baseline-tests.txt；增加专项后173/173，再加入retry/helper后175/175，实际Webview→Provider→Service→模拟CLI的版本查询中停止及按钮/草稿/父子退出为176/176，全部diagnostics/optimization-cli-probe-*.txt保留。
- 新增OperationCancelledError作为明确取消结果，Bridge失败回复可带cancelled=true，RequestClient还原类型，UI不把用户主动停止标成“发送失败”。Controller与进程启动/输入代次取消传递此类型；CLI普通失败照常显示。不是按回复文本猜状态：单测验证普通Error即使文字相同仍为失败，只有明确类型→标记→还原的链路视为取消；重复请求重放仍保留结果且handler只执行一次。
- 最新完整**177/177**通过diagnostics/optimization-cancellation-replay-tests.txt（最后编译全回归176/176见optimization-cancellation-outcome-tests.txt，随后只加一项unit测试）；取消后无误报发送失败的实际Webview测试通过。当前短soak新构建通过optimization-soak-cancellation-smoke.json，8s/3轮，隐藏恢复及自有12个活跃父子PID退出通过；不替代2h/真实安装窗口或整套性能矩阵。
- 退出等待仍需在最终故障审计检验其截止时间：现在SIGKILL后等待close，而不是提前冒充进程已经退出；异常继承stdout/不可退出的OS状态必须给出明确退出未确认结果，不能永久pending或声称全部后代退出。正常POSIX组的已验证结果不扩张成任意脱离进程组后代/Windows进程树均已证明。

2h固定旧构建baseline仍运行handle46984/PID334203，最新约39.5分钟/703轮。已完成两项60s阶段：可见空闲60.014s内Host CPU12.43ms、Webview TaskDuration70.97ms、IPC0；隐藏活动60.014s内Host CPU1293.82ms、Webview TaskDuration73.38ms、真实CLI事件987、IPC0。包括本次采样/Headless环境，不冒充真实VS Code窗口CPU。持续阶段cache loaded4，记录曲线进行中，2h最终趋势/收尾仍未验收。

当前源码未打包安装，安装仍2.2.0；完整计划仍继续，故障/退出截止时间、脱敏诊断导出/模块/包/CI、真实TUI新增回流、同配置CLI对照、固定最终构建矩阵与安装发布尚有缺口。


## 版本查询退出确认截止时间与实际竞态（仍未发布，2026-10-03）

- ProbeExitUnconfirmedError区分“请求取消”与“退出未确认”。版本查询超时1500ms或取消/leader退出后发送自有组KILL，额外300ms关闭截止；超过期限销毁本次读取管道并拒绝，不永久pending、不缓存未确认版本。最后消费者取消不会把此错误改成取消成功。Controller发送和abortTurn保留退出未确认失败；UI仍显示真实失败，不声称已停止。
- 新增真实POSIX故障fixture：脱离查询组的子进程继承stdout，leader结束或被取消仍不close。验证截止错误、版本不获授权、pending/缓存清理、取消不伪装成功，以及Controller send/stop同为退出未确认、状态failed而非aborted、草稿保留。脱离组的helper不能宣称被本次组信号终止；测试最终依据自己marker的PID+startTicks逐一KILL并等待退出，不触碰用户或其他测试进程。这个结果是明确限制/异常处理，不是任意脱离组后代自动清理已实现。
- 最新Controller故障全回归首跑180项中179通过，失败来自**已有正常停止测试**立即pids.every(exited)为false（optimization-probe-controller-exit-tests.txt保留）。父close不等于所有收到KILL子进程已完成退出，属于实际观察的竞态；未将断言改成延后自等来掩盖。
- 新增core/processGroup.ts，仅停止/退出确认时验证明确自有PGID：signal0已无组时直接返回，仍存在才异步读取/proc stat判定该组非Z/X成员，退出的zombie不冒充活跃工作；批量32个异步stat，10ms退避且截止。正常stdout流无发现定时器、不增加模型请求、不向其他进程发送信号。版本query close回复前调用确认，失败/检查异常返回退出未确认；外层300ms截止仍约束查询回复，不以父close替代自有组退出。
- 最新编译及完整**180/180**通过diagnostics/optimization-probe-group-tests.txt，保留首跑真实竞态记录。版本query的正常组退出及故障截止均有证据；AgyProcessManager原有stopChild还需要在最终停止专项应用同类退出确认/不确定结果和执行锁保持策略，不能把query专项扩张成全部模型CLI工具后代已完成。

固定旧构建2h baseline仍在运行handle46984/PID334203，最新约53.5分钟/966轮，Host RSS281,870,336、heap60,965,272、Webview heap67,529,248、Nodes5158、loaded4。只是单个当前样本；需要完整趋势/收尾及最终构建重验，不由采样说资源上限已获保证。

完整目标继续；安装2.2.0未变。本轮未进行用户窗口操作、接口/凭据/设置改写。后续停止/锁不确定结果、stderr预算及结构化脱敏诊断导出、工程/故障/原生回流/同配置对照/最终发布门槛仍未完成。

## 模型 CLI 退出确认与压力测试复核（仍未发布，2026-10-03）

- AgyProcessManager 停止后核对自身 POSIX 组退出；退出未确认保留组标识并拒绝启动，后续停止可重试确认。Controller 仅在退出已确认时释放执行锁，保留失败清理的执行器与监听；runtime/会话列表显示退出未确认。现有完整回归 180/180，见 optimization-model-cli-exit-tests.txt；该回归不替代新增故障专项。
- 新增模型进程专项：真实 fake CLI 启动工具子进程后，注入组退出核对失败；停止明确失败、exitConfirmed=false、重启受阻。恢复真实核对后停止重试成功，能够再启动并收到回复。processManager 专项通过，见 optimization-model-cli-stop-retry-tests.txt。跨仓库锁、Controller/实际 Webview 清理失败与原生终端所有权仍需专项验证。
- 本轮实际复核旧 soak handle46984 已不存在，Host PID334203 在 ps 中也不存在；日志最后有效样本约4077.966s（约68分钟）、1235轮，没有最终JSON报告。此前运行事实保留，但本次未完成2h验收，不能算通过；终止原因没有足够证据。保留原日志（包含末尾异常零字节），不覆盖失败记录。最终固定构建仍需完整2h资源测试及收尾退出核对。
- 主要改造与分场景性能已有证据，完整计划尚有执行锁/故障/诊断/模块工程、真实原生回流及同配置CLI对照、固定最终性能资源矩阵、安装窗口与发布交付缺口。安装仍2.2.0，不以阶段测试数推算交付百分比。

### 停止失败与同仓库执行互斥专项

- requireIdle 现在拒绝退出未确认状态，停止重试仍走独立通道。Controller 删除当前会话在确认停止后释放旧执行锁，避免成功删除后留存旧锁。
- 实际 Coordinator→Controller→模拟CLI 专项：启动工具子进程后注入退出核对失败；停止报错、消息标记 failed、执行器不可淘汰/裁剪，另一 Repository 无法 acquire 同一 CLI ID；dispose 失败保留执行器。恢复真实组核对、停止重试后锁可取得，原执行器再发送成功。首跑等待 tools.size 错误（fixture 使用 agent_response 报告 child PID）保留；改为等待实际 child:PID 正文事件后28/28通过，optimization-stop-lock-tests-rerun.txt。
- 审查确认 acquire 的引用计数用于存储事务，但不能保证同仓库多个执行器互斥。新增 acquireExecution 独占声明，Controller Stream启动/ID转换/原生交接使用它；存储内部仍可 acquire 重入。释放幂等且绑定声明身份，旧释放不能移除新声明。编译及完整183/183通过，optimization-execution-claims-tests.txt。
- 新增真实两份本地历史指向相同 CLI ID 的链路：原执行器仍持有暖进程时，另一历史发送失败且不启动第二进程，原进程仍存活；原执行器确认停止释放后，第二历史发送成功。专项22/22通过，optimization-aliased-executor-tests.txt。原生终端期间修改/删除语义、Host死亡后CLI所有权恢复等仍待完整审计，独占声明本身不证明这些已完成。

本轮最终完整回归 **184/184** 通过，optimization-execution-claims-final-tests.txt；类型构建沿用本轮 compile，之后仅新增测试及进度记录。源码仍未发布安装，最终性能矩阵和窗口验收不以该测试数代替。

## 原生终端所有权与重新选择（仍未发布，2026-10-04）

- 执行声明区分 native 与侧栏执行，Repository 提供共享 native 所有权。旧会话交接后当前 Controller 创建新草稿，重新选旧历史可能创建另一 Controller；此前它不知道旧终端仍持有会话。现在所有 Controller 根据同一 Repository 声明检查，阻止普通发送、模式/模型/权限与运行设置修改、同步、停止和删除；侧栏停止不关闭用户原生终端。存储删除在入队与实际事务时都检查 native 所有权。
- 未验证版本的独立终端也持有本地会话声明，终端关闭/创建失败时释放。已验证交接使用真实CLI ID独占声明。空白native会话的新建不再重复使用该会话；新建其他对话仍保持原生任务和旧草稿。
- 已验证终端关闭后，公开记录导入和保存完成前继续持有声明；成功或失败清理后才释放，避免导入与另一Controller续聊同时执行。原生所有权变化通过Repository事件更新当前选中快照，非选中会话不传正文；新增监听在Coordinator dispose时撤销。未知版本关闭不导入未验证记录。
- runtime 带 nativeHandoff，UI 明确由原生终端持有，禁用执行设置和普通发送、隐藏Plan批准，不显示误导的侧栏停止按钮；本地slash仍可输入执行并按服务端语义验证。现有草稿保留。没有新增轮询、模型调用或主动关闭终端。
- 新增实际Coordinator→Controller→模拟CLI：交接后重新选旧历史（新控制器），不能发送/改模式/模型/停止/删除，原历史仍在；新建独立对话，关闭终端后原历史可再发送。新增实际React→Provider→Service→模拟CLI链路：禁用模式/发送、草稿保留、终端关闭后快照解除禁用并发送成功。
- 初次构建发现deleteSession重复声明变量，原记录optimization-native-ownership-tests.txt保留；修复后185/185，最终编译及完整**186/186**通过optimization-native-webview-tests.txt。未安装、未操作用户窗口，不能将该链路替身当作最终真实WSL窗口验收。

仍需审核Host死亡/重载后的CLI及外部终端归属、无确认退出状态UI专项、故障资源恢复和完整性能矩阵；原生新增轮次→关闭→导入→侧栏真实续聊仍需隔离已安装窗口证据。诊断导出/工程收尾/CLI同配置对照/最终2h和发布仍未完成，安装版本保持2.2.0。

## stderr预算与结构化诊断导出（仍未发布，2026-10-04）

- 模型CLI stderr原用readline，无换行的大段输出会保留整行。改为Buffer分块排空，仅记录字节/块数、已检查及未检查字节数、8个已知OS错误码；每块最多检查2048字节，每代总检查预算64KiB。无原文/路径/凭据保存，提示分类只检查有限前缀，跨块错误码或预算外错误不保证识别。新进程重置摘要，旧代事件不修改新摘要，退出撤销监听。
- 新增CliStderrSummary专项：重复注入约200MB源数据，计数准确且检查预算固定；摘要无任意提示词/凭据/路径。真实8MiB无换行stderr经过实际CLI管道排空，停止确认退出、再次启动摘要归零。完整188/188，optimization-stderr-budget-tests.txt。
- 新增DiagnosticJournal，Coordinator共享给各Controller，记录结构化单调轮次里程碑，512事件/256KiB估算预算；丢弃计数明确，未知里程碑和无效时间拒绝。会话与轮次用本次journal随机盐HMAC化，不导出原ID、cwd、自定义模型名、提示词或工具内容。按请求导出最多64个执行器的有界stderr和生命周期摘要，超出数明确。无每token日志/后台定时器/监控CLI，普通轮次无新增模型调用。
- /diagnostics查看、/diagnostics export使用原生保存选择器且只写所选URI、/diagnostics clear清空时间线。取消不写文件并保留记录；清空不删聊天和当前进程stderr计数。命令元数据统一参数验证/补全/help，仍属于本地操作。
- 新增unit与真实React→Provider→Service→模拟CLI：2万事件预算、未知文本拒绝、盐隔离/快照副本；实际轮次后导出包含stdin/首个CLI文字里程碑，不含提示词/项目路径/启动器路径；取消无第二次写入，清空时间线、模型历史不变。
- 首轮190项中188通过：旧真实管道测试读/proc/stat遇到ESRCH（读取中退出），测试与生产组核对把该明确进程消失错误和ENOENT同处理，其他错误仍不冒充退出。导出后快速重复同命令的测试再次超时，进一步确认UI仅按sendMessage禁用，slash请求收尾期间按钮提前可用、内部去重静默丢点击；修复为当前slash键也禁用，未删除测试。原失败optimization-diagnostic-export-tests.txt及rerun-tests.txt保留，最终编译及完整**190/190**通过optimization-diagnostic-export-final-tests.txt。
- 日志范围明确为Host观察里程碑：首CLI文字不是模型内部首token，不测Webview绘制或模型内部等待；当前未获得生产UI确认回执。普通环境输出日志仍走现有脱敏路径，本次导出采用字段白名单，不声称正则可完全处理任意日志秘密。诊断模块拆分已推进，Controller/Provider其余职责拆分仍待工程收尾。

源码尚未打包安装。当前停止/锁/原生交接改造需固定最终构建性能重验；Host死亡归属、故障/窗口/CLI对照/2h与发布门槛继续保留。

追加/proc读取中消失专项通过：optimization-proc-disappearance-tests.txt。注入ESRCH/ENOENT认定该条目已消失，EACCES/EIO仍返回退出未确认，不以访问失败冒充退出。

诊断构建的基础持续回放已结束exit0：optimization-diagnostic-sustained-performance.json/txt，1001有效样本/1000次40ms文字增量、3后台/20Agent，普通正文最终200001字；这轮没有连续工具替换（continuousToolUpdates=0），不当作极端工具/百万字或最终三轮矩阵。校准漂移0.264ms，文字P95 50.992ms、输入自动化P95 20.062ms、按钮恢复96.402ms，errors空。按钮恢复不代替进程退出或记录提交的分阶段时间。其Host RSS增长需要长时曲线解释，不能因本轮延迟通过而宣称资源稳定或2h验收完成。

## 宿主死亡后的执行归属（阶段未完成，2026-10-04）

- 磁盘owner增加formatVersion=2以及pending/bound执行信息。启动前发布pending，spawn同步绑定真实PID/boot/start time/独立PGID；绑定失败先停止本次CLI，不能继续发送。CLI会话ID转换后新锁也保存当前PID。原生终端通过VSCode processId可选回调绑定，缺少PID时保留pending；迟到回调不修改已关闭终端的声明。
- 死宿主的bound记录先检查PID身份与非Z/X状态，再检查独立组的活跃工具；全部已退出才允许归档旧锁。pending或无法证明独立组退出的记录保留；Linux跨boot记录可证明原进程已不在本次启动。恢复只检查，不自动终止其他终端或进程。
- 新增真实独立宿主/CLI/工具专项：杀宿主后不能取得锁，只杀CLI且工具仍活跃也不能取得，整组退出后可归档并接管。未绑定意图、旧boot、旧版无进程归属记录的锁验证已加入。初次编译因VSCode PromiseLike不支持catch失败，改为Promise.resolve后193/193；增加旧锁来源校验后194/194，optimization-legacy-lease-provenance-tests.txt。初次记录保留。
- **中断时最后两处规则改动还未复跑**：无独立组的bound记录保守保留，以及非Linux旧版锁缺少归属证据时保留。最新194/194结果早于这两处，不能称当前源码已完整验证。后续先编译/回归，再补原生PID绑定/持久化失败与真实窗口重载等验证。
- 仍不支持宿主死亡后接管原进程的输入/输出，不把防止重复执行等同后台守护服务。旧版同boot目录锁或pending记录需离线核对后归档；没有自动删用户锁。工程/完整负载/CLI对照/真实窗口/2h与发布交付继续待完成。

## agy C007/C008 生产渲染诊断（2026-10-04，未发布）

- C007 上游 `data:[DONE]` 解析错误，139.539s 未交付；确认本次组退出、副本未变后只重试一次。C008 沿用原 agy / Gemini 3.8 Flash High / high 和 Safe 只读 Agent，136.076s 交付，首公开文字124.975s；CLI原usage input71265/output20516/thinking17956/total91781，自有组确认退出、副本hash未变。委派耗时不代表性能收益。
- Gemini 候选为 RenderReceiptLedger，独立编译通过，初次测试14/15（array identity被接受）；主控补 `Array.isArray(identity)` 拒绝后集成。原候选、首失败、reviewed.ts均保留。
- 主控实现 Host Bridge、浏览器 Observer、Provider单向入口和Journal schema2。只在首正文、终态正文、恢复正文发送探针；pending最多32、TTL30s、无定时轮询和逐token回执。nonce绑定session/turn/generation/message/step/page epoch/source length，迟到与伪造拒绝。
- Host post→ack 是包含返回IPC/Host调度的上界；browser receipt→DOM、DOM→两次RAF独立计时，不能相减不同进程时钟，不能声称实际像素合成或模型首token。
- 初次Webview62项中61通过（测试用Document.textContent为空），改body后62/62。真实Chromium第一次错误断言stopped（实际状态aborted）；第二次发现不变正文的memo组件不重新报告恢复DOM；第三次发现Chromium为closed details提供布局矩形。全部首失败保留。生产添加恢复探针的一次精确getElementById检查、closed-details祖先验证、空裁剪视口拒绝及toggle重检。CSS.escape替换曾在JSDOM抛异常但测试仍绿色，改为DOM ID后完整复跑无Uncaught/ReferenceError；一次optional message ID类型编译失败也保留。
- 最终完整276/276：diagnostics/optimization-agy-C008-final-clean-rerun-tests.txt。实际包69files/50Hostmodules，0maps/0browserDuplicates；仅检查包内容，未生成新VSIX或安装。
- scripts/verify-render-receipts.cjs 冻结out/media，真实headless Chromium +实际Provider/Service/Controller + POSIX模拟CLI及其工具子进程。首正文只一回执，多次增量无额外回执；停止终态正文、hidden→restore、closed details无样本直到打开、0高度裁剪无样本、clear后无迟到样本均通过。本次所有模拟工具进程确认退出。geometry专测直接调用同一生产Observer，不冒充整个折叠UI链或真实VSCode窗口。
- 最终证据diagnostics/optimization-agy-C008-chromium.json与chromium-final.txt，仅3个诊断样本，不计算或声称最终P95。JSDOM的几何模拟只是关联证明。点击→提交、实际存储commit里程碑、其余工程提取/完整故障资源矩阵/固定最终三轮/2h/真实TUI回流/同配置CLI对照/发布安装仍待完成。

## agy C009 执行配置解析与保存提交诊断（2026-10-04，未发布）

- 原 agy / Gemini 3.8 Flash High / high、Safe 只读 Agent；独立当前源码副本，300s/一轮预算。91.668s成功交付，首公开文字87.678s；CLI原usage input80614/output12170/thinking10695/cache_read24377/total92784，未将thinking或cache再次相加。自有组确认退出，输入副本无变化。模型耗时不当作扩展性能收益。
- 候选75行 TypeScript，独立副本编译和4/4专项通过，无需修订候选。主控逐字段对照原Controller模型规则与profile构建：保留suffix/max拒绝、未知模型行为、requested/effective model、cwd/目录、原native ID、Agent、权限、schema/sandbox、旧capabilities。未增加配置降级或CLI调用。
- 集成resolveModel与resolveExecutionProfile，Controller保留异步目录恢复、能力发现、启动/停止、锁与代次、native交接生命周期。profile目录冻结和schema指纹继续来自原executionProfile。专项覆盖families/depth、max错误、未知model、Plan只读Agent/禁Danger与schema、Agent定义错误、normal参数与不可变输入、native ID不影响signature、schema改变及权限改变影响signature。
- 主控同期实现CommitDiagnostics：每执行器最多32个terminal消息metadata/callback，5min事件驱动过期；只捕获TurnDiagnostics，不捕获ActiveTurn/正文。对应session/message/status在实际消息写入、events追加及session.json原子替换成功后记录storage-committed；失败没有成功事件，重试后才标记。legacy state update完成才标记，top-level消息快照防止异步status/body串到后续修改。无定时轮询、额外模型调用或同步等待存储后才结束UI。
- 5/5 commit专项：wrong-session/running/重复提交拒绝、32上限/TTL/clear/异常callback、实际metadata失败后重试与可选observer异常不污染成功存储、真实Controller/POSIX CLI结束但慢存储未提交、legacy异步修改身份。storage-committed不承诺fsync或断电持久性，Journal说明完整保留。
- 定向29/29；首次完整284/284，增加legacy专项后最终285/285：optimization-agy-C009-final-tests.txt，无Uncaught/ReferenceError。包检查71files/52Hostmodules，0maps/0browserDuplicates；未生成VSIX或安装。
- Chromium回放最终通过首/停止/恢复/折叠/空视口/clear与真实保存commit，全部自己的CLI及工具后代确认退出；diagnostics/optimization-agy-C009-chromium.json及final-chromium.txt。VSCode API仍mock，不能代替安装窗口或最终性能P95/2h。
- C009初次复跑沿用了C008脚本默认输出名，覆盖了该默认JSON（旧成功stdout保留）。已将C009当前报告移到自己的文件，并将脚本默认改为通用报告名，后续使用AGY_RENDER_OUTPUT明确指定。为保留C008可定位的完整证据，使用C009冻结输入里的C008生产模块/旧脚本重新验证通过：optimization-agy-C008-frozen-rerun-chromium.json/txt。该冻结验证目录有一个未被生产import的C009候选模块，报告不冒充最初时间点的原始JSON。
- 仍待Controller TurnRunner/PlanPolicy/NativeHandoff、Provider dispatcher及剩余Webview拆分、点击→受理时间线、完整故障资源矩阵、固定最终三轮/2h、真实TUI回流、同配置三路径对照、安装窗口/发布与AGENTS记录。安装保持2.2.0，未操作用户窗口、凭据/接口/权限设置或GUI。

## agy C010 Plan 策略与批准链路（2026-10-04，未发布）

- 原 agy / Gemini 3.8 Flash High / high、Safe只读Agent，当前源码/构建独立副本，300s/一轮预算。170.523s交付，首公开文字165.328s；CLI原usage input5834/output27901/thinking27033/total33735，无重复相加。自有组退出确认，输入副本无变化；委派耗时不当作性能优化收益。
- 原候选101行，独立编译通过、测试5/6：两段Plan提示词丢失末尾换行。主控只恢复原始提示词的\n\n和\n，保留原候选/首失败；reviewed独立编译及6/6通过。提示词与原执行路径逐字节比较。
- PlanPolicy owns capturePlanApproval/assertPlanApproval、只读Agent身份匹配、一次空正文读取拒绝恢复和带读取拒绝方案是否可批准的纯策略。Controller保留真正模式变更、停止、执行锁、代次、发送与结果投影；未扩大权限/工具、增加重试/调用或改变Plan/normal native ID。首次集成编译因布尔helper不携带TypeScript非空收窄而失败，受非空denial条件验证的分支加类型断言后通过；原编译日志保留。
- 6项module测试覆盖最新assistant/精确ID/Plan/非空/完成、输入不被修改、stored与legacy parallel意图、异步后session/message引用及正文/status变化、仅一次纯读取拒绝且空正文的恢复、可批准read-denied正文、实际Agent与完整prompt bytes。没有把generated角色名称当多Agent意图。
- 新增真实React→Provider→Coordinator→Controller→POSIX模拟CLI：在模式切换结束但批准尚未返回时修改方案正文，具体requestFailed、0次stdin提交、历史与草稿所属会话不变；恢复后重新明确批准仅一次提交并完成ordinary消息。新增实际Controller→CLI init Agent不匹配：stdin0、确认CLI退出、Plan及草稿保留、另一Repository可取得已释放声明。
- 定向68/68（后新增Agent mismatch独立22/22），最终完整293/293，diagnostics/optimization-agy-C010-final-tests.txt，无Uncaught/ReferenceError。包检查72files/53Hostmodules，无maps/browserDuplicates；未打包安装。
- actual headless Chromium→Provider/Service/Controller→POSIX模拟CLI渲染/保存诊断复验通过，optimization-agy-C010-chromium.json/txt，自己的CLI及工具子进程确认退出。VSCode API仍mock，不是安装窗口或真实模型性能保证。
- C010委派期间使用冻结输入中的C009构建做基础持续工具回放：optimization-agy-C009-sustained-tools.json，1001文字样本/1000次40ms增量、200001字、20000工具替换、1000工具卡/80MB原文、3后台/20Agent；11工具卡实际挂载。显示P95 50.752ms、输入P95 12.892ms，漂移-0.039ms，选择/向上滚动保持、errors空；点击停止至发送按钮恢复57.898ms，不等同CLI组退出或记录提交。该脚本用真实Chromium/Coordinator/Bridge/CLI，未经过Provider render-probe装饰，不能用它证明生产回执开销已完成最终矩阵。属C009阶段一轮，不冒充C010或固定最终三轮/2h。
- Controller1625行，PlanPolicy101行，边界更清楚不代表整个工程拆分完成。剩余TurnRunner/NativeHandoff、Provider dispatcher/Webview、点击→受理诊断、完整故障资源矩阵、固定最终三轮/完整2h、真实TUI回流/同配置对照、发布安装与AGENTS记录继续保留。安装仍2.2.0，未改用户窗口/设置/接口/启动器/GUI。

## agy C011/C012 流式投递职责（2026-10-04，未发布）

- C011完整TurnDelivery候选300.524s超时，无公开交付；自有组退出确认、副本未变。C012缩为纯文本分片/工具批次helper，原模型/high/只读Agent不变，141.924s交付、首公开文字135.353s；CLI input5121/output21369/thinking20963/total26490，不重复相加。原始失败与候选保留。
- agy候选deliveryFragments44行原样采纳，独立编译与3/3通过。主控TurnDelivery管理每轮pending和唯一30ms定时器：文本不拆有效surrogate pair、保留零时间戳；工具预算预计算不重复序列化；拒绝超限单项前不改变原队列；flush先取快照，重入工作不被清除；取消旧回调不得冲刷新批次；dispose及失效轮次阻止迟到发送，emit错误可观察。
- Controller实际集成，完整原文/持久化/进程与锁继续原归属，finish先flush再结束；dispose仍保存已收到正文。真实React→Provider→Coordinator→Controller→POSIX模拟CLI验证大Unicode增量<=16384单位、精确拼回、receivedAt0、stepDone顺序和停止保存全文。
- 初次完整303测试中302通过，新增用例错误等待fixture partial，第一次修正仍错误等待hello；fixture hang真实发child:<pid>。两次失败保留，改正确等待后通过，未归为生产缺陷。
- 最终完整305/305，optimization-agy-C012-final-tests.txt；实际包74文件/55Host模块，无map和浏览器重复编译；Chromium渲染/保存诊断通过，自己的CLI/工具退出确认。未打包安装。
- 冻结C012构建持续工具回放optimization-agy-C012-sustained-tools.json：1001样本文字/200001字/20000工具替换/1000工具卡80MB/3后台20Agent；显示P95 52.826ms、输入P95 18.808ms、漂移-0.0049ms、选择及向上滚动保持、errors空。停止至按钮恢复66.199ms，不等于进程退出或保存提交。脚本未经过Provider renderProbe装饰；阶段一轮，不冒充最终三轮或完整2h。
- Controller1585行；剩余TurnRunner/NativeHandoff、Provider/Webview、点击→受理、故障矩阵、固定最终性能/2h、真实CLI/窗口与发布仍须完成。安装仍2.2.0。

## agy C013 原生交接职责（2026-10-04，未发布）

- 原模型/high/Safe只读Agent，240s一轮；188.925s交付、首公开文字183.175s。CLI原usage input135797/output24167/thinking21747/cache_read171053/total159964，按原字段记录，未重复相加；自有组退出确认、副本未变。模型开销不当作扩展性能收益。
- NativeHandoff候选146行，独立编译/4项测试通过。补充终端关闭后、导入尚未结束时迟到PID用例，候选失败；主控增加terminalClosed拒绝，保留失败记录。为执行器缓存判断提供size，reviewed独立编译/4项通过。
- Controller移交终端归属、去重关闭、游标检查点及公开记录追加；配置/profile、停止/代次、串行操作、保存和UI仍由Controller管理。关闭只通知一次，complete按launch记录身份幂等释放；记录读取/保存/flush完成前不释放，不自动停止终端或释放活跃归属。现Controller1549行。
- 实际Controller/POSIX模拟CLI新增慢保存+重复关闭测试。首次错误使用同Repository acquire（其内部引用计数允许复用），改用独立Repository验证互斥后准确复现旧代码二次同步(count2)。集成后通过，原失败保留。
- 初次定向回归被主动中断，进程handle已缺失且进程检查无对应node，不记通过；完整重跑310/310，optimization-agy-C013-final-tests.txt，无Uncaught/ReferenceError。包75文件/56Host模块，无maps/browserDuplicates。
- actual Chromium/Provider/Service/Controller/POSIX模拟CLI渲染保存诊断通过3样本，自己的CLI和工具确认退出；optimization-agy-C013-chromium.json/txt。不代表真实安装窗口或最终性能矩阵。安装仍2.2.0，未打包发布。

## agy C014 Provider 命令分发（2026-10-04，未发布）

- 原agy/Gemini3.8FlashHigh/high/Safe只读Agent，240s一轮，80.773s交付、首公开文字73.341s。原usage input7148/output14330/thinking12946/total21478，不重复累加；自有进程组退出确认、输入副本未变。
- 候选WebviewCommandDispatcher183行，type-only服务/编辑器依赖、平台函数端口，无VSCode运行时依赖或新增监听/队列/模型调用。独立编译通过；初次5项中2通过，3失败来自主控Proxy替身的get忽略赋值覆盖，修正替身后5/5，候选无需修改。原失败保留。
- 逐命令验证参数/身份、ready等待恢复后snapshot/commands、slash本地短路、普通/双斜杠/中文上下文prompt字节、运行中删除modal及取消、idle删除不确认、一次错误传播和设置原fire-and-forget行为。Provider接回dispatcher，bridge仍拥有入站校验/绑定/去重/响应；slash/context/editor原逻辑继续原模块。Provider772行，移除不再使用的diff转发wrapper。
- 集成编译、完整315/315，optimization-agy-C014-final-tests.txt，无Uncaught/ReferenceError；全部现有实际React→Provider→Coordinator→Controller→模拟CLI链路保持通过。包76文件/57Host模块，无maps/browserDuplicates，仅检查未生成VSIX。
- actual Chromium/Provider/Service/Controller/POSIX模拟CLI渲染/保存诊断通过3样本、自己的CLI及工具确认退出，optimization-agy-C014-chromium.json/txt。不是实际安装窗口或最终性能矩阵。安装2.2.0未变。
- 后续TurnRunner、Webview剩余组件职责、点击→受理诊断、故障/资源矩阵与完整最终三轮/2h、真实CLI/TUI回流和窗口、发布安装保持完整范围；未修改用户窗口/任务/设置/凭据/API/启动器/GUI/IME/剪贴板/自启或MindFS配置。

## agy C015 TurnRunner（2026-10-04，未发布）

- 原agy/Gemini3.8FlashHigh/high/Safe只读Agent，240s一轮，217.474s交付、首公开文字209.770s；原usage input127784/output27753/thinking24726/cache_read256365/total155537，无重复累加。自有组退出确认、副本未变。
- 原候选TurnRunner157行原样采纳；独立编译/6项边界通过。接管启动/发送/错误序列及原30s等待与1s检查点timer，Controller保留ActiveTurn/协议投影/结果/锁/串行生命周期。clear取消并token隔离旧回调，零handle有效，无新增正常流计时器或CLI调用。Controller1491行。
- 测试覆盖成功保存/清草稿顺序、启动前/后取消及mode/invoke_subagent不足→stdin0、取消cleanup未确认错误原样传播/先runtime再失败且保留锁、stdin不确定结果保留草稿/附件/失败user、submit期间result结束不arm timers、原Plan/parallel prompt字节及旧timer fence。
- 集成编译、完整321/321，optimization-agy-C015-final-tests.txt，未见Uncaught/ReferenceError；包77files/58Hostmodules，无map/browserDuplicate；actual Chromium诊断首/停止/commit/hidden/折叠/空视口/clear全部通过，自己的CLI/工具退出确认。3渲染样本不计算最终P95；未打包安装，安装2.2.0。
- 随后新增实际React→Provider→Service→模拟CLI用例，准确复现旧AgentPanel跨会话loading残留：第一会话详情未结束，新会话卡片不提交请求(0而应1)，optimization-agent-panel-stale-before-tests.txt。当前新用例故意未通过；321基线早于该测试，不能称当前完整源码/测试全通过。下一包C016修复并提取面板后复跑。全部最终验收/发布范围仍保留。

## agy C016 子代理面板与释放故障（2026-10-04，未发布）

- C016完整JSX候选240.157s超时，无公开交付，确认自有组退出、副本未变；C016B缩小pure gate，CLI在168.127s返回ERROR，上游data:[DONE]被当JSON，input5184/output0，确认退出/副本未变。依据实际错误仅重试一次C016C：135.342s交付、首公开文字132.262s，原usage input5186/output19539/thinking19071/total24725，未重复累加；退出确认、副本未变。全部失败保留，未降低模型/high/API/权限。
- 主控机械提取AgentPanel188行，保留卡片/独立日志/事件/分页/计时/未知token标签；详情request注入稳定函数并携带原sessionId。session改变重置loading/error/selection/page/cursor；旧请求catch/finally仅当前票据可更新。同步gate防快速连点双提交，无新增timer/model/监控CLI。
- 两个实际React→Provider→Service→模拟CLI回归先准确失败：旧会话等待导致新会话详情请求0应1；同步连点产生2应1。主控临时gate修复后两个通过，原临时primary.ts留档；C016C纯gate74行独立副本compile、3helper/2实际UI测试通过，无需修改候选，替换主控临时gate。Webview index1152行，AgentPanel独立模块。
- 同期完整故障审查复现NativeHandoff.complete在释放抛错时过早清状态，修复为释放成功后删除归属/标completed，失败保留可重试，releasing防重入。mock lease失败→重试用例先失败后通过。
- 进一步通过真实fs.renameSync(EIO)/rmSync(EPERM)注入，复现底层执行锁吞错误、已released无法重试，以及Repository引用计数提前减到0。修复executionLease只有缺失/被替换属主才安全放弃；I/O失败传播，退役路径保存以便重试只清理原退役目录、不触碰后来新锁。Repository最后引用物理释放成功后才减少计数/删除条目，执行声明已有成功后删除逻辑保持。新增三项实际I/O测试验证owner原文保留/互斥/重试、native claim和count1保留、退役cleanup失败后新owner不被旧retry删除。所有初次失败保留。
- 集成完整330/330，optimization-agy-C016-final-tests.txt，无Uncaught/ReferenceError；包77文件/58Host模块，无map和浏览器重复编译，仅检查未生成VSIX。实际Chromium/Provider/Controller/POSIX模拟CLI渲染/commit/隐藏恢复/折叠/空视口/clear通过3样本，自己的CLI及工具退出确认，optimization-agy-C016-chromium.json/txt。
- 冻结C016持续工具回放已终态0：1001正文样本/200001字/20000工具替换/1000卡80MB/3后台20Agent，显示P95 50.955ms、输入P95 12.524ms、停止至按钮恢复68.823ms；选择/向上滚动/输入保持、errors空。输出optimization-agy-C016-sustained-tools.json/txt、冻结哈希C016C/performance-manifest.json。未经过Provider renderProbe装饰；停止指标不代替组退出/保存；阶段一轮不等于最终三轮/2h或真实模型等待时间。
- 当前安装仍2.2.0，所有优化源未发布；下一步剩余MessageList/ToolDetails/Composer职责、点击→受理诊断、故障资源矩阵/随机链、固定最终性能/完整2h、真实CLI/TUI回流/窗口及发布。没有改动用户窗口/任务/API/凭据/配置/GUI/IME/剪贴板/自启/MindFS，未删用户history/锁。


## agy C017 执行与存储释放错误恢复（2026-10-04，未发布）

- C017首次9.053s上游invalid-stream-chunk错误，无交付；确认退出/副本不变后限定一次C017B同接口/model/high/Safe重试。76.360s交付，首文字73.044s；input12707/output11780/thinking11420/total24487原字段记录。候选operationFailures原样集成，保留临时primary及candidate，工程编译/3helper测试通过；本包没有另外隔离编译候选，不声称执行过。原模型延迟不是扩展优化收益。
- TurnRunner启动/提交失败与cleanup失败合并，原Error身份和cause保留，清理失败不能成为成功取消，runtime先于finish。Controller中央释放函数成功才清claim，失败保持释放函数及具体runtime错误；exit事件不抛出EventEmitter，abort finally始终发布状态。
- NativeHandoff保留closed/releaseFailure/complete callback，只能显式重试已关闭终端的释放；运行中终端/导入未结束不能提前释放。Coordinator恢复历史寻找ownsNativeSession的原Controller，避免丢原回调；执行器淘汰/空会话复用排除pending claim。React显示具体错误与重试释放按钮，保留草稿及现有输出，未释放期间禁send/model/Plan。
- 实际React→Provider→Service→Controller/Repository注入exit EIO；真实POSIX挂起CLI和工具进程组停止后注入release EIO；native终端mock与实际磁盘锁关闭EIO/重复关闭/恢复owner/侧栏显式重试。分别证明事件包含错误、工具组确实退出、claim继续互斥、草稿输出保持、重试不重开终端、后续CLI轮次成功。native mock不能代替真实VSCode终端最终窗口验收。
- 新增实际fs.renameSync三项首先准确复现checkpoint/metadata释放失败跳过budget归还，以及write ENOSPC+release EIO掩盖原错误。pendingStorageReleases只保留失败storage callback，明确flush重试，无新增timer/模型调用；nested finally始终归还WriteBudget，组合原始与cleanup错误。deleteSession同样保留cleanup，并补第四项实际删除commit→释放EIO→重试→第二Repository获取锁；删除已提交不会伪造历史恢复。execution claim仍由原Controller/native管理。
- 初次storage before在compile清out期间启动，MODULE_NOT_FOUND属操作次序失败，随后等待compile后before-corrected准确复现。首次after24/26两失败因测试中的other Repository创建早于session，改新Repository核对真实落盘正文/草稿后26/26；所有失败保留。初次Chromium也在npm test重编译期间拷贝out导致ENOENT，串行等待完整test再复验成功；以后compile及依赖其产物的验证必须串行。
- 最新完整341/341，optimization-agy-C017-final-tests-with-delete.txt，无取消/失败。package check78files/59hostmodules/0maps/0browserDuplicates（未生成VSIX）。真实Chromium/Provider/Controller/POSIX模拟CLI渲染及commit诊断通过3样本，first/stopped/hidden/closed-details/empty-clip/clear和自己进程退出确认；optimization-agy-C017-chromium-rerun.json/txt。该短功能复验不是性能三轮或2h。
- 本包未重跑性能，最近阶段持续工具仍C016 P95 50.955ms；不把它当C017结果。安装/package保持2.2.0，未发布、不改用户窗口/任务/API/凭据/设置/GUI/输入法/剪贴板/自启/MindFS，不删用户历史/锁。
- 下一步剩余Webview runtime/MessageList/ToolDetails/Composer职责、生产click→accept诊断、随机操作及故障资源矩阵收尾、冻结最终三轮/极端/idle-hidden60s/完整2h、同配置三路径5cold5warm×三场景、真实TUI新增轮次回流、隔离安装窗口/版本符号档/备份/发布安装回退/AGENTS/逐项completion audit。


## agy C018 Webview 运行时与消息职责（2026-10-04，未发布）

- 原agy/Gemini3.8FlashHigh/high/Safe只读Agent，一轮180s，76.796s交付runtime.ts86行；input57197/output10146/thinking8938/cache_read28517/total67343按原usage记录。自己进程退出/输入副本不变。独立validation TypeScript编译通过，真实esbuild/JSDOM2/2验证单一API/message listener、请求/pagehide释放、事件路由和showAgents会话围栏；首次strict eval未暴露window变量的测试错误保留，改测试后通过，候选未改。
- 原样集成agy候选。主控机械抽出Message156、ToolDetails91、CodeActions70、MessageList14，index779行。保持初始化顺序与一个store/request/observer，不重复监听；消息列表memo跳过未变化messages引用，流式DOM/Markdown/结构化JSON/文件链接/工具分页/代码预览原行为保留。未增加模型请求或timer。
- 新真实React→Provider→Service→模拟CLI证明draft、新建、发送、完成多次render仍仅API/ready一次、发送一次。完整344/344，optimization-agy-C018-final-tests-with-list.txt，包78files/59Hostmodules/0maps/0browserDuplicates；没有打包安装。Chromium probe3renders全部checks/自己进程退出通过，optimization-agy-C018-chromium.json。
- 冻结C018持续工具回放1001样本/200001字/20000工具替换/1000卡80MB/3后台20Agent，显示P95 51.137ms、input P95 12.529ms、stop按钮63.239ms，选择/滚动/输入保持、errors空。哈希在C018 performance-manifest；输出optimization-agy-C018-sustained-tools.json/txt。非Provider probe装饰路径，stop按钮不代替进程退出/存储commit；阶段一轮不是固定最终三轮/2h或真实模型耗时。
- 安装仍2.2.0；待Composer/点击受理/随机故障矩阵/冻结最终性能2h/真实CLI对照及TUI回流/窗口发布。所有用户窗口、运行任务、设置、接口、凭据、GUI、输入法、剪贴板、自启/MindFS不变，用户历史/锁未删。


## agy C019 Composer 与 IME 输入职责（2026-10-04，未发布）

- 原agy/Gemini3.8FlashHigh/high/Safe readonly，240s一轮，136.512s交付、首公开128.959s；usage input5886/output21490/thinking20467/total27376按原字段，不重复累加。退出确认、副本不变。候选ComposerInput保留原textarea/补全所有handlers、ARIA、ID、placeholder，只有模块/typed props变化。
- 独立validation TypeScript/真实React+esbuild+JSDOM2项：IME期间Tab/Enter不执行、结束后30ms、Shift换行、跨render父refs、arrows/Tab/Escape/mouse及modifier原语义。首次placeholder断言因测试再次spread初始planMode=false失败，修测试后2/2；初次集成编译因合同RefObject<T>不匹配本机React19 RefObject<T|null>失败，只修该type，reviewed独立compile/2tests通过。原candidate、首失败、reviewed完整保留。
- 主控机械抽Composer footer、index469行；App继续草稿/上下文保存、请求门控、send/stop/new/session与滚动。IME refs不重建，edit/send稳定ref+callback、候选数组按draft/dismissed/commands memo、输入组件memo避免普通正文变更修改其props。未增加timer或模型调用。输入逻辑与命令行为不因拆分变化。
- 完整346/346，optimization-agy-C019-final-tests-rerun.txt；包78files/59Hostmodules/0maps/browserDuplicates。Chromium probe3renders含commit/隐藏恢复/details/clear/ownProcessesExited通过。尚未打包安装。
- 冻结C019阶段持续工具1001样本/200001字/20000工具替换/1000卡80MB/3background20Agents，显示P95 52.256ms、input17.061ms、stop按钮68.060ms，选择滚动输入保持、errors空；performance-root/manifest及optimization-agy-C019-sustained-tools.json/txt。非Provider probe装饰路径；按钮恢复不等于进程退出/commit；阶段一轮不是最终3轮/2h。
- 下一步click→accept本地时钟诊断、随机操作与故障/资源收尾、固定最终3轮及完整2h、同配置三路径5cold5warm×三场景、真实TUI新轮次回流/隔离安装窗口、最终符号档/版本/备份/VSIX/安装回退/AGENTS及完成审计。当前安装仍2.2.0，不改用户窗口/任务/设置/API/凭据/GUI/输入法/剪贴板/自启/MindFS或删除用户历史/锁。


## agy C020 请求入站本地时钟诊断（2026-10-04，未发布）

- 原agy/Gemini3.8FlashHigh/high/Safe只读，240s一轮，120.529s交付、首公开102.552s；usage input93249/output14223/thinking10893/total107472按原字段保存。自身退出/副本无改。模型额外给了计划/确认文案，仅采纳经独立审查的代码，不把模型文案当权限来源。
- RequestReceiptLedger原样候选，独立snapshot编译/4专项通过：严格身份白名单、不拷正文/路径/外部时钟、nonce/epoch/request对应、匹配仅一次、拒绝不消耗有效entry、64容量/30s逻辑TTL、clear、无timer。主控集成RequestClient/Bridge/Provider，Bridge先注册dedup防同步observe重入；仅send/stop每次新增observed+receipt两条小消息，saveDraft/逐token不采样、不增加timer/模型调用。
- App测本地click→post queued含保存；browser本地post→observed往返上界、Host本地receipt→report分段。不是精确单向click→host/CLI处理时间，不相减不同进程时钟。Journal schema3 request/turn/session pseudonyms与accepted请求关联、stop当时active turn关联，无prompt/path/raw ID/nonce。clientSentAt旧可选字段不用作跨时钟延迟。
- Provider创建/隐藏/释放/diagnostics clear取消pending，epoch/session/visible保护；RequestClient仅匹配pending回执一次、不会提前resolve原操作，telemetry发送失败不使用户操作失败。定向11/11，实际React→Provider→Service→Controller/POSIX模拟CLI的45ms保存→hang→Stop→2匹配回执、关联/重复/伪造/泄漏检查1/1。
- 最新完整356/356，optimization-agy-C020-final-tests.txt；包80/61，0maps/browserDuplicates；实际Chromium probe3renders全部checks及ownProcessesExited通过。无最终性能重测，最近阶段持续仍C019 P95 52.256ms，不能当C020性能结论。
- 待随机操作/完整故障资源矩阵、固定最终构建3轮/极端/idle-hidden60s/完整2h、同配置原生TUI/directStream/侧栏5cold5warm×三场景、真实TUI新增回流及隔离安装窗口、最终符号档/版本/备份/VSIX安装回退/AGENTS/审计。安装仍2.2.0，用户窗口/任务/设置/API/GUI/输入法/剪贴板/自启/MindFS不变，历史/锁未删。


## agy C021/C022 随机链与清理故障（2026-10-04，未发布）

- C021完整测试候选240.152s超时，没有交付；退出/副本不变、失败保留。主控实现完整随机链；C022缩单次委派为pure LCG，原agy/Gemini3.8FlashHigh/high/Safe/API不变、180s一轮，64.411s交付21行helper、首61.525s；usage47146/8275/thinking7657/total55421原字段。候选独立2/2（seed0黄金、BigInt无符号32bit、invalid输入/fresharray），原样集成test/helpers不进入生产包。
- 实际Coordinator/Repository/POSIXfakeCLI三seed17/65537/20261004，各120随机+13明确前置，总399操作；75个自有CLI组dispose后确认退出。验证同时两个background、new不停止旧轮、选中Stop不停止另一个、busy model/Plan明确拒绝计数、draft/history/Plan/crash/snapshot、model/high/ID/选择、跨Repository活动claim互斥、结束budget0/无active.lock/可再次获取claim。没有用伪造事件代替实际CLI。初393链也通过，增加明确busy/两背景覆盖后复跑，所有证据留档。
- 新actualfs rename EIO准确复现Coordinator.dispose吞错误并清空失败执行器。修为allSettled后只移除成功执行器，失败保留callback/claim、与flush原异常组合后throw、可明确retry；全部成功才清selected/listeners。并发清理共用Promise；subscription不能await时明确catch/log，deactivate仍await。专项+并发27/27通过，真实group退出/锁仍保留→I/O恢复retry→跨repo成功。原before Missing expected rejection保留。
- 完整362/362，optimization-agy-C022-final-tests.txt，无失败/取消。新OPTIMIZATION-ACCEPTANCE-MATRIX逐条映射原要求与仍未关闭的最终gate；不是仅凭测试数声称complete。包81files/61Hostmodules/0maps/browserDuplicates；实际Chromium probe3renders全部checks及ownProcessesExited通过，optimization-agy-C022-chromium.json/txt。短功能验证不是最终性能矩阵/2h。
- 下一步冻结候选构建及固定三轮/极端/60s闲置隐藏/完整2h，原配置真实TUI/directStream/安装侧栏5cold5warm×短/读取/工具，真实TUI回流及隔离窗口全链、版本符号档/备份/VSIX/安装回退/AGENTS/audit。安装仍2.2.0，用户窗口/任务/设置/API/GUI/输入法/剪贴板/自启/MindFS不变，用户history/locks未删。


## 2.5.0 candidate freeze / final acceptance started (2026-10-04)

- Candidate package/source version is now2.5.0; installed user extension remains2.2.0. No candidate VSIX/install yet. README protocol header corrected to verified1.2.14+1.2.16.
- Before-candidate backup: /home/ubuntu/.local/share/antigravity-extender-backups/20261004-203815-before-2.5-candidate (806manifest files, source/runtime/2.2VSIX/installed2.2/history/settings/AGENTS; live history best effort, never restore active locks/new history/settings). Earlier all-work backup preserved.
- Candidate npm test362/362: diagnostics/optimization-2.5-candidate-full-tests.txt. Package81files/61Hostmodules/0maps/0browserDuplicates: optimization-2.5-candidate-package-check.txt.
- Frozen candidate source/runtime/scripts/test/dependency lock356files: /home/ubuntu/.local/share/antigravity-extender-delegation/20261004-204009-2.5-final-freeze/freeze-manifest.json. Shared node_modules read only. Symbol archive80maps: /home/ubuntu/.local/share/antigravity-extender-backups/2.5-final-candidate-symbols-20261004-2040/manifest.json.
- Measurement pilots actualProvider1001samples each passed. First P9551.955ms, click→stopping5.553ms / group-exit18.074ms. Commit pilot P9551.628ms, click→stopping1.622ms / observed own-group exit28.690ms / terminal commit209.861ms / button47.085ms. Signed commit→button-162.777ms shows button can recover before persistence; do not equate UI recovery with commit. Calibrated click/Host estimates uncertainty0.713ms, exit poll5ms; terminal messageCommitted event follows successful message+metadata atomic writes, no fsync guarantee. Flush barrier is late upper bound. Both own groups exited, no errors; pre-freeze pilot not final round.
- Script fixes restored3post-runGC loops, added actualProvider/fakeconfig label, independently observed stopping/group-exit/terminal commit/button timing, added unclosed-code completion scenario, unique real-pipe output and model identifier. Fake fixtures Safe/no model calls; real comparisons must retain user Danger/API/Gemini3.8FlashHigh/high.
- Active terminal17703, verified Python104643 / Node104644 on first basecase at start. Sequential frozen matrix5scenes×3(1000+samples), upper tools/background/Agents,1k/10khistorymetadata, actualrealpipe; aftermatrix complete2hsoak+60sidle/hidden. Raw+atomic cumulative report diagnostics/optimization-2.5-final-matrix/matrix.json. No concurrentcompile or additional benchmark. Do not restart merely observationtimeout; repollhandle/checkactualprocess.
- Final gates still open: matrix/2h, actualsameconfig3paths5cold5warm×3scenes, realTUInewroundreturn/continuation, isolatedinstalledwindowfullacceptance, finalVSIX/install/manifests/release docs/AGENTS/completionaudit. No userwindow/reload/task/API/credentials/settings/GUI/IME/clipboard/autostart/MindFS change or userhistory/lock deletion.


## C023 + final rendering matrix / 2h active (2026-10-04)

- C023 offline90real-comparison validator: originalagy/model/high/Safe129.932s/first124.036s; usage42997/17790/thinking16473/total60787 per original result; ownexit/snapshot unchanged. Independent initial3/4 accurately exposed array dimension coercion. Explicit allowed-string includes correction, reviewed4/4 pass. scripts/comparison-validator.cjs and test/comparisonValidator.test.js integrated validation tooling only. Frozenproduction source/runtime unchanged. Complete362 tests predates these4; do not claim366full yet. REVIEW and all fails retained.
- Finalrender matrix18/18 plusreal-pipe1/1 completed on same2.5runtime, cumulative diagnostics/optimization-2.5-final-matrix/matrix.json. BaseP9552.091/52.371/51.960ms; millionplain54.610/54.706/55.079; paragraphMarkdown54.650/54.414/54.805; closedcode54.471/54.462/54.702; unclosedcode54.211/54.064/55.218. Each1001samples/1000tools80MB/3background20Agent; input/scroll/selection/source/own-group checks pass. Max completiontask80ms across these scenes.
- Upper10ktools160MB/10background100Agent P9561.160/input31.031ms, observedclick→group70.692ms (calibration uncertainty0.437ms). 1k/10khistorymetadataP9552.135/52.256ms, historyfixtures in-memorymetadata notdiskcoldinit. Realpipe2000tools/completeoriginals andblockedwritebackpressurepassed; data inreal-pipe.json, rendering summary inoptimization-2.5-final-render-summary.json. No first21sample tests passed as finalmatrix.
- CandidateVSIX generated with internalvscepack() (notprepublish/build) fromfrozeninput: diagnostics/antigravity-vscode-extender-2.5.0-candidate.vsix hashb8da667c3b2efc1b4a6d42161e210ab0acbdf33fb14f73ccc5a68a1bc9c758a6. Archive63runtimefiles exactfrozenhash, no maps/browserduplicates. Notinstalled/released. Finaldocumentation VSIX later mustretainruntime hashes.
- Active17703 remainslive; Python104643 + soakNode108501. Afterrender19pass automatic2hsoak started; idle60s/hidden60s nowcompleted andphasecontinuous with realProvider/service/Chromium/3fakeCLI ownchildren. Full2hNOTyetpass; cumulativejsonl live, finalreport notyetexists. Do not interrupt/restart based on waittimeout. No concurrentbuild/soak another copy. C023 finishedbeforecontinuous/idle phases.
- Primaryscripts/benchmark-real-cli.py prepared uniqueper-roundmarkers/nativePTY+select deadlines/directstream, perrow configversion/binary/launcher/interface hashes; identicalfile/toolprompts reusedbyfutureinstalledsidebar. Syntaxcheckedonly, notrealpilot/runyet; actualnative tool-evidence + config stillneedsinspection. No rawcredentials/TUIprivatebody logs.
- Scopeaudit: currentparagraphMarkdown fixture isnotfullstructuralmixedanswer. Supplementalscripts/benchmark-sustained supportsAGY_SUSTAINED_RICH=1 (32headings/links/lists/quotes/closedfences,millionchars,whole-answerselection andsourcechecks), syntaxcheckednotyetexecuted. Itisvalidation-only and notpartoffrozen18case scripts; create supplementalvalidationcopyusingexactsameout/media hashes andrunaftersoak,3rounds. Do notclaimthisrequirementclosedfromone-headingfixture.
- Remainingfullscope: complete2h/resources/subscriptions, persisted1k/10kstartup, richerfixture3rounds, realthreepaths5cold5warm xshort/read/tool90rows andactualTUInewroundreturn/sidebarcontinuation, isolatedinstalledwindowcompletebuttons/background/Plan/approve/Agent/paths/IME/reload, finalVSIX/install/rollback/releasedocs/AGENTS/audit. Userinstallationstill2.2.0; alluserwindow/task/API/settings/credentials/GUI/IME/clipboard/autostart/MindFS/history/locks untouched.


### Real pilot and final comparison follow-up

Firstnative-read180stimeout unknown retained; originalstream3initvalidationfailure identifiedhelpertop-level instead ofinitnestedfields. Fixedpilot4/4 verifiedactualhigh/cwd/Dangeralways-proceed, nativeRead/Bashcards andview_file/run_command. Warm2native sameproc uniquelytaggedidlefooter5.833/3.198s passed/ownexited. Active86454 actual60native/directStreamrows inoptimization-2.5-real-comparison/report.json, notyetfinal90withinstalledsidebar. Active17703 full2hcontinuous resources; installedstill2.2.0. Full362+c0234separate not366full. ACTIVE-HANDOFF reorganized; earlierdetailarchivedthrough-C023-final-matrix-20261004, no evidence removed.


### Native TUI observation defect corrected

Oldactualcomparison86454 explicitlyinterruptedbyidentitycheckedSIGINTafterverifiedcursor-fragmentobservationdefect; terminal130/all7ownedCLIgroupscheckedexited. ANSIstrip hadsplit SHORT_DONE_250_3 acrossspinnerupdates, falselyreported180stimeout. Neverattributeit tomodel/extensionlatency. Oldreport/rawfailsandinterruptionpreserved. IsolatedpinnedPyPIpyte0.8.2/wcwidth0.2.13 (registrySHAverified,no globalinstall) terminal_screen decoder4/4tests. Actualnative4responsepilot96607 passed unique2warmshort/read/tool+cards/idle+ownexit; newcorrected60comparison outputoptimization-2.5-real-comparison-screen, freshrowsstillpending. 2h17703continues, installed2.2.0 unchanged. Native metric decodedterminalanswer, not physicalpixel guarantee; exact90schema stillrequires30actualinstalledsidebarrows.


## Verified continuation: footer pilot, actual tool-stop, fresh comparison / C024

- 61657 terminal0: corrected native footer-read pilot four passed; native 10.522/8.448s and direct stream 8.049/12.251s, actual Read/view_file evidence and own groups exited. Bottom idle footer + exact marker is readiness; not model first token.
- 63377 terminal0: actual Controller/Repository/originalCLI1.2.16/high/Danger owned tool-stop passed, abort+flush551.552ms. CLI125964 and real detached tool126091 (different PGID) exited; no fallback fixture cleanup. Backend evidence only; installed Stop-button acceptance still pending.
- Fresh corrected comparison handle16285: diagnostics/optimization-2.5-real-comparison-footer-final/report.json, new output, previous failures preserved. Latest11rows passed (native short5cold+5warm and firstreadcold). Same clarified prompts/config; target60native/directStream; installedsidebar30 still required.
- 17703 live poll confirmed no output yet; latest soak sample continuous ~3.15million ms/940loops, no final report yet. Full2h remains pending.
- C024 readonly original agy/Gemini3.8FlashHigh/high candidate generation live40995; snapshot20261004-214825-C024, candidate realfs AgentRegistry100watch-open/close-cycle regression only, not actual Webview panel clicks. Budget180s/one delegation, independent review required.
- Supplemental validation copy prepared (path diagnostics/optimization-2.5-supplemental-path.txt), out/media exact original freeze hashes checked; current richMarkdown and diskstartup scripts copied. Not executed; schedule after fullsoak. Production/build/userinstallation unchanged, installed2.2.0.


### C024 backend watcher cycles independently accepted

Originalagy/Gemini3.8FlashHigh/high/Safe157.670s delivered fenced test; ownCLIexit/snapshot unchanged, originalusage59973/22264/thinking19766/total82237. Code accepted without model planning/approval prose. Independent original1/1; reviewed1/1 after correcting vacuous pending-bound sampling and asserting cancellation of an actually pending file-event debounce on every cycle. Each100cycles/~22s, two realfswatchers peak/zero whenhidden; no hidden callback/timer, late setup/disposal covered. Integrated test/agentWatchCycles.test.js only; production unchanged. Fullsuite count notyetupdated. ActualUIpanel100button gate stillpending. Controlledlowloadtests ran after soakidle/hidden baseline duringcontinuousphase; preserve resourceenvironment qualification. Evidence diagnostics/agy-delegation/C024-agent-watch-cycles/REVIEW.md.


### Corrected native/directStream final60 completed

16285 terminal0; diagnostics/optimization-2.5-real-comparison-footer-final/report.json all60passed, same actualconfiguration/model/high/Danger/CLI1.2.16. Eachscene/path5cold5warm; 36recordedownCLIgroups independentlycheckedno live members after terminal. Native actualRead/Bashcards and Stream actualinit model/cwd/always-proceed verified; eachwarmgrouponePID, cold5PIDs. Partial summary optimization-2.5-real-comparison-footer-summary.json. Primary firstaudit mistakenlyrequired input.txt Read in toolscene; corrected to toolRead tool-output.txt, rawrows unchanged. Native final-ready decodedanswer upperbound and Streamfirstevent are distinctmetrics, not directextensionoverhead. 30installedsidebar samples stillpending; do not run90validator as60gate.

C025 actualReact/JSDOM→Provider→Service→realfsRegistry100panelclicktest candidate generation active71322, originalagy/high/Safe snapshot20261004-215506-C025. No production changes; independent review pending. 17703 full2h continues; no restart/rebuild.


### C025 timeout and primary real panel chain

71322 terminal1; originalagy/high/Safe180.148s deadline/no publiccandidate; ownCLIexitConfirmedtrue/snapshotChangedempty. Failurepreserved, no speculative success/retry. Main test/webview.test.js nowactualReact/JSDOM→Provider→Service→realfsRegistry100buttonclicks passed1/1 in2.152s (91925terminal0), exactsingleopen/close/getdetailrequests, public/privatechildisolation, watchers/pending/timerrelease,noCLIstartup. Test-onlybrainRoot directs onlyown temp logs/syntheticprotocolfixture. Fullregressionnotyetupdated.

New scripts/benchmark-agent-panel.cjs preparesactualChromiumsamechain100clicks+nativeAPI registration instrumentation, activehandle pending below; copied into supplementalvalidation with unchangedfrozenout/media hashes. ReportsHost/Webviewresources, panelintervals/visibility/detail/show/message subscriptions and realfswatchers. NotphysicalVSCodewindow. Controlledtest runs duringsoakcontinuousafteridle/hidden; noteenvironment.

Owned2.5Windowsprofile preparedonly, diagnostics/optimization-2.5-owned-window.json exacttitle AGY2.5OWNEDACCEPTANCE20261004-215830/port9345/sharedowncomparisonworkspace. CandidateNOTinstalled/windowNOTlaunched; usersettings/tasks/GUIunchanged.


### Real Chromium100Agentpanel clicks and sequential remaining probes

RealChromium panel initial assertion failed atcycle0 because visibility listener baselinealready1 fromotherproductionmodule; helperincorrectlyassumedzero. Initialfail optimization-2.5-agent-panel-chromium.json/.txt and initialscript preserved. Corrected relativebaseline version78792terminal0/100cycles, fixedreportpreserved. Further final19844terminal0/100cycles verifiesstablewindowmessage/detail/show/visibilitysubscriptions, exactlyonepanelintervalwhenopen/zeroclosed, realwatchers2open/0closed,pending0,timerunset; noCLIstarted, Hosthandles5before/after. RawJS listener/nodecounts5438/3576include retiredDOM beforeGC, not claimed activeleak or release. Separate postinteractiondiagnosticbrowserGC yields198listeners/160nodes vsbaseline240/175, heap~3.94MB vs5.95MB, proving retiredpanelDOMcollectible; noGCduringclicks/resources. Evidence optimization-2.5-agent-panel-chromium-final.json/.txt; packageout/mediaunchanged. ActualVSCodeAgentgate stillpending.

Prepared scripts/run-supplemental-validation.py active13169 waiting ORIGINALwrapper104643/startTicks7054507 verifiedlive, no timeoutrestart. Afterwrapperexit requires finalmatrixpassed and fullsoak>=7200000ms, then sequentially runs richMarkdown3rounds, actualdiskstartup1k/10k3rounds, finalpanelprobe, noEmittypes/directnodefullsuite(notnpmcompile), decoder andpackagecheck. Output unique optimization-2.5-supplemental-final/report.json, currentlywaiting. Frozenruntime/hashmanifest verified; no originalsourcemutation/build. 17703remainslive. Noactualcandidateinstallation/windowlaunchyet; userstill2.2.0.


### C026 / installed comparison preparation (not executed)

Small originalagy/high/Safe helper request failed172.660s with actual nativeERROR parsing upstreamSSE[DONE], no publicdeliverable, ownexit/snapshotunchanged; noauto retry/configchange. Primary offline summarize-turn whitelist helper2/2passed. Read-only ownedprocess/installhash probe and strictlyownedWindow30samplebenchmark prepared/syntaxchecked; probeverifiedcurrentconfig andzeroownCLI, installationguardstillunexecuted. Windowsprofilefiles copied; no2.5install/windowlaunchyet. ActualUI/CLIbenchmarkresults mustcome fromexecution, notpreparedscript. See C026REVIEW.md and ACTIVE-HANDOFF.


### Installed-window guard tested; fixture probes prepared

WindowsCode-as-node and existingreadonlyPlaywrightmodule successfullyran preparedcomparison script against absent2.5. Installationhashgate stopped before anybrowser/CDP/windowaction: rows0/noinstallation/titleevidence; ownreport preserved under ownedWindowsprofile/sidebar-comparison-install-guard.json, rawstderrdiagnostics/optimization-2.5-installed-guard-check.txt. ExpectedFileNotFound2.5out/extension.js confirmsguard order. OldgenericPowerShellrunnerdoesnotforwardnativeexitstatus, so ownprofile/run-node.ps1 nowASCIIand`exit $LASTEXITCODE`; mainuserconfigunchanged. Neverreuseguardoutputasactualcomparisonpass.

Read-onlyprobe-owned-installed.py nowsupports actualownstopfixturePID/startTicks and publicDONEUSER_INPUT/PLANNER_RESPONSEmarker queryonlywhenmatchingnativeconversationprocessliveinstrictownedworkspace; no rawbody/thinkingexports. Prepared3fixturefiles(open-target/context/stop120s) ownershiphashchecked then movedto diagnostics/optimization-2.5-owned-fixtures-stage, stagedNOTdeployed/executed. Keepingcomparisonworkspacecontentsexactlysameasnative/directStreambeforeinstalledsidebar30; copyfixturesonlyafterall90modelcomparisonrowsfinished. Manifest optimization-2.5-owned-fixtures.json. StophelperwritesonlyownPIDmarker,nofork/network/credentials. No2.5installation/windowlaunch or usertasks/settingschanges.


### 最终两小时首轮失败与采样复现（2026-10-04）

原冻结构建压力进程完整运行两小时，2243次历史/发送循环；最终零错误断言失败，3条错误均为读取`/proc/PID/fd`的EACCES。报告`diagnostics/optimization-2.5-final-matrix/soak-2h.json`，原矩阵状态failures-recorded；补充调度器遵守原门槛退出，尚未执行补验，不计作通过。错误明细缺少当时进程身份，不能仅凭终态报告认定其具体退出原因。

独立以2000个自建sleep短进程复现原采样函数，出现9次同类EACCES；证据`optimization-2.5-proc-race-reproduce.json`。首轮所有成功样本和结束前记录合计4497个进程身份逐一核对，无活进程或僵尸残留，自己的临时目录已清理；证据`optimization-2.5-soak-failed-cleanup-check.json`。覆盖成功记录范围，失败采样可能未记录的身份不冒充已验证。

agy C027只读审查已独立审查，保留其错误推断和纠正说明；C028正在交付带身份复核的采样辅助函数。下一轮仍要求未知错误和持续活进程的权限拒绝为失败；确认退出的竞态记录为显式观测，不伪造零资源。主生产源码、构建与候选包不改动；只修改测试辅助脚本的实时错误来源、失败持续时间、完整marker行游标和独立finally退出证明。修复后须短程验证、冻结脚本并重新完成连续两小时，首轮失败不能追改成通过。2.5.0仍未安装或发布。

### 用户要求避免重复串行等待：并行验收（2026-10-04）

当前两小时复测保持原进程运行；停止尚未执行任何case的等待调度器，补充验收独立并行，不改正式发布门槛。`diagnostics/optimization-2.5-independent-validation-final/`内完整回归378/378、类型检查、真实磁盘1k/10k历史初始化、Chromium100次Agent面板、终端解码、包检查各通过。该报告整体为failures-recorded，因为复杂Markdown三次检查都用了错误的单元素strong断言；原失败保留，改为同时核对全部32个标题后仅重跑该专项，`optimization-2.5-rich-fixed-final/`仍运行。161个生产构建哈希没有变化，不为辅助断言再次启动两小时测试。后续真实窗口与当前资源复测并行，正式发布仍要求全部证据齐全。
