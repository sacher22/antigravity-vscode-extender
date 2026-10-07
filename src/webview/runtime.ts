import type { ExtensionMessage, WebviewMessage } from "../core/types";
import { ViewStore } from "./state";
import { RequestClient } from "./requestClient";
import { RenderObserver } from "./renderObserver";

declare function acquireVsCodeApi(): {
  postMessage(data: unknown): void;
  getState(): unknown;
  setState(data: unknown): void;
};

const vscode = acquireVsCodeApi();

const client: RequestClient = new RequestClient(
  (data) => vscode.postMessage(data),
  () => store.state.session?.id,
);

export const request = (data: Partial<ExtensionMessage>): Promise<void> =>
  client.request(data);

export const renderSourceId = (messageId: string, stepIndex: number) =>
  "render-source-" + encodeURIComponent(messageId) + ":" + stepIndex;

export const renderObserver = new RenderObserver(
  (receipt) => vscode.postMessage({ command: "reportRender", receipt }),
  () => store.state.session?.id,
);

window.addEventListener("pagehide", () => {
  client.dispose();
  renderObserver.clear();
});

export const store: ViewStore = new ViewStore((d) => request(d), (message, state) => {
  renderObserver.selectSession(state.session?.id);
  if (message.renderProbe) {
    const probe = message.renderProbe;
    renderObserver.receive(probe);
    // A restored snapshot can leave memoized source blocks unchanged. Inspect
    // that exact committed block once instead of re-parsing its Markdown.
    if (probe.kind === "restoredText")
      requestAnimationFrame(() => {
        if (store.state.session?.id !== probe.sessionId) return;
        const source = document.getElementById(
          renderSourceId(probe.messageId, probe.stepIndex),
        );
        if (source)
          renderObserver.domUpdated(
            probe.messageId,
            probe.stepIndex,
            Number(source.dataset.sourceLength),
            source.dataset.sourceCompleted === "true",
            source,
          );
      });
  }
});

window.addEventListener("scroll", () => renderObserver.retryVisible(), {
  capture: true,
  passive: true,
});
window.addEventListener("resize", () => renderObserver.retryVisible());
document.addEventListener("toggle", () => renderObserver.retryVisible(), true);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") renderObserver.clear();
  else renderObserver.retryVisible();
});

window.addEventListener("message", (event: MessageEvent<WebviewMessage>) => {
  const m = event.data;
  client.receive(m);
  store.receive(m);
  if (m.type === "previewReady")
    window.dispatchEvent(new CustomEvent("code-preview", { detail: m }));
  if (m.type === "agentDetail")
    window.dispatchEvent(new CustomEvent("agent-detail", { detail: m }));
  if (
    m.type === "showAgents" &&
    (!m.sessionId || m.sessionId === store.state.session?.id)
  )
    window.dispatchEvent(new CustomEvent("show-agents", { detail: m }));
  if (m.type === "toolDetail")
    window.dispatchEvent(new CustomEvent("tool-detail", { detail: m }));
});
