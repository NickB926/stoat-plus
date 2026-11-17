/*
 * Stoat+ plugin runtime.
 *
 * The same file runs on desktop (inside the Stoat web page) and on Android
 * (inside a hidden WebView). The platform defines `globalThis.__stoatHost`
 * before this file runs; everything platform-specific goes through it:
 *
 *   host.platform                     "desktop" | "android"
 *   host.toast(text)
 *   host.storageGet(key) -> string|null      (synchronous)
 *   host.storageSet(key, value)
 *   host.storageRemove(key)
 *   host.apiRequest(method, path, body) -> Promise<any>
 *   host.selfId() -> string|null
 *   host.log(level, text)
 *   host.addCSS?(css) -> () => void   (optional, desktop only)
 *   host.hooksChanged?(counts)        (optional, lets the host skip work)
 *
 * The host drives the runtime through `globalThis.__stoatPlus`.
 */
(function () {
  "use strict";
  if (globalThis.__stoatPlus) return;

  const RUNTIME_VERSION = "1.0.0";
  const HOOK_TIMEOUT_MS = 3000;
  const host = globalThis.__stoatHost;
  if (!host) throw new Error("Stoat+ runtime: __stoatHost is not defined");

  /** id -> plugin record */
  const plugins = new Map();

  // ---------- helpers ----------

  function log(level, ...args) {
    const text = args
      .map((a) => {
        if (a instanceof Error) return a.stack || a.message;
        if (typeof a === "string") return a;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(" ");
    try {
      host.log(level, text);
    } catch {
      /* ignore */
    }
  }

  function readJSON(key, fallback) {
    try {
      const raw = host.storageGet(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function writeJSON(key, value) {
    if (value === undefined) host.storageRemove(key);
    else host.storageSet(key, JSON.stringify(value));
  }

  const keys = {
    enabled: (id) => `stoatplus:enabled:${id}`,
    settings: (id) => `stoatplus:settings:${id}`,
    data: (id, k) => `stoatplus:data:${id}:${k}`,
  };

  function withTimeout(promise, ms, what) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} took longer than ${ms}ms`)),
          ms,
        );
      }),
    ]).finally(() => clearTimeout(timer));
  }

  /**
   * Read the header comment of a plugin file:
   *   /**
   *    * @name My Plugin
   *    * @id my-plugin
   *    * ...
   *    *\/
   */
  function parseMeta(source, fallbackId) {
    const meta = {
      id: "",
      name: "",
      version: "0.0.0",
      author: "",
      description: "",
      platforms: ["desktop", "android"],
    };
    const header = /^\s*\/\*\*([\s\S]*?)\*\//.exec(source);
    if (header) {
      for (const line of header[1].split(/\r?\n/)) {
        const m = /^\s*\*?\s*@(\w+)\s+(.+?)\s*$/.exec(line);
        if (!m) continue;
        const [, key, value] = m;
        if (key === "platforms") {
          meta.platforms = value
            .split(/[,\s]+/)
            .map((p) => p.trim().toLowerCase())
            .filter(Boolean);
        } else if (key in meta) {
          meta[key] = value;
        }
      }
    }
    meta.id = (meta.id || fallbackId || "")
      .toLowerCase()
      .replace(/\.js$/, "")
      .replace(/[^a-z0-9._-]+/g, "-");
    if (!meta.name) meta.name = meta.id;
    return meta;
  }

  function settingDefaults(schema) {
    const out = {};
    for (const [key, def] of Object.entries(schema || {})) {
      if ("default" in def) out[key] = def.default;
      else if (def.type === "boolean") out[key] = false;
      else if (def.type === "number") out[key] = 0;
      else out[key] = "";
    }
    return out;
  }

  function currentSettings(p) {
    return {
      ...settingDefaults(p.def && p.def.settings),
      ...readJSON(keys.settings(p.meta.id), {}),
    };
  }

  function notifyHooksChanged() {
    if (typeof host.hooksChanged !== "function") return;
    let send = 0;
    let message = 0;
    let commands = 0;
    for (const p of plugins.values()) {
      if (!p.running) continue;
      send += p.hooks.send.length;
      message += p.hooks.message.length;
      commands += p.commands.length;
    }
    try {
      host.hooksChanged({ send, message, commands });
    } catch (e) {
      log("warn", "hooksChanged failed", e);
    }
  }

  function reportError(p, where, error) {
    p.error = `${where}: ${error && error.message ? error.message : error}`;
    log("error", `[${p.meta.id}] ${where}`, error);
    if (!p.errorToasted) {
      p.errorToasted = true;
      try {
        host.toast(`Plugin "${p.meta.name}" hit an error (${where})`);
      } catch {
        /* ignore */
      }
    }
  }

  // ---------- the API a plugin receives ----------

  function makeApi(p) {
    const remove = (list, item) => () => {
      const i = list.indexOf(item);
      if (i >= 0) list.splice(i, 1);
      notifyHooksChanged();
    };

    const api = {
      platform: host.platform,
      runtimeVersion: RUNTIME_VERSION,
      plugin: { id: p.meta.id, name: p.meta.name, version: p.meta.version },

      /** fn(msg) -> undefined | string | {content} | false. May be async. */
      onBeforeSend(fn) {
        p.hooks.send.push(fn);
        notifyHooksChanged();
        return remove(p.hooks.send, fn);
      },

      /** fn(msg) -> undefined | string | {content} | false. May be async. */
      onMessage(fn) {
        p.hooks.message.push(fn);
        notifyHooksChanged();
        return remove(p.hooks.message, fn);
      },

      commands: {
        /** { name, description?, run(args, ctx) -> undefined | string | {content} | false } */
        register(cmd) {
          if (!cmd || typeof cmd.name !== "string" || typeof cmd.run !== "function") {
            throw new Error("commands.register needs { name, run }");
          }
          const entry = {
            name: cmd.name.replace(/^\//, "").toLowerCase(),
            description: cmd.description || "",
            run: cmd.run,
          };
          p.commands.push(entry);
          notifyHooksChanged();
          return remove(p.commands, entry);
        },
      },

      settings: {
        get(key) {
          return currentSettings(p)[key];
        },
        all() {
          return currentSettings(p);
        },
        set(key, value) {
          setSetting(p.meta.id, key, value);
        },
        onChange(fn) {
          p.settingsListeners.push(fn);
          return remove(p.settingsListeners, fn);
        },
      },

      storage: {
        get(key, fallback) {
          return readJSON(keys.data(p.meta.id, key), fallback);
        },
        set(key, value) {
          writeJSON(keys.data(p.meta.id, key), value);
        },
        remove(key) {
          host.storageRemove(keys.data(p.meta.id, key));
        },
      },

      toast(text) {
        host.toast(String(text));
      },

      self() {
        return { id: host.selfId() };
      },

      api: {
        request(method, path, body) {
          return host.apiRequest(String(method).toUpperCase(), path, body);
        },
        sendMessage(channelId, content, extra) {
          return host.apiRequest("POST", `/channels/${channelId}/messages`, {
            content,
            ...(extra || {}),
          });
        },
      },

      ui: {
        /** Desktop only. Returns a function that removes the CSS again. */
        addCSS(css) {
          if (typeof host.addCSS !== "function") {
            log("warn", `[${p.meta.id}] ui.addCSS isn't available on ${host.platform}`);
            return () => {};
          }
          const off = host.addCSS(String(css));
          p.cleanups.push(off);
          return off;
        },
      },

      onUnload(fn) {
        p.cleanups.push(fn);
      },

      log: (...args) => log("info", `[${p.meta.id}]`, ...args),
    };
    return Object.freeze(api);
  }

  // ---------- lifecycle ----------

  function evaluate(p) {
    let captured = null;
    const definePlugin = (def) => {
      captured = def || {};
    };
    // eslint-disable-next-line no-new-func
    const fn = new Function(
      "definePlugin",
      `${p.source}\n//# sourceURL=stoat-plugin:///${p.meta.id}.js`,
    );
    fn.call(undefined, definePlugin);
    if (!captured) throw new Error("the file never called definePlugin({...})");
    if (typeof captured.start !== "function") {
      throw new Error("definePlugin needs a start(stoat) function");
    }
    return captured;
  }

  function isSupported(p) {
    return p.meta.platforms.includes(host.platform);
  }

  function isEnabled(id) {
    return readJSON(keys.enabled(id), false) === true;
  }

  async function start(p) {
    if (p.running || !isSupported(p)) return;
    p.error = null;
    p.errorToasted = false;
    try {
      if (!p.def) p.def = evaluate(p);
      p.api = makeApi(p);
      p.running = true;
      await p.def.start(p.api);
      log("info", `started ${p.meta.id} ${p.meta.version}`);
    } catch (e) {
      reportError(p, "start", e);
      stop(p);
    }
    notifyHooksChanged();
  }

  function stop(p) {
    if (p.running && p.def && typeof p.def.stop === "function") {
      try {
        p.def.stop(p.api);
      } catch (e) {
        log("error", `[${p.meta.id}] stop`, e);
      }
    }
    for (const fn of p.cleanups.splice(0)) {
      try {
        fn();
      } catch (e) {
        log("error", `[${p.meta.id}] cleanup`, e);
      }
    }
    p.hooks.send.length = 0;
    p.hooks.message.length = 0;
    p.commands.length = 0;
    p.settingsListeners.length = 0;
    p.running = false;
    notifyHooksChanged();
  }

  async function loadAll(files) {
    for (const p of plugins.values()) stop(p);
    plugins.clear();

    for (const { file, source } of files || []) {
      const meta = parseMeta(source, String(file || "").replace(/\.js$/i, ""));
      if (!meta.id) continue;
      if (plugins.has(meta.id)) {
        log("warn", `two plugins use the id "${meta.id}"; ignoring ${file}`);
        continue;
      }
      const p = {
        meta,
        file,
        source,
        def: null,
        api: null,
        running: false,
        error: null,
        errorToasted: false,
        hooks: { send: [], message: [] },
        commands: [],
        cleanups: [],
        settingsListeners: [],
      };
      plugins.set(meta.id, p);
    }

    for (const p of plugins.values()) {
      if (!isEnabled(p.meta.id) || !isSupported(p)) continue;
      // Evaluate disabled plugins lazily, but enabled ones now so their
      // settings schema is available to the manager.
      await start(p);
    }
    // Evaluate the rest only to read their settings schema; don't start them.
    for (const p of plugins.values()) {
      if (p.def || !isSupported(p)) continue;
      try {
        p.def = evaluate(p);
      } catch (e) {
        p.error = `load: ${e && e.message ? e.message : e}`;
      }
    }
    notifyHooksChanged();
    return list();
  }

  async function setEnabled(id, enabled) {
    const p = plugins.get(id);
    if (!p) return list();
    writeJSON(keys.enabled(id), !!enabled);
    if (enabled) await start(p);
    else stop(p);
    return list();
  }

  function setSetting(id, key, value) {
    const p = plugins.get(id);
    if (!p) return list();
    const saved = readJSON(keys.settings(id), {});
    saved[key] = value;
    writeJSON(keys.settings(id), saved);
    const all = currentSettings(p);
    for (const fn of p.settingsListeners.slice()) {
      try {
        fn(key, value, all);
      } catch (e) {
        reportError(p, "settings.onChange", e);
      }
    }
    return list();
  }

  /** Drop every saved value for a plugin (used when it's deleted). */
  function forget(id) {
    host.storageRemove(keys.enabled(id));
    host.storageRemove(keys.settings(id));
  }

  function list() {
    return Array.from(plugins.values()).map((p) => ({
      id: p.meta.id,
      file: p.file,
      name: p.meta.name,
      version: p.meta.version,
      author: p.meta.author,
      description: p.meta.description,
      platforms: p.meta.platforms,
      supported: isSupported(p),
      enabled: isEnabled(p.meta.id),
      running: p.running,
      error: p.error,
      settingsSchema: (p.def && p.def.settings) || {},
      settings: currentSettings(p),
    }));
  }

  function commandList() {
    const out = [];
    for (const p of plugins.values()) {
      if (!p.running) continue;
      for (const c of p.commands) {
        out.push({ name: c.name, description: c.description, plugin: p.meta.name });
      }
    }
    return out;
  }

  // ---------- hooks the host calls ----------

  /** Normalise a hook's return value. */
  function outcome(result, content) {
    if (result === false || result === null) return { cancel: true, content };
    if (typeof result === "string") return { cancel: false, content: result };
    if (result && typeof result === "object") {
      if (result.cancel === true) return { cancel: true, content };
      if (typeof result.content === "string") return { cancel: false, content: result.content };
    }
    return { cancel: false, content };
  }

  /**
   * msg: { channelId, content, replyIds? }
   * resolves { action: "send", content } | { action: "cancel" }
   */
  async function runBeforeSend(msg) {
    let content = String((msg && msg.content) || "");
    const ctx = {
      channelId: msg && msg.channelId,
      replyIds: (msg && msg.replyIds) || [],
    };

    // Commands first: "/name args"
    const cmdMatch = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(content);
    if (cmdMatch) {
      const name = cmdMatch[1].toLowerCase();
      const args = cmdMatch[2] || "";
      for (const p of plugins.values()) {
        if (!p.running) continue;
        const cmd = p.commands.find((c) => c.name === name);
        if (!cmd) continue;
        try {
          const result = await withTimeout(
            Promise.resolve(cmd.run(args, { ...ctx, api: p.api })),
            HOOK_TIMEOUT_MS,
            `/${name}`,
          );
          // A command that returns nothing sends nothing.
          if (result === undefined) return { action: "cancel" };
          const o = outcome(result, content);
          if (o.cancel) return { action: "cancel" };
          content = o.content;
        } catch (e) {
          reportError(p, `/${name}`, e);
          return { action: "cancel" };
        }
        break;
      }
    }

    for (const p of plugins.values()) {
      if (!p.running) continue;
      for (const fn of p.hooks.send.slice()) {
        try {
          const result = await withTimeout(
            Promise.resolve(fn({ ...ctx, content })),
            HOOK_TIMEOUT_MS,
            "onBeforeSend",
          );
          const o = outcome(result, content);
          if (o.cancel) return { action: "cancel" };
          content = o.content;
        } catch (e) {
          reportError(p, "onBeforeSend", e);
        }
      }
    }

    if (!content.trim() && !(msg && msg.hasAttachments)) return { action: "cancel" };
    return { action: "send", content };
  }

  /**
   * msgs: [{ id, channelId, authorId, content, live }]
   * resolves an array with one entry per message:
   *   null   keep as is
   *   string replace the content with this
   *   false  hide the message
   */
  async function runMessageHooks(msgs) {
    const results = [];
    for (const raw of msgs || []) {
      let content = raw.content == null ? "" : String(raw.content);
      const original = content;
      let hidden = false;
      outer: for (const p of plugins.values()) {
        if (!p.running) continue;
        for (const fn of p.hooks.message.slice()) {
          try {
            const result = await withTimeout(
              Promise.resolve(fn({ ...raw, content })),
              HOOK_TIMEOUT_MS,
              "onMessage",
            );
            const o = outcome(result, content);
            if (o.cancel) {
              hidden = true;
              break outer;
            }
            content = o.content;
          } catch (e) {
            reportError(p, "onMessage", e);
          }
        }
      }
      results.push(hidden ? false : content === original ? null : content);
    }
    return results;
  }

  globalThis.__stoatPlus = Object.freeze({
    version: RUNTIME_VERSION,
    parseMeta,
    loadAll,
    list,
    commands: commandList,
    setEnabled,
    setSetting,
    forget,
    runBeforeSend,
    runMessageHooks,
  });
})();
