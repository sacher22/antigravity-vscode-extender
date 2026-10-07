/** Cancellation is an operation outcome, not an execution failure. */
export class OperationCancelledError extends Error {
  constructor(message = "操作已取消。") {
    super(message);
    this.name = "OperationCancelledError";
  }
}

/** A kill was requested, but the process/pipe did not close within the grace period. */
export class ProcessExitUnconfirmedError extends Error {
  constructor(message = "CLI 进程组退出未确认；执行锁仍保留，请停止重试后再执行。") {super(message);this.name = "ProcessExitUnconfirmedError";}
}

export class ProbeExitUnconfirmedError extends ProcessExitUnconfirmedError {
  constructor() {
    super(
      "CLI 版本探测退出未确认，已阻止执行。请检查 CLI 包装器及其子进程后重试。",
    );
    this.name = "ProbeExitUnconfirmedError";
  }
}
