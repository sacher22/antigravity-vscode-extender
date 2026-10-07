/** No text, paths or credentials cross the telemetry boundary. */
export type RenderProbeKind = "firstText" | "completedText" | "restoredText";
export interface RenderProbeIdentity {
  viewEpoch: number;
  sessionId: string;
  turnId: string;
  generation: number;
  messageId: string;
  stepIndex: number;
  kind: RenderProbeKind;
  minimumSourceLength: number;
}
export interface RenderProbe extends RenderProbeIdentity {token: string;}
export interface RenderReceipt extends RenderProbe {
  receiptToDOMMs: number;
  DOMToFrameMs: number;
  sourceLength: number;
  completed: boolean;
  visible: boolean;
}
export interface RenderMeasurement {
  turnId: string;
  kind: RenderProbeKind;
  hostPostToAckUpperBoundMs: number;
  receiptToDOMMs: number;
  DOMToFrameMs: number;
  sourceLength: number;
}
