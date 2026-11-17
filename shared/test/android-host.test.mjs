// Run with: node --test shared/test/android-host.test.mjs
// Loads the Android host + runtime the way PluginEngine.kt does, with a fake
// StoatBridge standing in for the Kotlin side.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const shared = join(dirname(fileURLToPath(import.meta.url)), "..");
const hostSource = readFileSync(
  join(shared, "../android/app/src/main/assets/stoatplus/host-android.js"),
  "utf8",
);
const runtimeSource = readFileSync(join(shared, "runtime.js"), "utf8");
const files = readdirSync(join(shared, "plugins")).map((file) => ({
  file,
  source: readFileSync(join(shared, "plugins", file), "utf8"),
}));

function boot() {
  const prefs = new Map();
  const results = new Map();
  const toasts = [];
  const counts = {};
  const apiCalls = [];
  const ctx = vm.createContext({ setTimeout, clearTimeout, console });
  vm.runInContext("globalThis.window = globalThis;", ctx); // like a WebView
  ctx.StoatBridge = {
    resolve: (id, json) => results.get(id).resolve(JSON.parse(json)),
    reject: (id, msg) => results.get(id).reject(new Error(msg)),
    toast: (t) => toasts.push(t),
    // Java returns null for a missing String
    storageGet: (k) => (prefs.has(k) ? prefs.get(k) : null),
    storageSet: (k, v) => prefs.set(k, v),
    storageRemove: (k) => prefs.delete(k),
    selfId: () => "ME",
    apiRequest: (id, method, path, body) => {
      apiCalls.push({ method, path, body });
      setTimeout(() => ctx.__stoatHostApiDone(id, true, JSON.stringify({ _id: "U1" })), 1);
    },
    log: () => {},
    hooksChanged: (send, message, commands) => Object.assign(counts, { send, message, commands }),
  };
  vm.runInContext(`${hostSource}\n;${runtimeSource}`, ctx);

  let nextId = 1;
  /** Same shape as PluginEngine.callJs */
  const call = (expression) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      results.set(id, { resolve, reject });
      vm.runInContext(`__stoatHostCall(${id}, () => (${expression}));`, ctx);
    });
  return { call, prefs, toasts, counts, apiCalls };
}

test("Kotlin-style calls round-trip through the bridge", async () => {
  const { call, counts, prefs } = boot();
  const list = await call(`__stoatPlus.loadAll(${JSON.stringify(files)})`);
  assert.equal(list.length, 4);
  assert.equal(list.find((p) => p.id === "compact-mode").supported, false);

  await call(`__stoatPlus.setEnabled("text-commands", true)`);
  assert.equal(prefs.get("stoatplus:enabled:text-commands"), "true");
  assert.equal(counts.commands, 5);

  const sent = await call(`__stoatPlus.runBeforeSend(${JSON.stringify({ channelId: "c", content: "/lenny" })})`);
  assert.deepEqual(sent, { action: "send", content: "( ͡° ͜ʖ ͡°)" });

  await call(`__stoatPlus.setEnabled("keyword-filter", true)`);
  await call(`__stoatPlus.setSetting("keyword-filter", "words", "spoiler")`);
  const res = await call(
    `__stoatPlus.runMessageHooks(${JSON.stringify([{ id: "1", authorId: "X", content: "big spoiler" }])})`,
  );
  assert.deepEqual(res, ["big \\*\\*\\*\\*\\*\\*\\*"]);
  assert.equal(counts.message, 1);
});

test("plugins can call the API through Kotlin", async () => {
  const { call, apiCalls } = boot();
  await call(
    `__stoatPlus.loadAll(${JSON.stringify([
      {
        file: "me.js",
        source:
          "/** @id me */ definePlugin({ start(s){ s.commands.register({ name: 'whoami', run: async () => (await s.api.request('get', '/users/@me'))._id }) } })",
      },
    ])})`,
  );
  await call(`__stoatPlus.setEnabled("me", true)`);
  const sent = await call(`__stoatPlus.runBeforeSend({ content: "/whoami" })`);
  assert.equal(sent.content, "U1");
  assert.deepEqual(apiCalls, [{ method: "GET", path: "/users/@me", body: null }]);
});
