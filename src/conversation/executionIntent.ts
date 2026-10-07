/** Detect explicit user requests, never agent-role names in a generated answer. */
export function requestsParallelAgents(text: string): boolean {
  if (
    /(?:不要|禁止|不使用|无需|不用|不需要|取消)\s*(?:多\s*(?:agent|代理)|子代理|subagents?)/i.test(
      text,
    )
  )
    return false;
  return (
    /(?:多\s*(?:agent|代理)|多个子代理|multi[ -]?agents?|multiple\s+(?:sub)?agents?|至少[两二2]个子代理)/i.test(
      text,
    ) &&
    /(?:并行|并发|执行|协作|协同|parallel|concurrent|execute|implement)/i.test(
      text,
    )
  );
}
export const PARALLEL_EXECUTION_INSTRUCTIONS = `执行要求：本轮必须真正使用原生子代理，而不是只列出 Agent A/B 的分工。
先用 invoke_subagent 在同一次调用中启动至少两个子代理，按批准方案分配独立任务，并提供完整任务上下文。保持当前模型与权限；不要另开 CLI 或伪造 Agent 数量。为各子代理划分互不冲突的文件范围，共用文件由主代理最后整合，避免相互覆盖。
启动子代理前不要执行命令或修改项目文件。启动后使用 manage_subagents 获取真实状态和结果；主代理负责协调、整合及最终汇总，不重复包办所有分工。收集到各子代理的任务结果后立即给出最终汇总并结束本轮；已返回结果且处于 idle 的子代理不需要继续等待，不要因为列表标题仍写 active 就反复 list 状态。不要终止其他轮次或不属于本次任务的子代理。若 CLI 无法启动子代理，请明确报告失败并停止，不要降级为单代理实施。\n\n`;
