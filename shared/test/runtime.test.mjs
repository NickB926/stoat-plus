// Run with: node --test shared/test/runtime.test.mjs
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeSource = readFileSync(join(root, "runtime.js"), "utf8");
const examples = readdirSync(join(root, "plugins"))
  .filter((f) => f.endsWith(".js"))
  .map((file) => ({ file, source: readFileSync(join(root, "plugins", file), "utf8") }));

function boot(platform = "android") {
  const store = new Map();
  const toasts = [];
  const ctx = vm.createContext({ setTimeout, clearTimeout, console });
  ctx.__stoatHost = {
    platform,
    toast: (t) => toasts.push(t),
    storageGet: (k) => (store.has(k) ? store.get(k) : null),
    storageSet: (k, v) => store.set(k, v),
    storageRemove: (k) => store.delete(k),
    apiRequest: async () => ({}),
    selfId: () => "ME",
    log: () => {},
  };
  vm.runInContext(runtimeSource, ctx);
  return { rt: ctx.__stoatPlus, store, toasts };
}

test("parses metadata", () => {
  const { rt } = boot();
  const meta = rt.parseMeta(examples.find((e) => e.file === "compact-mode.js").source);
  assert.equal(meta.id, "compact-mode");
  assert.equal(meta.name, "Compact Mode");
  assert.deepEqual([...meta.platforms], ["desktop"]);
});

test("plugins are off until enabled; desktop-only ones are unsupported on android", async () => {
  const { rt } = boot("android");
  const list = await rt.loadAll(examples);
  assert.equal(list.length, 4);
  assert.ok(list.every((p) => !p.enabled && !p.running));
  assert.equal(list.find((p) => p.id === "compact-mode").supported, false);
  assert.equal(list.find((p) => p.id === "auto-replace").settingsSchema.rules.type, "text");
});

test("commands replace content, unknown commands pass through", async () => {
  const { rt } = boot();
  await rt.loadAll(examples);
  await rt.setEnabled("text-commands", true);
  assert.deepEqual(
    { ...(await rt.runBeforeSend({ channelId: "c", content: "/shrug hi" })) },
    { action: "send", content: "hi ¯\\_(ツ)_/¯" },
  );
  assert.equal((await rt.runBeforeSend({ content: "/me" })).action, "cancel");
  assert.equal((await rt.runBeforeSend({ content: "/nope x" })).content, "/nope x");
  rt.setSetting("text-commands", "shrug", "meh");
  assert.equal((await rt.runBeforeSend({ content: "/shrug" })).content, "meh");
});

test("auto-replace edits outgoing text and reacts to settings", async () => {
  const { rt } = boot();
  await rt.loadAll(examples);
  await rt.setEnabled("auto-replace", true);
  assert.equal((await rt.runBeforeSend({ content: "teh cat" })).content, "the cat");
  assert.equal((await rt.runBeforeSend({ content: "`teh`" })).content, "`teh`");
  rt.setSetting("auto-replace", "rules", "cat = dog");
  assert.equal((await rt.runBeforeSend({ content: "teh cat" })).content, "teh dog");
});

test("keyword filter censors or hides others' messages, never yours", async () => {
  const { rt } = boot();
  await rt.loadAll(examples);
  await rt.setEnabled("keyword-filter", true);
  rt.setSetting("keyword-filter", "words", "bad");
  const res = await rt.runMessageHooks([
    { id: "1", authorId: "X", content: "a bad day" },
    { id: "2", authorId: "ME", content: "bad" },
    { id: "3", authorId: "X", content: "fine" },
  ]);
  assert.deepEqual([...res], ["a \\*\\*\\* day", null, null]);
  rt.setSetting("keyword-filter", "mode", "hide");
  assert.deepEqual([...(await rt.runMessageHooks([{ authorId: "X", content: "BAD" }]))], [false]);
});

test("disabling removes hooks; enabled state persists across reloads", async () => {
  const { rt, store } = boot();
  await rt.loadAll(examples);
  await rt.setEnabled("auto-replace", true);
  await rt.setEnabled("auto-replace", false);
  assert.equal((await rt.runBeforeSend({ content: "teh" })).content, "teh");
  await rt.setEnabled("auto-replace", true);
  const again = await rt.loadAll(examples);
  assert.equal(again.find((p) => p.id === "auto-replace").running, true);
  assert.equal(store.get("stoatplus:enabled:auto-replace"), "true");
});

test("a broken or hanging plugin can't block sending", async () => {
  const { rt, toasts } = boot();
  await rt.loadAll([
    ...examples,
    { file: "boom.js", source: "/** @id boom */ definePlugin({ start(s){ s.onBeforeSend(() => { throw new Error('x') }) } })" },
    { file: "hang.js", source: "/** @id hang */ definePlugin({ start(s){ s.onBeforeSend(() => new Promise(() => {})) } })" },
    { file: "bad.js", source: "this is not javascript" },
  ]);
  await rt.setEnabled("boom", true);
  await rt.setEnabled("hang", true);
  const t0 = Date.now();
  assert.equal((await rt.runBeforeSend({ content: "hi" })).content, "hi");
  assert.ok(Date.now() - t0 < 4000);
  assert.equal(toasts.length, 2);
  assert.match(rt.list().find((p) => p.id === "bad").error, /load/);
});
