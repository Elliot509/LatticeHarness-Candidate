export const MIN_NODE_MAJOR = 22;
export const MIN_NODE_MINOR = 13;
export const MIN_NODE_PATCH = 0;

export class RuntimeVersionError extends Error {
  readonly detected: string;
  readonly required: string;
  constructor(detected: string, required: string) {
    super(`Unsupported Node.js runtime ${detected}; Lattice requires ${required}`);
    this.name = "RuntimeVersionError";
    this.detected = detected;
    this.required = required;
  }
}

export function parseNodeVersion(version: string): {
  major: number;
  minor: number;
  patch: number;
} {
  const cleaned = version.startsWith("v") ? version.slice(1) : version;
  const parts = cleaned.split(".").map((p) => Number.parseInt(p, 10));
  const [major = Number.NaN, minor = Number.NaN, patch = Number.NaN] = parts;
  if (
    !Number.isInteger(major) ||
    !Number.isInteger(minor) ||
    !Number.isInteger(patch) ||
    major < 0 ||
    minor < 0 ||
    patch < 0
  ) {
    throw new RuntimeVersionError(version, `>= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.${MIN_NODE_PATCH}`);
  }
  return { major, minor, patch };
}

export function checkRuntimeVersion(version: string = process.version): void {
  const { major, minor, patch } = parseNodeVersion(version);
  const ok =
    major > MIN_NODE_MAJOR ||
    (major === MIN_NODE_MAJOR &&
      (minor > MIN_NODE_MINOR || (minor === MIN_NODE_MINOR && patch >= MIN_NODE_PATCH)));
  if (!ok) {
    throw new RuntimeVersionError(
      version,
      `>= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.${MIN_NODE_PATCH}`,
    );
  }
}
