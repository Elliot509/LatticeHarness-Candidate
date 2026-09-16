// ToolContext carries the optional envOverlay; referenced structurally
// below (no import: tools/types imports platform paths, keep this leaf).

// R1 shared child-environment primitive (F-0009): one explicit allowlist
// base plus an authorized per-call overlay. Runtime secrets are never
// inherited by default: a tool child is a project command, not the runtime
// itself. Both exec and process supervision build through here so the two
// tools cannot drift apart again.
//
// Base preserves only what normal cross-platform execution needs:
// - PATH always (toolchains, system binaries);
// - Unix: HOME (toolchains, caches), LANG + TZ (locale/timezone);
// - Windows: SystemRoot + COMSPEC (process creation, shells), TEMP + TMP.
// Everything else — API keys, tokens, proxies, locale extras — arrives only
// via the explicit overlay the caller authorizes for that dispatch.
const BASE_KEYS: readonly string[] =
  process.platform === "win32"
    ? ["PATH", "SystemRoot", "COMSPEC", "TEMP", "TMP"]
    : ["PATH", "HOME", "LANG", "TZ"];

export function buildChildEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of BASE_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  if (extra !== undefined) {
    for (const [key, value] of Object.entries(extra)) {
      if (typeof value === "string") env[key] = value;
    }
  }
  return env;
}

export function childEnvKeys(): readonly string[] {
  return BASE_KEYS;
}

// Context helper: the overlay a tool call authorizes explicitly. Tool arg
// validation already guarantees string-to-string maps; this is the single
// choke point where ambient inheritance was removed.
export function toolEnvOverlay(
  context: { envOverlay?: Record<string, string> | undefined },
  argsEnv: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const overlay: Record<string, string> = { ...(context.envOverlay ?? {}), ...(argsEnv ?? {}) };
  return Object.keys(overlay).length > 0 ? overlay : undefined;
}
