/*
 * Stoat+ Android host. Runs in the plugin engine's hidden WebView and gives
 * the shared runtime (runtime.js) its window.__stoatHost, backed by the
 * StoatBridge object that PluginEngine.kt adds to the WebView.
 */
(function () {
  "use strict";
  const bridge = window.StoatBridge;
  const pendingApi = new Map();
  let nextApiId = 1;

  /** Kotlin -> JS calls: run fn, send the (awaited) result back as JSON. */
  window.__stoatHostCall = function (id, fn) {
    Promise.resolve()
      .then(fn)
      .then(
        (value) => bridge.resolve(id, JSON.stringify(value === undefined ? null : value)),
        (error) => bridge.reject(id, String((error && (error.stack || error.message)) || error)),
      );
  };

  /** Kotlin finished an API request started by host.apiRequest. */
  window.__stoatHostApiDone = function (id, ok, text) {
    const pending = pendingApi.get(id);
    if (!pending) return;
    pendingApi.delete(id);
    if (!ok) return pending.reject(new Error(text));
    try {
      pending.resolve(text ? JSON.parse(text) : null);
    } catch {
      pending.resolve(text);
    }
  };

  const nullable = (v) => (v === undefined || v === null ? null : v);

  window.__stoatHost = {
    platform: "android",
    toast: (text) => bridge.toast(String(text)),
    storageGet: (key) => nullable(bridge.storageGet(String(key))),
    storageSet: (key, value) => bridge.storageSet(String(key), String(value)),
    storageRemove: (key) => bridge.storageRemove(String(key)),
    selfId: () => nullable(bridge.selfId()),
    apiRequest: (method, path, body) =>
      new Promise((resolve, reject) => {
        const id = nextApiId++;
        pendingApi.set(id, { resolve, reject });
        bridge.apiRequest(
          id,
          String(method),
          String(path),
          body === undefined ? null : JSON.stringify(body),
        );
      }),
    log: (level, text) => bridge.log(String(level), String(text)),
    hooksChanged: (c) => bridge.hooksChanged(c.send | 0, c.message | 0, c.commands | 0),
  };
})();
