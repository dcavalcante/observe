import type { Logger } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { shouldIgnoreSafely } from "./ignore-predicate.js";

describe("shouldIgnoreSafely", () => {
  it("preserves callback arguments, receiver, and successful decisions", () => {
    const receiver = { marker: "receiver" };
    const warn = vi.fn();
    const logger = { warn } as unknown as Logger;
    const callback = vi.fn(function (
      this: typeof receiver,
      first: string,
      second: number,
    ) {
      return this.marker === first && second === 7;
    });

    expect(
      shouldIgnoreSafely(callback, ["receiver", 7], receiver, logger, "http"),
    ).toBe(true);
    expect(
      shouldIgnoreSafely(callback, ["different", 7], receiver, logger, "http"),
    ).toBe(false);
    expect(callback).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it("fails open and warns once per callback without formatting the error", () => {
    const warn = vi.fn();
    const logger = { warn } as unknown as Logger;
    const error = {
      toString: () => {
        throw new Error("unsafe formatting");
      },
    };
    const callback = vi.fn(() => {
      throw error;
    });

    expect(shouldIgnoreSafely(callback, [], {}, logger, "rpc")).toBe(true);
    expect(shouldIgnoreSafely(callback, [], {}, logger, "rpc")).toBe(true);
    expect(callback).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '"rpc.ignore" threw; continuing without collecting this operation. Later failures are not reported.',
    );
  });

  it("continues to fail open when warning output itself throws", () => {
    const logger = {
      warn: () => {
        throw new Error("logger failure");
      },
    } as unknown as Logger;
    expect(
      shouldIgnoreSafely(
        () => {
          throw new Error("predicate failure");
        },
        [],
        {},
        logger,
        "ws",
      ),
    ).toBe(true);
  });
});
