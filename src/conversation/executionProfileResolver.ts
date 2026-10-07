import type { AntigravityConfig, SessionMeta } from "../core/types";
import type { CliCapabilities } from "../core/cliCapabilities";
import { executionProfile, type ExecutionProfile } from "./executionProfile";
import { ensurePlanAgent } from "../core/planAgent";

const MODEL_EFFORTS: Record<string, string[]> = {
  "gemini-3.8-flash": ["low", "medium", "high"],
  "gemini-3.7-flash": ["low", "medium", "high"],
  "gemini-3.6-flash": ["low", "medium", "high"],
  "gemini-3.1-pro": ["low", "high"],
};

export function resolveModel(
  model: string,
  requestedEffort: string,
): { familyModel: string; effectiveModel: string; effort: string } {
  const match = model.match(/^(.*)-(low|medium|high)$/);
  const family = match?.[1] || model;
  const supported = MODEL_EFFORTS[family];
  if (requestedEffort === "max" && (supported || match))
    throw new Error(
      "该模型通过 low/medium/high 后缀选择深度，未验证 max 支持；没有降级为 high。",
    );
  if (supported && !supported.includes(requestedEffort))
    throw new Error("当前模型不支持该思考深度。");
  const effort = supported?.includes(requestedEffort)
    ? requestedEffort
    : match?.[2] || requestedEffort;
  return {
    familyModel: supported ? family + "-high" : model,
    effectiveModel: supported ? family + "-" + effort : model,
    effort,
  };
}

export function resolveExecutionProfile(
  input: {
    session: SessionMeta;
    config: Readonly<AntigravityConfig>;
    cliPath: string;
    workspace: {
      root: string;
      directories: string[];
    };
    capabilities?: Readonly<CliCapabilities>;
  },
  planAgent: (
    home?: string,
    workspaces?: string[],
  ) => string = ensurePlanAgent,
): ExecutionProfile {
  const { session, config, cliPath, workspace, capabilities } = input;
  const r = resolveModel(session.model, session.effort);
  return executionProfile(
    session.model,
    {
      cliPath,
      cwd: workspace.root,
      model: r.effectiveModel,
      effort: r.effort,
      dangerouslySkipPermissions:
        !session.planMode && config.dangerouslySkipPermissions,
      agent: session.planMode
        ? planAgent(undefined, workspace.directories)
        : session.customAgent,
      sandbox: !!session.sandbox,
      schemaPath: session.planMode ? undefined : session.schemaPath,
      isPlanMode: !!session.planMode,
      conversationId: session.cliConversationId,
      createProject: !session.cliConversationId,
      additionalDirectories: workspace.directories,
    },
    capabilities,
  );
}
