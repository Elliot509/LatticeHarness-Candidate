import net from "node:net";
import { describe, expect, it, vi } from "vitest";
import { configureDesktopNetwork } from "../../src/desktop/backend.js";

describe("desktop network compatibility", () => {
  it("selects one system address only for the embedded Electron backend", () => {
    const setter = vi.spyOn(net, "setDefaultAutoSelectFamily").mockImplementation(() => undefined);
    try {
      configureDesktopNetwork(false); expect(setter).not.toHaveBeenCalled();
      configureDesktopNetwork(true); expect(setter).toHaveBeenCalledExactlyOnceWith(false);
    } finally { setter.mockRestore(); }
  });
});
