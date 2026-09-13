import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  latticeDbPath,
  resolveDataDir,
} from "../../src/platform/paths.js";

describe("resolveDataDir", () => {
  it("honors LATTICE_DATA_DIR override and resolves relatives", () => {
    const resolved = resolveDataDir({
      env: { LATTICE_DATA_DIR: "rel/dir" },
      platform: "linux",
      homedir: "/home/user",
    });
    expect(path.isAbsolute(resolved)).toBe(true);
    expect(resolved.endsWith(path.join("rel", "dir"))).toBe(true);
  });

  it("uses XDG_DATA_HOME on linux", () => {
    expect(
      resolveDataDir({
        env: { XDG_DATA_HOME: "/data/xdg" },
        platform: "linux",
        homedir: "/home/user",
      }),
    ).toBe(path.join("/data/xdg", "lattice"));
  });

  it("falls back to ~/.local/share/lattice on linux", () => {
    expect(
      resolveDataDir({ env: {}, platform: "linux", homedir: "/home/user" }),
    ).toBe(path.join("/home/user", ".local", "share", "lattice"));
  });

  it("uses LOCALAPPDATA on windows", () => {
    expect(
      resolveDataDir({
        env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
        platform: "win32",
        homedir: "C:\\Users\\u",
      }),
    ).toBe(path.join("C:\\Users\\u\\AppData\\Local", "Lattice"));
  });

  it("falls back under the home directory on windows without env", () => {
    const dir = resolveDataDir({ env: {}, platform: "win32", homedir: "D:\\home\\u" });
    expect(dir).toBe(path.join("D:\\home\\u", "AppData", "Local", "Lattice"));
  });

  it("keeps spaces, accents and unicode intact", () => {
    const home = "/home/usuário com espaços/日本語";
    const dir = resolveDataDir({ env: {}, platform: "linux", homedir: home });
    expect(dir).toBe(path.join(home, ".local", "share", "lattice"));
    const db = latticeDbPath(path.join(home, "dados lattice", "café"));
    expect(db.endsWith("lattice.db")).toBe(true);
    expect(db).toContain("café");
  });

  it("derives the db file inside the resolved absolute data dir", () => {
    const dataDir = path.join(path.parse(process.cwd()).root, "var", "lib", "lattice");
    const db = latticeDbPath(dataDir);
    expect(path.isAbsolute(db)).toBe(true);
    expect(path.basename(db)).toBe("lattice.db");
    expect(db).toBe(path.join(path.resolve(dataDir), "lattice.db"));
    expect(path.relative(path.resolve(dataDir), db)).toBe("lattice.db");
  });

  it("resolves a relative data dir against the working directory", () => {
    const db = latticeDbPath(path.join("rel", "data"));
    expect(path.isAbsolute(db)).toBe(true);
    expect(db).toBe(path.join(process.cwd(), "rel", "data", "lattice.db"));
  });
});
