import { decodeImage, storeImage } from "../conversation/imageStore";
import { contextItems } from "../core/contextAttachments";
import { IMAGE_MAX_COUNT, IMAGE_TOTAL_BYTES } from "../core/imageAttachments";
import { RequestReceiptLedger } from "./requestReceiptLedger";
import { EditorActions } from "./editorActions";
import { WebviewCommandDispatcher } from "./commandDispatcher";
import { ContextAdapter } from "./contextAdapter";
import { RenderTelemetryBridge } from "./renderTelemetryBridge";
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { AgyService } from "../services/agyService";
import { SessionStore } from "../core/sessionStore";
import { DiffContentProvider } from "../services/diffProvider";
import { WebviewBridge } from "./webviewBridge";
import {
  commandRegistry,
  parseCommand,
  validateCommand,
  commandDescription,
} from "../commands/registry";
import type { ContextAttachment } from "../core/types";
import { gitChanges } from "../adapters/gitChanges";
import { cliCapabilities } from "../core/cliCapabilities";
import { NativeManagementAdapter } from "../adapters/nativeManagement";
import { schemaValidator } from "../core/schemaValidation";
import { ExtensionMessage, WebviewMessage, SessionMeta } from "../core/types";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "antigravity.chatView";
  private view?: vscode.WebviewView;
  private readonly bridge: WebviewBridge;
  private readonly management = new NativeManagementAdapter();
  private readonly editorActions: EditorActions;
  private readonly dispatcher: WebviewCommandDispatcher;
  private readonly contextAdapter: ContextAdapter;
  private disposed = false;
  private readonly renderTelemetry: RenderTelemetryBridge;

  private readonly requestReceipts = new RequestReceiptLedger();
  private requestViewEpoch = 0;
  private observeRequest(data: ExtensionMessage): void {
    if (
      !this.view ||
      this.view.visible === false ||
      this.disposed ||
      !data.requestTiming ||
      !["sendMessage", "abortCurrentTurn"].includes(data.command) ||
      data.sessionId !== this.agyService.currentSessionMeta?.id
    )
      return;
    const probe = this.requestReceipts.issue({
      requestId: data.requestId!,
      viewEpoch: this.requestViewEpoch,
      command: data.command as "sendMessage" | "abortCurrentTurn",
      sessionId: data.sessionId,
      ...(data.command === "abortCurrentTurn"
        ? { turnId: this.agyService.executionTarget().activeTurnState?.turnId }
        : {}),
      uiQueuedMs: data.requestTiming.uiQueuedMs,
    });
    this.postMessage({ type: "requestObserved", probe });
  }
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly agyService: AgyService,
    private readonly sessionStore: SessionStore,
    private readonly diffProvider: DiffContentProvider,
  ) {
    this.renderTelemetry = new RenderTelemetryBridge(
      (measurement) => this.agyService.recordRender(measurement),
      (turnId, kind) => this.agyService.markRenderPost(turnId, kind),
    );
    this.bridge = new WebviewBridge(
      (data) => this.handleWebviewMessage(data),
      (message) => this.postMessage(message),
      () => this.agyService.currentSessionMeta?.id,
      (data) => this.observeRequest(data),
    );
    this.setupAgyListeners();
    this.editorActions = new EditorActions(
      () => this.agyService.currentSessionMeta,
      this.diffProvider,
      (message) => this.postMessage(message),
    );
    this.contextAdapter = new ContextAdapter(
      () => this.agyService.currentSessionMeta,
      () => this.agyService.prepareOrSwitchSessionUI(),
      (sessionId, attachment) => this.saveContext(sessionId, attachment),
    );
    this.dispatcher = new WebviewCommandDispatcher({
      service: this.agyService,
      editorActions: this.editorActions,
      executeSlash: (...args) => this.executeSlash(...args),
      pickHistory: () => this.pickHistory(),
      publishCommands: () => this.publishCommands(),
      openResource: (href) => this.openResource(href),
      confirmRunningDelete: async () =>
        (await vscode.window.showWarningMessage(
          "该对话仍在运行。停止任务并删除记录？",
          { modal: true },
          "停止并删除",
        )) === "停止并删除",
      requestContext: (type) => this.handleContextRequest(type),
      copy: (text) => vscode.env.clipboard.writeText(text),
      openWorkspace: () =>
        vscode.commands.executeCommand("workbench.action.files.openFolder"),
      openSettings: () =>
        vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "antigravity",
        ),
    });
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;
    const viewEpoch = this.renderTelemetry.newView();
    this.requestViewEpoch = viewEpoch;
    this.requestReceipts.clear();

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        this.extensionUri,
        vscode.Uri.joinPath(this.extensionUri, "media"),
      ],
    };

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    const receiver = webviewView.webview.onDidReceiveMessage((data) => {
      if (this.view !== webviewView || this.disposed) return;
      if (data?.command === "reportRequestLatency") {
        const measurement = this.requestReceipts.accept(
          data.receipt,
          viewEpoch,
        );
        if (measurement) this.agyService.recordRequest(measurement);
        return;
      }
      if (data?.command === "reportRender") {
        this.renderTelemetry.accept(
          data.receipt,
          viewEpoch,
          this.agyService.currentSessionMeta?.id,
          webviewView.visible !== false,
        );
        return;
      }
      void this.bridge.receive(data);
    });

    const visibility = webviewView.onDidChangeVisibility(() => {
      if (this.view !== webviewView || this.disposed) return;
      if (!webviewView.visible) {
        this.agyService.watchAgents(false);
        this.renderTelemetry.hidden();
        this.requestReceipts.clear();
      }
      if (webviewView.visible) {
        this.agyService.sendSnapshot();
      }
    });
    webviewView.onDidDispose(() => {
      receiver.dispose();
      visibility.dispose();
      if (this.view === webviewView) {
        this.agyService.watchAgents(false);
        this.renderTelemetry.clear();
        this.requestReceipts.clear();
        this.view = undefined;
      }
    });
  }

  private setupAgyListeners(): void {
    this.agyService.on("message", (message: WebviewMessage) =>
      this.postMessage(message),
    );
  }

  private imageQueue: Promise<void> = Promise.resolve();
  private handleWebviewMessage(data: ExtensionMessage): Promise<void> {
    if (data.command === "pasteImage") {
      const result = this.imageQueue.then(async () => {
        if (this.disposed) throw new Error("侧栏已关闭。");
        const session =
          this.agyService.currentSessionMeta ||
          this.agyService.prepareOrSwitchSessionUI();
        if (session.id !== data.sessionId)
          throw new Error("会话已切换，请重新粘贴截图。");
        const existing = contextItems(session.attachment).flatMap((item) =>
          item.image ? [item.image] : [],
        );
        const bytes = decodeImage(data.image).length;
        if (
          existing.length >= IMAGE_MAX_COUNT ||
          existing.reduce((sum, item) => sum + item.bytes, 0) + bytes >
            IMAGE_TOTAL_BYTES
        )
          throw new Error("每条消息最多 4 张图片，总计不超过 10 MiB。");
        const directory = this.sessionStore.imageDirectory(session.id);
        const image = await storeImage(directory, data.image);
        if (
          this.disposed ||
          this.agyService.currentSessionMeta?.id !== session.id
        )
          throw new Error("会话已切换，截图没有添加到新会话。");
        session.imageDirectory = directory;
        await this.contextAdapter.sendCodeContext(
          `用户粘贴的图片文件：${JSON.stringify(image.file)}。请使用 view_file 图片查看工具读取实际图像后回答；如果无法查看，请明确说明，不要猜测图片内容。`,
          image.file,
          undefined,
          "截图",
          { image, uri: vscode.Uri.file(image.file).toString() },
        );
      });
      this.imageQueue = result.catch(() => {});
      return result;
    }

    return this.dispatcher.dispatch(data);
  }

  public dispose() {
    this.disposed = true;
    this.renderTelemetry.clear();
    this.requestReceipts.clear();
    this.contextAdapter.dispose();
    this.editorActions.dispose();
  }
  public async createNewSession(): Promise<void> {
    await this.agyService.newSession();
    this.view?.show(true);
  }

  public async sendFromEditor(prompt: string): Promise<void> {
    await vscode.commands.executeCommand(
      "workbench.view.extension.antigravity-sidebar",
    );
    await this.agyService.sendMessage(prompt);
  }

  private publishCommands() {
    const root =
      this.agyService.currentSessionMeta?.workspaceRoot ||
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const skills = root ? this.management.skills(root) : [];
    this.postMessage({
      type: "slashCommands",
      commands: [
        ...commandRegistry.map((c) => ({
          command: "/" + c.name,
          label: c.usage,
          description: commandDescription(c),
          category: "General" as const,
          origin: c.route,
        })),
        ...skills
          .filter(
            (s) =>
              !commandRegistry.some(
                (c) => c.name === s.name || c.aliases?.includes(s.name),
              ),
          )
          .map((s) => ({
            command: "/" + s.name,
            label: "/" + s.name,
            description: `原生技能 · ${s.origin}`,
            category: "Skills" as const,
            origin: "skill",
          })),
      ],
    });
  }
  private async pickHistory(): Promise<void> {
    const origin = this.agyService.currentSessionMeta?.id;
    const sessions = this.sessionStore.getAllSessions();
    const selected = await vscode.window.showQuickPick(
      sessions.map((session) => ({
        label: session.title,
        description: session.id,
        detail: session.workspaceRoot || "旧记录未提供目录",
        sessionId: session.id,
      })),
      {
        placeHolder: `搜索全部历史对话（${sessions.length}）`,
        matchOnDescription: true,
        matchOnDetail: true,
      },
    );
    if (!selected) return;
    if (this.agyService.currentSessionMeta?.id !== origin)
      throw new Error("会话已切换，本次历史选择已取消。");
    await this.agyService.switchSession(selected.sessionId);
  }
  private async executeSlash(
    text: string,
    requestId?: string,
    context?: { code?: string; file?: string },
  ): Promise<boolean> {
    if (!text.trimStart().startsWith("/") || text.trimStart().startsWith("//"))
      return false;
    const service = this.agyService;
    const s = service.currentSessionMeta || service.prepareOrSwitchSessionUI();
    const executor = service.executionTarget();
    const root =
      s?.workspaceRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const skills = root ? this.management.skills(root) : [];
    const parsed = parseCommand(
      text,
      skills.map((skill) => ({
        name: skill.name,
        description: "原生技能",
        usage: `/${skill.name}`,
        route: "skill",
      })),
    );
    if (!parsed) return false;
    const withContext = (prompt: string) =>
      context?.code
        ? `${prompt}\n\nSelected context (${context.file || "attached files/selections"}):\n\`\`\`\n${context.code}\n\`\`\``
        : prompt;
    const { spec, args, tail } = parsed;
    const name = spec.name;
    const requireCurrent = () => {
      if (service.currentSessionMeta?.id !== s.id)
        throw new Error("会话已切换，本次命令不会修改新会话。");
    };
    const result = (value: string, targetSessionId = s.id) =>
      this.postMessage({
        type: "commandResult",
        title: spec.usage,
        text: value,
        requestId,
        sessionId: targetSessionId,
      });
    const native = async (command = text) => {
      const targetSessionId = await service.openNativeCli();
      result(
        executor.nativeHandoffMode === "standalone"
          ? `已打开独立原生终端，未复用侧栏会话或模型/模式参数，请核对原生配置。${command !== "/cli" ? "请在终端输入：" + command : ""}该版本记录协议未验证，不会导入新增回答。`
          : command === "/cli"
            ? "已交接到原生 CLI；可在终端使用原生命令。关闭终端后从历史恢复。"
            : `已交接到原生 CLI。请在终端输入：${command}\n关闭终端后可切回历史并输入 /history sync 同步新增可见文字。`,
        targetSessionId,
      );
    };
    validateCommand(parsed, { busy: service.processing, plan: !!s.planMode });
    const run = (parameters: string[], cached = false) =>
      this.management.run(
        service.getConfig().cliPath,
        root || os.homedir(),
        parameters,
        cached,
      );
    switch (name) {
      case "help":
        result(
          commandRegistry
            .map((c) => `${c.usage} · ${commandDescription(c)}`)
            .join("\n") +
            "\n\n// 开头发送普通文字；原生终端命令不会自动执行。技能发现不覆盖全部插件声明，CLI 决定加载优先级。输入 /skills 查看已发现技能。",
        );
        break;
      case "new":
        await service.newSession();
        break;
      case "stop":
        await executor.abortTurn();
        break;
      case "history":
        if (args[0] === "search") await this.pickHistory();
        else if (args[0] === "sync") await executor.syncNativeHistory();
        else if (args[0]) await service.switchSession(args[0]);
        else
          result(
            this.sessionStore
              .getAllSessions()
              .map((c) => `${c.id} · ${c.title}`)
              .join("\n") || "暂无历史。",
          );
        break;
      case "plan":
        if (tail === "off") await executor.setPlanMode(false);
        else {
          await executor.setPlanMode(true);
          requireCurrent();
          if (tail)
            await executor.sendMessage(withContext(tail), requestId, text);
        }
        break;
      case "approve":
        if (!s?.messages.at(-1)?.id) throw new Error("没有可批准方案。");
        await executor.approvePlan(s.messages.at(-1)!.id!);
        break;
      case "parallel":
        await executor.sendMessage(
          withContext("多 Agent 并行执行以下任务：\n" + tail),
          requestId,
          text,
          true,
        );
        break;
      case "model": {
        const output = await run(["models"], args[0] !== "refresh");
        const models = output
          .split(/\r?\n/)
          .map((l) => l.split(/\s/)[0])
          .filter((m) => /^[-a-zA-Z0-9_.]+$/.test(m) && m.includes("-"));
        this.postMessage({ type: "models", models, sessionId: s?.id });
        requireCurrent();
        if (args[0] && args[0] !== "refresh") {
          if (!models.includes(args[0]))
            throw new Error("原生 CLI 模型列表没有此 ID。");
          await executor.setModel(
            args[0],
            args[0].match(/-(low|medium|high)$/)?.[1] || s?.effort,
          );
        } else result(output);
        break;
      }
      case "effort":
        if (!args.length)
          result(`当前思考深度：${s?.effort}。max 仅支持原生兼容模型。`);
        else {
          await executor.setModel(s!.model, args[0]);
        }
        break;
      case "agents":
        result(await run(["agents"], true));
        break;
      case "agent":
        if (!args.length)
          result(
            `当前主 Agent：${s?.customAgent || "默认"}\nPlan 固定只读 Agent。/agents 列出原生定义；/subagents 查看子代理。`,
          );
        else {
          if (args[0] !== "default") {
            const available = await run(["agents"], true);
            requireCurrent();
            if (
              !available
                .split(/\r?\n/)
                .some((l) => l.trim().split(/\s/)[0] === args[0])
            )
              throw new Error("原生 CLI 没有此 Agent 定义。");
            if (args[0] === "agy-extender-plan-readonly")
              throw new Error("请用 /plan 启用专用只读 Agent。");
          }
          await executor.setExecutionOptions({
            customAgent: args[0] === "default" ? undefined : args[0],
          });
        }
        break;
      case "subagents":
        this.postMessage({ type: "showAgents", sessionId: s?.id });
        break;
      case "subagent":
        if (!s?.agents?.some((a) => a.id === args[0]))
          throw new Error("当前会话不存在此子代理。");
        this.postMessage({
          type: "showAgents",
          sessionId: s.id,
          agentId: args[0],
        });
        break;
      case "open":
        await this.openResource(args[0]);
        break;
      case "copy":
        await vscode.env.clipboard.writeText(
          executor.copyText(args[0] === "loaded" ? "loaded" : "last"),
        );
        result(
          args[0] === "loaded"
            ? "已复制当前已加载的聊天正文；工具原文在各工具详情中查看。"
            : "已复制完整最近回答。",
        );
        break;
      case "context":
        await this.handleContextRequest(
          args[0] as "file" | "selection" | "problems",
        );
        break;
      case "diff":
        result(await this.gitChanges(root, true));
        break;
      case "edited":
        result(await this.gitChanges(root));
        break;
      case "workspace":
        result(
          JSON.stringify(
            {
              root,
              cliVersion:
                executor.currentExecutionProfile?.capabilities?.version,
              cliProtocolStatus:
                executor.currentExecutionProfile?.capabilities?.status,
              requestedModel: executor.currentExecutionProfile?.requestedModel,
              effectiveModel: executor.currentExecutionProfile?.options.model,
              directories: s?.workspaceDirectories,
              additionalDirectories: s?.extraDirectories,
              model: s?.model,
              effort: s?.effort,
              agent: s?.customAgent || "default",
              sandbox: !!s?.sandbox,
              schema: s?.schemaPath,
              mode: s?.planMode ? "只读 Plan" : "普通",
            },
            null,
            2,
          ),
        );
        break;
      case "add-dir":
        {
          if (!root) throw new Error("请先在 VS Code 打开文件夹。");
          const directory = this.commandPath(args[0], root);
          if (!fs.statSync(directory).isDirectory())
            throw new Error("附加路径必须是目录。");
          await executor.setExecutionOptions({
            extraDirectories: Array.from(
              new Set([...(s?.extraDirectories || []), directory]),
            ),
          });
          result(
            `当前会话已添加目录：${directory}。CLI 工具可能读取或修改此目录。`,
          );
        }
        break;
      case "sandbox":
        await executor.setExecutionOptions({ sandbox: args[0] === "on" });
        result(
          "设置已保存；下轮使用原生 --sandbox，具体限制由 CLI 实施，不代表 OS 隔离。",
        );
        break;
      case "schema":
        {
          let schemaPath: string | undefined;
          if (args[0] !== "off") {
            if (!root) throw new Error("请先打开项目。");
            schemaPath = this.commandPath(args[0], root);
            if (fs.statSync(schemaPath).size > 256 * 1024)
              throw new Error("Schema 文件超过 256 KiB。");
            schemaValidator(schemaPath);
            const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
            if (
              typeof schema !== "boolean" &&
              (!schema || typeof schema !== "object" || Array.isArray(schema))
            )
              throw new Error("无效 JSON Schema。");
          }
          await executor.setExecutionOptions({ schemaPath });
          result(
            schemaPath
              ? `最终结果采用 Schema：${schemaPath}`
              : "已关闭结构化输出。",
          );
        }
        break;
      case "usage":
        if (args[0] === "quota" || /^\s*\/quota(?:\s|$)/.test(text))
          await native("/usage");
        else {
          result(
            `会话累计 Token：${s?.totalTokens || 0}\n最近结果：${JSON.stringify(s?.messages.filter((m) => m.role === "assistant").at(-1)?.usage || {})}\n不是账号额度或费用；子代理独立 token 未提供时不可用。`,
          );
        }
        break;
      case "permissions":
        if (args[0] === "native") await native("/permissions");
        else if (!args.length)
          result(
            `普通执行权限：${service.getConfig().dangerouslySkipPermissions ? "Danger" : "Safe"}；Plan 始终只读。逐次审批请使用原生终端，CLI 自动拒绝不是待审批。`,
          );
        else {
          if (s?.planMode) throw new Error("Plan 始终只读，不能切换 Danger。");
          await service.setDangerouslySkipPermissions(args[0] === "danger");
        }
        break;
      case "skills":
        this.management.clear();

        this.publishCommands();
        if (args[0] === "refresh" && !service.processing) {
          requireCurrent();
          await executor.setExecutionOptions({});
        }
        result(
          (root ? this.management.skills(root) : [])
            .map((skill) => `/${skill.name} · ${skill.origin}`)
            .join("\n") +
            "\n这里只列工作区/全局目录中发现的技能；内置和插件声明技能可到原生 /skills 查看。原生 CLI 负责展开。",
        );
        break;
      case "skill":
        if (!args[0] || !skills.some((skill) => skill.name === args[0]))
          throw new Error("请用 /skills 选择已发现技能。");
        if (s?.planMode)
          throw new Error(
            "Plan 不执行技能命令；请先 /plan off，或直接描述规划需求。",
          );
        await executor.sendMessage(
          withContext(
            "/" +
              args[0] +
              (args.length > 1 ? " " + args.slice(1).join(" ") : ""),
          ),
          requestId,
          text,
          undefined,
          true,
        );
        break;
      case "mcp": {
        const operation = args[0] || "list";
        if (operation === "add") {
          await this.openManagementTerminal(["mcp", "add", "--help"], root);
          result(
            "已打开原生管理终端并显示 agy mcp add 帮助；请在终端完成添加。凭据不进入聊天记录。",
          );
          break;
        }
        result(
          await run(["mcp", operation, ...args.slice(1)], operation === "list"),
        );
        if (operation !== "list") {
          requireCurrent();
          this.management.clear();
          await executor.setExecutionOptions({});
        }
        break;
      }
      case "plugins": {
        const operation = args[0] || "list";
        if (["install", "import", "link"].includes(operation)) {
          await this.openManagementTerminal(["plugin", ...args], root);
          result(
            "已在原生管理终端执行插件命令；结束后用 /skills refresh 刷新发现列表，当前会话下轮重新加载配置。",
          );
          requireCurrent();
          await executor.setExecutionOptions({});
          break;
        }
        result(
          await run(
            ["plugin", operation, ...args.slice(1)],
            operation === "list",
          ),
        );
        if (!["list", "validate"].includes(operation)) {
          this.management.clear();
          requireCurrent();
          await executor.setExecutionOptions({});
        }
        break;
      }
      case "artifact": {
        if (args[0] === "review") {
          await native("/artifact");
          break;
        }
        if (!s?.cliConversationId) {
          result("当前对话尚无 CLI Artifact。");
          break;
        }
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(s.cliConversationId))
          throw new Error("无效 CLI 会话 ID。");
        const directory = path.join(
          os.homedir(),
          ".gemini/antigravity-cli/brain",
          s.cliConversationId,
        );
        if (!fs.existsSync(directory)) {
          result("CLI 尚未生成 Artifact 文件。");
          break;
        }
        const entries = fs
          .readdirSync(directory, { withFileTypes: true })
          .filter((e) => e.isFile() && !e.name.startsWith("."))
          .slice(0, 1000);
        if (args[0]) {
          if (!entries.some((e) => e.name === args[0]))
            throw new Error("当前 CLI 会话没有此 Artifact。");
          const file = path.join(directory, args[0]);
          if (fs.realpathSync(file) !== file)
            throw new Error("不支持外部 Artifact 链接。");
          await vscode.commands.executeCommand(
            "vscode.open",
            vscode.Uri.file(file),
          );
        } else
          result(
            entries
              .map((e) => e.name + " · " + path.join(directory, e.name))
              .join("\n") || "CLI 尚未生成 Artifact 文件。",
          );
        break;
      }
      case "capabilities": {
        if (args[0] === "refresh") cliCapabilities.clear();
        const capability = await cliCapabilities.discover(
          service.getConfig().cliPath,
          root || os.homedir(),
        );
        result(
          JSON.stringify(
            {
              ...capability,
              notes: [
                "版本验证来自本机协议样本，不代表未来版本兼容或 OS 隔离。",
                "逐工具审批协议未支持；schema 实验，sandbox 仅证明参数可启动。",
                "缓存按启动文件身份与60秒TTL；包装器不变的转发目标更新依靠TTL或refresh。",
              ],
            },
            null,
            2,
          ),
        );
        break;
      }
      case "diagnostics": {
        if (args[0] === "clear") {
          service.clearDiagnostics();
          this.renderTelemetry.clear();
          this.requestReceipts.clear();
          result("宿主诊断时间线已清空；聊天记录不受影响。");
          break;
        }
        const report = {
          ...service.diagnosticsSnapshot(),
          renderDelivery: this.renderTelemetry.stats(),
          requestDelivery: this.requestReceipts.stats(),
        };
        if (args[0] !== "export") {
          result(JSON.stringify(report, null, 2));
          break;
        }
        const target = await vscode.window.showSaveDialog({
          saveLabel: "导出诊断",
          filters: { JSON: ["json"] },
        });
        if (!target) {
          result("已取消导出，诊断时间线仍保留。");
          break;
        }
        await vscode.workspace.fs.writeFile(
          target,
          Buffer.from(JSON.stringify(report, null, 2) + "\n"),
        );
        result("宿主诊断时间线已导出。该记录不包含模型内部或界面绘制时间。");
        break;
      }
      case "version":
        result(await run(["--version"], true));
        break;
      case "install":
      case "mic-serve":
        await this.openManagementTerminal(
          [name, ...(args.length ? args : ["--help"])],
          root,
        );
        result("已打开原生管理终端。");
        break;
      case "changelog":
        result(await run(["changelog"], true));
        break;
      case "update":
        await this.openManagementTerminal(["update"], root);
        result(
          "已在原生终端启动 CLI 更新；完成后重新加载扩展并核对版本兼容性。",
        );
        break;
      default:
        if (spec.route === "skill") {
          if (s?.planMode)
            throw new Error("Plan 不执行技能命令，请先 /plan off。");
          await executor.sendMessage(
            withContext(text),
            requestId,
            text,
            undefined,
            true,
          );
        } else await native();
    }
    return true;
  }
  private async openManagementTerminal(args: string[], root?: string) {
    const { BinaryResolver } = await import("../core/binaryResolver");
    const cli = await BinaryResolver.resolveCliPath(
      this.agyService.getConfig().cliPath,
    );
    if (process.platform === "win32") {
      vscode.window
        .createTerminal({
          name: "Antigravity 管理",
          cwd: root,
          shellPath: cli,
          shellArgs: args,
        })
        .show();
    } else {
      const terminal = vscode.window.createTerminal({
        name: "Antigravity 管理",
        cwd: root,
      });
      const quote = (value: string) =>
        "'" + value.replace(/'/g, "'\"'\"'") + "'";
      terminal.sendText([cli, ...args].map(quote).join(" "), true);
      terminal.show();
    }
  }
  private commandPath(value: string, root: string): string {
    if (value.startsWith("~/")) value = path.join(os.homedir(), value.slice(2));
    return path.resolve(root, value);
  }
  private async gitChanges(root?: string, diff = false): Promise<string> {
    if (!root) throw new Error("请先打开项目。");
    return gitChanges(root, diff);
  }

  private async openResource(href: string): Promise<void> {
    await this.editorActions.openResource(href);
  }

  private resolveFileReference(href: string): {
    filePath?: string;
    line?: number;
    column?: number;
  } {
    return this.editorActions.resolveFileReference(href);
  }

  private async handleContextRequest(
    type: "problems" | "git" | "file" | "selection",
  ): Promise<void> {
    await this.contextAdapter.request(type);
  }

  public async sendCodeContext(
    code: string,
    fileName?: string,
    lineCount?: number,
    title?: string,
    details?: Partial<ContextAttachment>,
  ): Promise<void> {
    await this.contextAdapter.sendCodeContext(
      code,
      fileName,
      lineCount,
      title,
      details,
    );
  }

  private async saveContext(
    sessionId: string,
    attachment: NonNullable<SessionMeta["attachment"]>,
  ): Promise<void> {
    if (this.disposed) throw new Error("上下文操作已结束。");
    if (this.agyService.currentSessionMeta?.id !== sessionId)
      throw new Error("会话已切换，请重新添加文件上下文。");
    const runner = this.agyService.executionTarget();
    const session = runner.currentSessionMeta;
    if (!session || session.id !== sessionId)
      throw new Error("会话已切换，请重新添加文件上下文。");
    await runner.saveDraft(session.draft || "", attachment);
    if (this.disposed || this.agyService.currentSessionMeta?.id !== sessionId)
      return;
    this.view?.show(true);
    this.postMessage({
      type: "setContext",
      sessionId,
      attachment,
      code: attachment.code,
      title: attachment.title,
    });
  }

  private postMessage(message: WebviewMessage): void {
    if (this.view && !this.disposed) {
      // Hidden output lives in the execution repository; showing the view sends a fresh snapshot.
      if (this.view.visible === false && message.sequence !== undefined) return;
      const renderedMessage =
        this.view.visible === false
          ? message
          : this.renderTelemetry.decorate(message);
      this.view.webview.postMessage(renderedMessage);
    }
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = `${Date.now()}${Math.random().toString(36).slice(2)}`;
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "chat.css"),
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "chat.js"),
    );
    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"><link href="${styleUri}" rel="stylesheet"><title>Antigravity</title></head><body><div id="root"></div><script nonce="${nonce}" src="${scriptUri}"></script></body></html>`;
  }
}
