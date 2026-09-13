import { randomBytes } from "node:crypto";

export const SESSION_COOKIE = "lattice_session";

export interface SessionStore {
  issue(): string;
  check(cookieHeader: string | undefined): boolean;
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (header === undefined || header === "") return cookies;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name !== "") cookies.set(name, value);
  }
  return cookies;
}

export function createSessionStore(): SessionStore {
  const live = new Set<string>();
  return {
    issue() {
      const token = randomBytes(32).toString("hex");
      live.add(token);
      return token;
    },
    check(cookieHeader: string | undefined): boolean {
      const token = parseCookies(cookieHeader).get(SESSION_COOKIE);
      return token !== undefined && live.has(token);
    },
  };
}

export function sessionCookieHeader(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict`;
}

function loopbackHost(host: string): boolean {
  const bare = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return bare === "127.0.0.1" || bare === "[::1]" || bare === "localhost";
}

// Rejects DNS-rebinding and foreign hosts: only loopback Host values pass.
export function checkHost(hostHeader: string | string[] | undefined): boolean {
  if (typeof hostHeader !== "string") return false;
  return loopbackHost(hostHeader.trim().toLowerCase());
}

// POSTs must come from the loopback UI itself (or have no Origin, as with
// curl). Anything else is treated as a foreign origin and rejected.
export function checkOrigin(origin: string | string[] | undefined): boolean {
  if (origin === undefined) return true;
  if (typeof origin !== "string") return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return loopbackHost(url.host.toLowerCase());
}
