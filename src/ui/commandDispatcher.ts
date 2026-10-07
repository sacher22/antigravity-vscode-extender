import type { ExtensionMessage } from "../core/types";
import type { AgyService } from "../services/agyService";
import type { EditorActions } from "./editorActions";

export interface CommandDispatcherPorts {
  service: AgyService;
  editorActions: EditorActions;
  executeSlash(
    text: string,
    requestId?: string,
    context?: { code?: string; file?: string },
  ): Promise<boolean>;
  pickHistory(): Promise<void>;
  publishCommands(): void;
  openResource(href: string): Promise<void>;
  confirmRunningDelete(): Promise<boolean>;
  requestContext(contextType: "file" | "problems" | "selection"): Promise<void>;
  copy(text: string): PromiseLike<void>;
  openWorkspace(): PromiseLike<unknown>;
  openSettings(): unknown;
}

export class WebviewCommandDispatcher {
  constructor(private readonly ports: CommandDispatcherPorts) {}

  async dispatch(data: ExtensionMessage): Promise<void> {
    switch (data.command) {
      case "approvePlan": {
        await this.ports.service.approvePlan(data.messageId);
        break;
      }
      case "getAgents": {
        this.ports.service.agents();
        break;
      }
      case "watchAgents": {
        this.ports.service.watchAgents(data.enabled);
        break;
      }
      case "getAgentDetail": {
        await this.ports.service.agentDetail(data.agentId, data.offset);
        break;
      }
      case "pickSession": {
        await this.ports.pickHistory();
        break;
      }
      case "saveDraft": {
        await this.ports.service.saveDraft(data.text, data.attachment);
        break;
      }
      case "ready": {
        await this.ports.service.restoreSelection();
        this.ports.service.sendSnapshot();
        this.ports.publishCommands();
        break;
      }
      case "openNativeCli": {
        await this.ports.service.openNativeCli();
        break;
      }
      case "loadHistory": {
        await this.ports.service.loadHistory(data.before);
        break;
      }
      case "getToolDetail": {
        await this.ports.service.toolDetail(
          data.messageId,
          data.stepIndex,
          data.offset,
        );
        break;
      }
      case "sendMessage": {
        if (
          await this.ports.executeSlash(data.text, data.requestId, {
            code: data.contextCode,
            file: data.filePath,
          })
        )
          break;
        let prompt = data.text.trimStart().startsWith("//")
          ? "用户的普通文字（不是斜杠命令）：\n" +
            data.text.replace(/^(\s*)\/\//, "$1/")
          : data.text;
        if (data.contextCode)
          prompt = `Selected context (${data.filePath || "attached files/selections"}):\n\`\`\`\n${data.contextCode}\n\`\`\`\n\n${data.text}`;
        await this.ports.service.sendMessage(
          prompt,
          data.requestId,
          data.text,
          undefined,
          data.text.trimStart().startsWith("//"),
        );
        break;
      }
      case "reportRender": {
        // Telemetry is one-way and handled before the command bridge.
        break;
      }

      case "openResource": {
        await this.ports.openResource(data.href);
        break;
      }

      case "abortCurrentTurn": {
        await this.ports.service.abortTurn();
        break;
      }

      case "newSession": {
        await this.ports.service.newSession();
        break;
      }
      case "switchSession": {
        await this.ports.service.switchSession(data.conversationId);
        break;
      }
      case "deleteSession": {
        let confirmed = false;
        if (this.ports.service.isSessionRunning(data.conversationId)) {
          confirmed = await this.ports.confirmRunningDelete();
          if (!confirmed) return;
        }
        await this.ports.service.deleteSession(data.conversationId, confirmed);
        break;
      }
      case "changeModel": {
        await this.ports.service.setModel(data.model, data.effort);
        break;
      }
      case "togglePermission": {
        await this.ports.service.setDangerouslySkipPermissions(
          data.dangerouslySkipPermissions,
        );
        break;
      }
      case "togglePlanMode": {
        await this.ports.service.setPlanMode(data.isPlanMode);
        break;
      }
      case "viewDiff": {
        await this.ports.editorActions.showDiffView(
          data.code || "",
          data.filePath,
          data.messageId,
          data.blockIndex,
        );
        break;
      }

      case "requestContext": {
        await this.ports.requestContext(data.contextType);
        break;
      }

      case "applyCodeToEditor": {
        await this.ports.editorActions.applyCode(
          data.previewId,
          data.code || "",
          data.messageId,
          data.blockIndex,
        );
        break;
      }

      case "copyToClipboard": {
        await this.ports.copy(data.text);
        break;
      }

      case "openWorkspace": {
        await this.ports.openWorkspace();
        break;
      }
      case "openSettings": {
        this.ports.openSettings();
        break;
      }
    }
  }
}
