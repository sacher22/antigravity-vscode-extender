import { createHash } from "crypto";
import * as fs from "fs";
import type { AgyProcessOptions } from "../core/agyProcessManager";

import type { CliCapabilities } from "../core/cliCapabilities";

export interface ExecutionProfile {
  readonly capabilities?: Readonly<CliCapabilities>;
  readonly requestedModel: string;
  readonly options: Readonly<AgyProcessOptions>;
  readonly schemaFingerprint?: string;
  readonly signature: string;
}

/** Capture resolved policy once; mutable settings cannot change a submitted turn. */
export function executionProfile(
  requestedModel: string,
  options: AgyProcessOptions,
  capabilities?: Readonly<CliCapabilities>,
): ExecutionProfile {
  const directories = Object.freeze([...(options.additionalDirectories || [])]);
  const resolved = Object.freeze({
    ...options,
    additionalDirectories: directories as unknown as string[],
  });
  const schemaFingerprint = options.schemaPath
    ? createHash("sha256")
        .update(fs.readFileSync(options.schemaPath))
        .digest("hex")
    : undefined;
  const { conversationId: _, createProject: __, ...configuration } = resolved;
  return Object.freeze({
    requestedModel,
    capabilities,
    options: resolved,
    schemaFingerprint,
    signature: JSON.stringify([configuration, schemaFingerprint]),
  });
}
