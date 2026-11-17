import fs from "node:fs";
import path from "node:path";

import { app, ipcMain, net, shell } from "electron";

import { mainWindow } from "./window";

/** Example plugins shipped with the app, copied to the folder on first run. */
const bundledExamples = import.meta.glob("../../../shared/plugins/*.js", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const MAX_PLUGIN_BYTES = 1024 * 1024;

export function pluginsDir() {
  return path.join(app.getPath("userData"), "plugins");
}

/** Only bare `name.js` files inside the plugins folder. */
function pluginPath(file: string) {
  const name = path.basename(String(file));
  if (!/^[\w.-]+\.js$/i.test(name)) throw new Error(`Bad plugin file name: ${file}`);
  return path.join(pluginsDir(), name);
}

function idFromSource(source: string, fallback: string) {
  const header = /^\s*\/\*\*([\s\S]*?)\*\//.exec(source);
  const id = header && /@id\s+(\S+)/.exec(header[1]);
  return (id ? id[1] : fallback)
    .toLowerCase()
    .replace(/\.js$/, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

function installExamples() {
  const dir = pluginsDir();
  const marker = path.join(dir, ".examples-installed");
  if (fs.existsSync(marker)) return;
  for (const [file, source] of Object.entries(bundledExamples)) {
    const target = path.join(dir, path.basename(file));
    if (!fs.existsSync(target)) fs.writeFileSync(target, source);
  }
  fs.writeFileSync(
    marker,
    "The example plugins were copied here once. Delete this file to copy them again.\n",
  );
}

export function initPlugins() {
  fs.mkdirSync(pluginsDir(), { recursive: true });
  try {
    installExamples();
  } catch (e) {
    console.error("[Stoat+] couldn't copy example plugins", e);
  }
}

/** Show the in-app plugin manager. */
export function openPluginManager() {
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send("plugins:openManager");
}

ipcMain.handle("plugins:list", () => {
  const dir = pluginsDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".js"))
    .sort((a, b) => a.localeCompare(b))
    .flatMap((file) => {
      const full = path.join(dir, file);
      const stat = fs.statSync(full);
      if (!stat.isFile() || stat.size > MAX_PLUGIN_BYTES) return [];
      return [{ file, source: fs.readFileSync(full, "utf8") }];
    });
});

ipcMain.handle("plugins:openFolder", async () => {
  fs.mkdirSync(pluginsDir(), { recursive: true });
  await shell.openPath(pluginsDir());
});

ipcMain.handle("plugins:install", async (_event, url: string) => {
  const parsed = new URL(String(url));
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Only http(s) links can be installed");
  }
  const res = await net.fetch(parsed.toString());
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
  const source = await res.text();
  if (source.length > MAX_PLUGIN_BYTES) throw new Error("That file is too big for a plugin");
  if (!source.includes("definePlugin")) {
    throw new Error("That doesn't look like a Stoat+ plugin (no definePlugin call)");
  }
  const fallback = path.basename(parsed.pathname) || "plugin";
  const id = idFromSource(source, fallback) || "plugin";
  const file = `${id}.js`;
  fs.mkdirSync(pluginsDir(), { recursive: true });
  fs.writeFileSync(pluginPath(file), source);
  return { file };
});

ipcMain.handle("plugins:remove", (_event, file: string) => {
  const target = pluginPath(file);
  if (fs.existsSync(target)) fs.unlinkSync(target);
});
