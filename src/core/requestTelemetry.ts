/** Local durations only. Request observed round trip is an upper bound on inbound delivery. */
export type TrackedRequestCommand = "sendMessage" | "abortCurrentTurn";
export interface RequestProbe {token: string; requestId: string; viewEpoch: number;}
export interface RequestProbeIdentity {requestId: string; viewEpoch: number; command: TrackedRequestCommand; sessionId?: string; turnId?: string; uiQueuedMs: number;}
export interface RequestReceipt extends RequestProbe {postToObservedUpperBoundMs: number;}
export interface RequestMeasurement {requestId: string; command: TrackedRequestCommand; sessionId?: string; turnId?: string; uiQueuedMs: number; postToObservedUpperBoundMs: number; hostReceiptToReportMs: number;}
