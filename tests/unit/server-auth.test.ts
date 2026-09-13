import { describe, expect, it } from "vitest";
import {
  checkHost,
  checkOrigin,
  createSessionStore,
  parseCookies,
  sessionCookieHeader,
} from "../../src/server/auth.js";

describe("loopback session auth", () => {
  it("issues opaque tokens validated from cookies only", () => {
    const sessions = createSessionStore();
    const token = sessions.issue();
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(sessions.check(`${"lattice_session"}=${token}`)).toBe(true);
    expect(sessions.check(undefined)).toBe(false);
    expect(sessions.check("lattice_session=nope")).toBe(false);
    expect(parseCookies(undefined).size).toBe(0);
  });

  it("sets HttpOnly SameSite cookies without secrets in URLs", () => {
    const header = sessionCookieHeader("abc");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Strict");
    expect(header).toContain("Path=/");
    expect(header).not.toContain("?");
  });

  it("accepts only loopback hosts", () => {
    expect(checkHost("127.0.0.1:8080")).toBe(true);
    expect(checkHost("localhost:3000")).toBe(true);
    expect(checkHost("[::1]:8080")).toBe(true);
    expect(checkHost("evil.example:8080")).toBe(false);
    expect(checkHost("127.0.0.1.evil.example")).toBe(false);
    expect(checkHost(undefined)).toBe(false);
    expect(checkHost(["a", "b"])).toBe(false);
  });

  it("rejects foreign origins on commands", () => {
    expect(checkOrigin(undefined)).toBe(true);
    expect(checkOrigin("http://127.0.0.1:8080")).toBe(true);
    expect(checkOrigin("http://localhost:3000")).toBe(true);
    expect(checkOrigin("http://[::1]:8080")).toBe(true);
    expect(checkOrigin("https://evil.example")).toBe(false);
    expect(checkOrigin("http://127.0.0.1.evil.example")).toBe(false);
    expect(checkOrigin("javascript:alert(1)")).toBe(false);
    expect(checkOrigin("not-a-url")).toBe(false);
  });
});
