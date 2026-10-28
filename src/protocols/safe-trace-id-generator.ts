import type { Logger } from "@nestjs/common";
import { defaultTraceIdGenerator } from "../utils/default-trace-id-generator.util.js";
import { uuidv7 } from "../utils/uuid-v7.util.js";

const reportedCallbacks = new WeakSet<Function>();

export interface SafeTraceIdentity {
  /** The trace id exposed to handlers and reported in the snapshot. */
  traceId: string | undefined;
  /** A private registry key used only after a custom generator fails. */
  registryKey?: string;
}

/** Generate a trace id without allowing instrumentation to stop the request. */
export function generateTraceIdentitySafely<TContext>(
  callback: ((context: TContext) => string) | undefined,
  context: TContext,
  receiver: unknown,
  logger: Logger,
): SafeTraceIdentity {
  try {
    if (callback) {
      return { traceId: callback.apply(receiver, [context]) };
    }
  } catch {
    if (callback && !reportedCallbacks.has(callback)) {
      reportedCallbacks.add(callback);
      try {
        logger.warn(
          '"traceIdGenerator" threw; trying a fallback trace id. Later failures are not reported.',
        );
      } catch {
        // A diagnostic failure must not become an application failure.
      }
    }
  }

  let traceId: string | undefined;
  if (callback !== defaultTraceIdGenerator) {
    try {
      traceId = defaultTraceIdGenerator(context);
    } catch {
      // The request/context may expose throwing headers or metadata getters.
    }
  }

  if (traceId === undefined) {
    try {
      traceId = uuidv7();
    } catch {
      return { traceId: undefined };
    }
  }

  try {
    // A fallback may adopt an upstream id. Keep registry state isolated even
    // when concurrent operations arrive with the same propagated value.
    const registryKey = uuidv7();
    return { traceId, registryKey };
  } catch {
    // If a private key cannot be minted, run the business operation untraced.
    return { traceId: undefined };
  }
}
