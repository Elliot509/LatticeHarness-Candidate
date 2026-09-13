import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Best-effort browser convenience: failure never touches the server.
export async function openBrowser(url: string): Promise<boolean> {
  const target = url;
  try {
    if (process.platform === "win32") {
      await execFileAsync("cmd", ["/c", "start", "", target]);
      return true;
    }
    if (process.platform === "darwin") {
      await execFileAsync("open", [target]);
      return true;
    }
    await execFileAsync("xdg-open", [target]);
    return true;
  } catch {
    return false;
  }
}
