import type { Logger } from "@nestjs/common";
import { applyUserAttributesSafely } from "./safe-set-attributes.js";

describe("applyUserAttributesSafely", () => {
  it("preserves callback output and its configured receiver", () => {
    const warn = vi.fn();
    const logger = { warn } as unknown as Logger;
    const receiver = { prefix: "request" };
    const callback = function (this: typeof receiver) {
      return { key: this.prefix };
    };
    const store = new Map();

    applyUserAttributesSafely(callback, [], receiver, store, logger, "http");

    expect(store.get("key")).toBe("request");
    expect(warn).not.toHaveBeenCalled();
  });

  it("skips attributes after a callback throws and warns once", () => {
    const warn = vi.fn();
    const logger = { warn } as unknown as Logger;
    const callback = () => {
      throw new Error("attributes failed");
    };
    const store = new Map();

    applyUserAttributesSafely(callback, [], null, store, logger, "http");
    applyUserAttributesSafely(callback, [], null, store, logger, "http");

    expect(store.size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("skips all attributes when Object.entries reads a throwing getter", () => {
    const warn = vi.fn();
    const logger = { warn } as unknown as Logger;
    const attributes = {
      first: "readable",
      get second(): never {
        throw {
          toString: () => {
            throw new Error("format failed");
          },
        };
      },
    };
    const callback = () => attributes;
    const store = new Map();

    applyUserAttributesSafely(callback, [], null, store, logger, "graphql");
    applyUserAttributesSafely(callback, [], null, store, logger, "graphql");

    expect(store.size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("an unprintable error"),
    );
  });
});
