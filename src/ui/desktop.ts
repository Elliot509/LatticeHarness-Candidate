export interface DesktopBridge {
  platform: string;
  protocol: number;
  selectProject(): Promise<{ workspace: string } | null>;
}

export function desktopBridge(): DesktopBridge | null {
  const bridge = (window as Window & { latticeDesktop?: DesktopBridge }).latticeDesktop;
  return bridge?.protocol === 1 && typeof bridge.selectProject === "function" ? bridge : null;
}
