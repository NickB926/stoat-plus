import fs from "node:fs";
import path from "node:path";

import { defineConfig } from "vite";

// Stoat+ version: set by CI from the release tag, otherwise read from ../VERSION.
function stoatPlusVersion() {
  if (process.env.STOATPLUS_VERSION) return process.env.STOATPLUS_VERSION;
  try {
    return fs.readFileSync(path.join(__dirname, "..", "VERSION"), "utf8").trim();
  } catch {
    return "0.0.0";
  }
}

// https://vitejs.dev/config
export default defineConfig({
  define: {
    __STOATPLUS_VERSION__: JSON.stringify(stoatPlusVersion()),
    __STOATPLUS_REPO__: JSON.stringify(process.env.STOATPLUS_REPO || "NickB926/stoat-plus"),
  },
  build: {
    rollupOptions: {
      external: ["node-pipewire"],
    },
  },
});
