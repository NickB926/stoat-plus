import { contextBridge, ipcRenderer, webFrame } from "electron";

import runtimeSource from "../../../shared/runtime.js?raw";
import hostSource from "../plugins/desktop-host.js?raw";

contextBridge.exposeInMainWorld("__stoatNative", {
  listPlugins: () =>
    ipcRenderer.invoke("plugins:list") as Promise<{ file: string; source: string }[]>,
  openFolder: () => ipcRenderer.invoke("plugins:openFolder"),
  install: (url: string) =>
    ipcRenderer.invoke("plugins:install", url) as Promise<{ file: string }>,
  remove: (file: string) => ipcRenderer.invoke("plugins:remove", file),
  onOpenManager: (callback: () => void) => {
    ipcRenderer.removeAllListeners("plugins:openManager");
    ipcRenderer.on("plugins:openManager", () => callback());
  },
});

// Run the host and the shared runtime in the page itself, before the app's
// scripts, so fetch and WebSocket are wrapped by the time the app uses them.
webFrame
  .executeJavaScript(
    `${hostSource}\n;${runtimeSource}\n;window.__stoatPlusBoot && window.__stoatPlusBoot();`,
  )
  .catch((error) => console.error("[Stoat+] failed to start", error));
