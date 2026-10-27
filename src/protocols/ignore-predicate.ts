import type { Logger } from "@nestjs/common";

const reportedCallbacks = new WeakSet<Function>();

/** A failed exclusion decision should run the handler without collecting it. */
export function shouldIgnoreSafely<TArgs extends unknown[]>(
  callback: ((...args: TArgs) => boolean) | undefined,
  args: TArgs,
  receiver: unknown,
  logger: Logger,
  protocol: string,
): boolean {
  if (!callback) {
    return false;
  }

  try {
    return callback.apply(receiver, args);
  } catch {
    if (!reportedCallbacks.has(callback)) {
      reportedCallbacks.add(callback);
      try {
        logger.warn(
          `"${protocol}.ignore" threw; continuing without collecting this operation. Later failures are not reported.`,
        );
      } catch {
        // A diagnostic failure must not become an application failure.
      }
    }
    return true;
  }
}
