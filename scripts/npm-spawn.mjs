// Cross-platform spawn settings for npm and npm-installed shims.
//
// Windows batch shims (npm.cmd, lattice.cmd) cannot be spawned directly:
// Node/libuv fails with EINVAL unless they run through a shell. POSIX
// systems spawn the plain binary with no shell.
//
// With a shell, Node concatenates file and args without escaping (DEP0190),
// so arguments carrying spaces must be quoted up front. quoteArg wraps such
// arguments in double quotes and refuses embedded quotes rather than
// guessing cmd.exe escaping rules.
/**
 * @param {string} [platform]
 * @returns {string}
 */
export function npmCommand(platform = process.platform) {
  return platform === "win32" ? "npm.cmd" : "npm";
}

/**
 * @param {string} [platform]
 * @returns {boolean}
 */
export function useShell(platform = process.platform) {
  return platform === "win32";
}

/**
 * @param {string} arg
 * @returns {string}
 */
export function quoteArg(arg) {
  if (typeof arg !== "string" || arg === "") {
    throw new Error("pack-test arguments must be non-empty strings");
  }
  if (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(arg)) return arg;
  if (arg.includes('"')) {
    throw new Error(`refusing to quote argument containing a double quote: ${arg}`);
  }
  return `"${arg}"`;
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @returns {string}
 */
export function joinCommand(cmd, args) {
  return [cmd, ...args].map(quoteArg).join(" ");
}
