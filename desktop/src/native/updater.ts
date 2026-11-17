import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { app, dialog, net, shell } from "electron";

import { mainWindow } from "./window";

/**
 * Stoat+ desktop updates: checks the latest GitHub release for a newer
 * Windows zip, downloads it, and swaps it into the install folder after
 * the app quits. Settings and plugins live in AppData, so they're kept.
 */

export const STOATPLUS_VERSION = __STOATPLUS_VERSION__;
const REPO = __STOATPLUS_REPO__;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const ZIP_PATTERN = /desktop-windows.*\.zip$/i;

type Release = { version: string; notes: string; zipUrl: string; pageUrl: string };
type State = { lastCheck?: number; skipped?: string };

let busy = false;

function statePath() {
  return path.join(app.getPath("userData"), "stoatplus-updates.json");
}

function readState(): State {
  try {
    return JSON.parse(fs.readFileSync(statePath(), "utf8"));
  } catch {
    return {};
  }
}

function writeState(patch: State) {
  try {
    fs.writeFileSync(statePath(), JSON.stringify({ ...readState(), ...patch }));
  } catch (e) {
    console.warn("[Stoat+] couldn't save update state", e);
  }
}

/** Newer than ours? Compares dotted numbers: 1.10.0 > 1.9.3. */
export function isNewer(candidate: string, current = STOATPLUS_VERSION) {
  const parts = (v: string) => {
    const p = v.replace(/^v/, "").split(/[.\-+]/).slice(0, 3).map((x) => parseInt(x, 10) || 0);
    while (p.length < 3) p.push(0);
    return p;
  };
  const a = parts(candidate);
  const b = parts(current);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

async function fetchLatest(): Promise<Release | null> {
  const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (res.status === 404) return null; // no releases yet
  if (!res.ok) throw new Error(`GitHub said HTTP ${res.status}`);
  const release = await res.json();
  const zip = (release.assets ?? []).find((a: { name: string }) => ZIP_PATTERN.test(a.name));
  if (!zip || !release.tag_name) return null;
  return {
    version: String(release.tag_name).replace(/^v/, ""),
    notes: release.body ?? "",
    zipUrl: zip.browser_download_url,
    pageUrl: release.html_url ?? `https://github.com/${REPO}/releases`,
  };
}

/** Self-updating only works for the packaged Windows app in a folder we can write to. */
function canSelfUpdate() {
  if (!app.isPackaged || process.platform !== "win32") return false;
  try {
    fs.accessSync(path.dirname(process.execPath), fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Look for an update. Automatic checks run at most every few hours and
 * respect "skip this version"; manual checks always run and report back.
 */
export async function checkForUpdates(manual: boolean) {
  if (busy) return;
  const state = readState();
  if (!manual && Date.now() - (state.lastCheck ?? 0) < CHECK_EVERY_MS) return;
  writeState({ lastCheck: Date.now() });

  let release: Release | null;
  try {
    release = await fetchLatest();
  } catch (e) {
    console.warn("[Stoat+] update check failed", e);
    if (manual) {
      dialog.showMessageBox(mainWindow, {
        type: "error",
        title: "Stoat+",
        message: "Couldn't check for updates",
        detail: String((e as Error)?.message ?? e),
      });
    }
    return;
  }

  if (!release || !isNewer(release.version)) {
    if (manual) {
      dialog.showMessageBox(mainWindow, {
        type: "info",
        title: "Stoat+",
        message: `Stoat+ ${STOATPLUS_VERSION} is the latest version`,
      });
    }
    return;
  }
  if (!manual && state.skipped === release.version) return;

  const selfUpdate = canSelfUpdate();
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: "info",
    title: "Stoat+ update",
    message: `Stoat+ ${release.version} is available`,
    detail:
      `You have ${STOATPLUS_VERSION}. ` +
      (selfUpdate
        ? "Stoat+ will download it, restart, and keep your login and plugins."
        : "Download it from the release page.") +
      (release.notes.trim() ? `\n\n${release.notes.trim().slice(0, 1200)}` : ""),
    buttons: [selfUpdate ? "Update and restart" : "Open release page", "Later", "Skip this version"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });

  if (response === 2) writeState({ skipped: release.version });
  if (response !== 0) return;
  if (!selfUpdate) {
    shell.openExternal(release.pageUrl);
    return;
  }
  await installUpdate(release);
}

async function installUpdate(release: Release) {
  busy = true;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "stoat-plus-update-"));
  try {
    // 1. download
    const zipFile = path.join(work, "update.zip");
    const res = await net.fetch(release.zipUrl);
    if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
    const total = Number(res.headers.get("content-length")) || 0;
    let done = 0;
    const body = Readable.fromWeb(res.body as never);
    body.on("data", (chunk: Buffer) => {
      done += chunk.length;
      if (total) mainWindow?.setProgressBar(done / total);
    });
    await pipeline(body, fs.createWriteStream(zipFile));
    mainWindow?.setProgressBar(2); // indeterminate while unpacking

    // 2. unpack with Windows' built-in tar (bsdtar reads zip files)
    const unpacked = path.join(work, "app");
    fs.mkdirSync(unpacked);
    const tar = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    await new Promise<void>((resolve, reject) => {
      const p = spawn(tar, ["-xf", zipFile, "-C", unpacked], { windowsHide: true });
      p.on("error", reject);
      p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`Unpacking failed (tar exit ${code})`))));
    });
    const exeName = path.basename(process.execPath);
    const source = findAppFolder(unpacked, exeName);
    if (!source) throw new Error(`The download doesn't contain ${exeName}`);

    // 3. hand over to a script that waits for us to quit, copies the files, and restarts
    const installDir = path.dirname(process.execPath);
    const script = path.join(work, "apply-update.ps1");
    fs.writeFileSync(
      script,
      [
        "param([int]$AppPid, [string]$Source, [string]$Target, [string]$Exe, [string]$Work)",
        "$log = Join-Path $Work 'update.log'",
        "Start-Transcript -Path (Join-Path $Work 'helper.log') -Force | Out-Null",
        "Wait-Process -Id $AppPid -Timeout 120 -ErrorAction SilentlyContinue",
        "Start-Sleep -Seconds 2",
        // Copy over the old files but never delete anything: the app may sit in a shared folder.
        "robocopy $Source $Target /E /IS /IT /R:20 /W:1 /NP /LOG:$log | Out-Null",
        "$ok = $LASTEXITCODE -lt 8",
        "Start-Process (Join-Path $Target $Exe)",
        "Stop-Transcript | Out-Null",
        "if ($ok) { Start-Sleep -Seconds 5; Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue }",
      ].join("\r\n"),
    );
    console.log("[Stoat+] update ready, handing over to", script);
    // Launched through `start` so PowerShell gets its own (hidden) console and outlives us.
    // A plain detached spawn leaves PowerShell without a console, and it silently exits.
    const q = (s: string) => `"${s}"`;
    const helper = spawn(
      "cmd.exe",
      [
        "/d", "/c", "start", '""', "/min", "powershell.exe",
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", q(script),
        "-AppPid", String(process.pid), "-Source", q(source), "-Target", q(installDir),
        "-Exe", q(exeName), "-Work", q(work),
      ],
      { detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true },
    );
    helper.on("error", (e) => console.warn("[Stoat+] update helper failed to start", e));
    helper.unref();
    console.log("[Stoat+] update helper pid", helper.pid, "- quitting");
    app.quit();
    // If something holds the quit up, exit anyway so the files can be replaced.
    setTimeout(() => app.exit(0), 3000);
  } catch (e) {
    busy = false;
    mainWindow?.setProgressBar(-1);
    fs.rmSync(work, { recursive: true, force: true });
    console.warn("[Stoat+] update failed", e);
    dialog.showMessageBox(mainWindow, {
      type: "error",
      title: "Stoat+",
      message: "The update didn't install",
      detail: `${(e as Error)?.message ?? e}\n\nYou can download it from ${release.pageUrl}`,
    });
  }
}

/** The folder inside the unpacked zip that holds the app's exe. */
function findAppFolder(dir: string, exeName: string, depth = 0): string | null {
  if (fs.existsSync(path.join(dir, exeName))) return dir;
  if (depth > 2) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const found = findAppFolder(path.join(dir, entry.name), exeName, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

export function initUpdater() {
  // Wait a bit so the update prompt doesn't fight with app start-up.
  setTimeout(() => checkForUpdates(false), 15_000);
  setInterval(() => checkForUpdates(false), CHECK_EVERY_MS);
}
