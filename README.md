# Antigravity Extender for VS Code

超级增强版 Antigravity VS Code 扩展。针对原版使用 PTY 终端模拟抓屏导致的吞字、乱码、卡顿和状态丢失问题，采用 Antigravity CLI 原生双向 Stream-JSON 架构全新重写。

## ✨ 核心特性

1. **原生 Stream-JSON 协议驱动**
   - 彻底告别 PTY 终端屏抓，毫秒级打字机流式输出。
   - 原生支持 `init`、`step_update` 与 `result` 事件，精准区分思考过程与工具调用。

2. **⚡ Danger Permission (极客/安全权限模式一键切换)**
   - **Danger Mode (⚡ 极客模式)**：自动注入 `--dangerously-skip-permissions`，让 Agent 全自动执行编译、运行测试、写文件与修复，提供丝滑无人值守编程体验。
   - **Safe Mode (🛡️ 安全模式)**：拦截任何自动命令与系统写操作，需用户授权。
   - 支持在侧边栏顶部直接点击药丸徽章切换，并在 VS Code Settings 中持久化。

3. **🔍 差异对比 (Diff View) 与代码一键应用 (Apply to File)**
   - 代码块右上角提供 **Diff** 按钮：利用 VS Code 原生 `vscode.diff` 打开差异比对面板，清楚审查建议改动。
   - **Apply** 按钮：一键将代码覆盖替换选区或插入到当前打开的编辑器中。

4. **📎 快捷上下文注入 (Context Chips)**
   - **+ Problems**：一键捕获当前工作区所有 Linter 与编译报错，自动附带给 Agent 排查修复。
   - **+ File**：一键浏览并附加指定工作区文件作为问答上下文。

5. **模型与思考深度随时切换**
   - 侧边栏顶部下拉菜单快捷切换：Gemini 3.8 Flash / Gemini 3.7 Flash / Gemini 3.1 Pro。
   - 思考深度实时调节：High / Med / Low。

6. **右键代码快捷操作**
   - 选中编辑器代码右键可呼出：
     - 💡 Antigravity: Explain Code
     - ⚡ Antigravity: Refactor Code
     - 🧪 Antigravity: Generate Unit Tests
     - 🔧 Antigravity: Fix Problems & Bugs

7. **会话管理与跨轮接续**
   - 自动持久化本地会话，支持随时恢复历史多轮上下文（`--conversation <id>`）。
