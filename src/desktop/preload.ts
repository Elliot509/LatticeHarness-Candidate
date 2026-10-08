// P0 preload: narrow validated bridge only. The renderer reaches the
// backend exclusively through authenticated same-origin HTTP/SSE; no
// filesystem, shell, database or Node access is exposed here.
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("latticeDesktop", {
  platform: process.platform,
  protocol: 1,
  selectProject: () => ipcRenderer.invoke("lattice:select-project"),
});
