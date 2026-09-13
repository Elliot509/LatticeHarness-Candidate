import { describe, expect, it } from "vitest";
import {
  checkRuntimeVersion,
  parseNodeVersion,
  RuntimeVersionError,
} from "../../src/platform/runtime.js";

describe("runtime version gate", () => {
  it("accepts the floor version 22.13.0", () => {
    expect(() => checkRuntimeVersion("v22.13.0")).not.toThrow();
  });

  it("accepts newer majors and minors", () => {
    expect(() => checkRuntimeVersion("v22.14.0")).not.toThrow();
    expect(() => checkRuntimeVersion("v24.0.0")).not.toThrow();
  });

  it("rejects versions below the floor", () => {
    expect(() => checkRuntimeVersion("v22.12.0")).toThrow(RuntimeVersionError);
    expect(() => checkRuntimeVersion("v20.19.0")).toThrow(RuntimeVersionError);
    expect(() => checkRuntimeVersion("v21.7.3")).toThrow(RuntimeVersionError);
  });

  it("rejects unparseable versions instead of assuming support", () => {
    expect(() => checkRuntimeVersion("not-a-version")).toThrow(RuntimeVersionError);
    expect(() => parseNodeVersion("v22")).toThrow(RuntimeVersionError);
  });

  it("exposes detected and required versions on the error", () => {
    try {
      checkRuntimeVersion("v20.0.0");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeVersionError);
      const err = error as RuntimeVersionError;
      expect(err.detected).toBe("v20.0.0");
      expect(err.required).toContain("22.13.0");
    }
  });
});
