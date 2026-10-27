import type { Logger } from "@nestjs/common";

const reportedCallbacks = new WeakSet<Function>();

function describeFailure(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "an unprintable error";
  }
}

function warnSafely(logger: Logger, message: string): void {
  try {
    logger.warn(message);
  } catch {
    // Diagnostics must not interrupt the application operation either.
  }
}

/**
 * Apply optional user attributes without allowing their callback or returned
 * object's getters to interrupt the operation being instrumented.
 */
export function applyUserAttributesSafely<TArgs extends unknown[]>(
  callback:
    | ((...args: TArgs) => Record<string, unknown> | undefined)
    | undefined,
  args: TArgs,
  receiver: unknown,
  store: Map<any, any>,
  logger: Logger,
  transport: string,
): void {
  if (!callback) {
    return;
  }

  try {
    const attributes = callback.apply(receiver, args);
    if (!attributes) {
      return;
    }

    // Read every value before changing the store, so an enumerable getter
    // that throws cannot leave a partial set of optional attributes behind.
    const entries = Object.entries(attributes);
    for (const [key, value] of entries) {
      store.set(key, value);
    }
  } catch (error) {
    if (!reportedCallbacks.has(callback)) {
      reportedCallbacks.add(callback);
      warnSafely(
        logger,
        `"${transport}.setAttributes" threw; continuing without its attributes. Later failures are not reported: ${describeFailure(error)}`,
      );
    }
  }
}
