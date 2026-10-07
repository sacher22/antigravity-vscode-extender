import type { ToolCallItem } from '../core/types';

export interface PendingTool {
  tool: ToolCallItem;
  size: number;
}

export function* textFragments(source: string): Generator<string> {
  const len = source.length;
  let start = 0;
  while (start < len) {
    let end = Math.min(start + 16384, len);
    if (end < len) {
      const prev = source.charCodeAt(end - 1);
      const next = source.charCodeAt(end);
      if (prev >= 0xd800 && prev <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        end--;
      }
    }
    yield source.slice(start, end);
    start = end;
  }
}

export function* toolBatches(items: Iterable<PendingTool>): Generator<ToolCallItem[]> {
  let batch: ToolCallItem[] = [];
  let sum = 0;
  for (const item of items) {
    const { tool, size } = item;
    if (!Number.isSafeInteger(size) || size <= 0 || size > 196608) {
      throw new RangeError(`Invalid tool size: ${size}`);
    }
    if (batch.length > 0 && (batch.length >= 32 || sum + size > 196608)) {
      yield batch;
      batch = [];
      sum = 0;
    }
    batch.push(tool);
    sum += size;
  }
  if (batch.length > 0) {
    yield batch;
  }
}
