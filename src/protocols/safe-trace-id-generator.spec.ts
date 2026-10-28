import type { Logger } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { defaultTraceIdGenerator } from "../utils/default-trace-id-generator.util.js";
import { generateTraceIdentitySafely } from "./safe-trace-id-generator.js";

const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("generateTraceIdentitySafely", () => {
  it("preserves successful callback ids, receiver, and arguments", () => {
    const receiver = { id: "custom-id" };
    const warn = vi.fn();
    const callback = vi.fn(function (this: typeof receiver, context: object) {
      expect(context).toBe(input);
      return this.id;
    });
    const input = { marker: true };

    expect(
      generateTraceIdentitySafely(callback, input, receiver, {
        warn,
      } as unknown as Logger),
    ).toEqual({ traceId: "custom-id" });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("uses a valid upstream id with a separate registry key after callback failure", () => {
    const warn = vi.fn();
    const callback = vi.fn(() => {
      throw new Error("private failure detail");
    });

    const identity = generateTraceIdentitySafely(
      callback,
      { headers: { "x-request-id": "upstream-42" } },
      {},
      { warn } as unknown as Logger,
    );

    expect(identity.traceId).toBe("upstream-42");
    expect(identity.registryKey).toMatch(UUID_V7);
    expect(identity.registryKey).not.toBe(identity.traceId);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '"traceIdGenerator" threw; trying a fallback trace id. Later failures are not reported.',
    );
  });

  it("falls back to UUIDv7 when the default generator also throws, without retrying it", () => {
    let headerReads = 0;
    const context = Object.defineProperty({}, "headers", {
      get() {
        headerReads++;
        throw new Error("hostile headers getter");
      },
    });
    const warn = vi.fn();

    const identity = generateTraceIdentitySafely(
      defaultTraceIdGenerator,
      context,
      {},
      { warn } as unknown as Logger,
    );

    expect(identity.traceId).toMatch(UUID_V7);
    expect(identity.registryKey).toMatch(UUID_V7);
    expect(identity.registryKey).not.toBe(identity.traceId);
    expect(headerReads).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("also handles a throwing RPC metadata accessor", () => {
    const context = Object.defineProperty({}, "getMetadata", {
      get() {
        throw new Error("hostile metadata getter");
      },
    });

    const identity = generateTraceIdentitySafely(
      defaultTraceIdGenerator,
      context,
      {},
      { warn: vi.fn() } as unknown as Logger,
    );

    expect(identity.traceId).toMatch(UUID_V7);
    expect(identity.registryKey).toMatch(UUID_V7);
    expect(identity.registryKey).not.toBe(identity.traceId);
  });

  it("warns once per callback and contains warning logger failures", () => {
    const callback = vi.fn(() => {
      throw new Error("private failure detail");
    });
    const warn = vi.fn();
    const logger = { warn } as unknown as Logger;
    const input = {};

    const first = generateTraceIdentitySafely(callback, input, {}, logger);
    const second = generateTraceIdentitySafely(callback, input, {}, logger);

    expect(first.traceId).toMatch(UUID_V7);
    expect(second.traceId).toMatch(UUID_V7);
    expect(first.registryKey).toMatch(UUID_V7);
    expect(second.registryKey).toMatch(UUID_V7);
    expect(warn).toHaveBeenCalledTimes(1);

    expect(() =>
      generateTraceIdentitySafely(
        () => {
          throw new Error("callback");
        },
        input,
        {},
        {
          warn: () => {
            throw new Error("logger");
          },
        } as unknown as Logger,
      ),
    ).not.toThrow();
  });
});
