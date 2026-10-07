export function failureText(error: unknown): string {
  try {
    const text = error instanceof Error ? error.message : String(error);
    return String(text).slice(0, 2048);
  } catch {
    return '未知错误';
  }
}

export class ExecutionClaimReleaseError extends Error {
  constructor(cause: unknown) {
    super(`执行锁释放未完成：${failureText(cause)}。请点击停止重试，执行声明仍保留。`, { cause });
    this.name = 'ExecutionClaimReleaseError';
  }
}

export function combineOperationFailures(primary: unknown, cleanup: unknown): Error {
  if (cleanup === undefined || primary === cleanup) {
    return primary instanceof Error
      ? primary
      : new Error(failureText(primary), { cause: primary });
  }

  if (primary === undefined) {
    return cleanup instanceof Error
      ? cleanup
      : new Error(failureText(cleanup), { cause: cleanup });
  }

  return new AggregateError(
    [primary, cleanup],
    `${failureText(primary)}；${failureText(cleanup)}`,
    { cause: primary }
  );
}
