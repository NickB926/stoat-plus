/*
 * Stoat+ desktop host. Runs in the Stoat web page (main world), injected by
 * the preload before the app's own scripts. It:
 *   - defines window.__stoatHost for the shared runtime (../../../shared/runtime.js)
 *   - wraps fetch() so plugins can edit/block outgoing messages and edit/hide
 *     messages loaded from history
 *   - wraps the events WebSocket so plugins can edit/hide live messages
 *   - draws the plugin manager (Ctrl+Shift+P, or tray menu -> Plugins)
 *
 * window.__stoatNative is exposed by the preload (folder access, installs).
 */
(function () {
  "use strict";
  if (window.__stoatHost) return;

  const native = window.__stoatNative;
  const nativeFetch = window.fetch.bind(window);
  const NativeWebSocket = window.WebSocket;
  const HIDDEN_TEXT = "*(hidden by a plugin)*";

  const state = {
    token: null,
    apiBase: null,
    selfId: null,
    lastMessageId: null,
    counts: { send: 0, message: 0, commands: 0 },
  };

  // Plugins load asynchronously; hooks wait for them, but never for long.
  let markReady;
  const ready = new Promise((resolve) => (markReady = resolve));
  setTimeout(() => markReady(), 4000);

  const log = (...args) => console.log("[Stoat+]", ...args);

  // ---------- toast ----------

  let toastBox = null;
  function toast(text) {
    if (!document.body) {
      document.addEventListener("DOMContentLoaded", () => toast(text), { once: true });
      return;
    }
    if (!toastBox) {
      toastBox = document.createElement("div");
      toastBox.style.cssText =
        "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483647;" +
        "display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none;";
      document.body.appendChild(toastBox);
    }
    const el = document.createElement("div");
    el.textContent = text;
    el.style.cssText =
      "background:#222;color:#fff;padding:10px 16px;border-radius:10px;max-width:420px;" +
      "font:14px/1.4 system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.35);" +
      "transition:opacity .3s;opacity:1;";
    toastBox.appendChild(el);
    setTimeout(() => (el.style.opacity = "0"), 3200);
    setTimeout(() => el.remove(), 3600);
  }

  // ---------- host for the shared runtime ----------

  window.__stoatHost = {
    platform: "desktop",
    toast,
    storageGet: (k) => localStorage.getItem(k),
    storageSet: (k, v) => localStorage.setItem(k, v),
    storageRemove: (k) => localStorage.removeItem(k),
    selfId: () => state.selfId,
    async apiRequest(method, path, body) {
      if (!state.token || !state.apiBase) throw new Error("Not logged in yet");
      const headers = { "X-Session-Token": state.token };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      // nativeFetch: requests made by plugins don't go through the hooks.
      const res = await nativeFetch(state.apiBase + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      return text ? JSON.parse(text) : null;
    },
    log: (level, text) => (console[level] || console.log)("[Stoat+]", text),
    addCSS(css) {
      const el = document.createElement("style");
      el.setAttribute("data-stoat-plus", "");
      el.textContent = css;
      (document.head || document.documentElement).appendChild(el);
      return () => el.remove();
    },
    hooksChanged(counts) {
      state.counts = counts;
    },
  };

  // ---------- helpers ----------

  const API_ROUTE =
    /^(https?:\/\/[^?#]*?)\/(users|channels|servers|sync|auth|onboard|safety|invites|bots|custom|policy|push|webhooks)(\/|\?|$)/;

  function headerValue(headers, name) {
    if (!headers) return null;
    if (typeof headers.get === "function") return headers.get(name);
    if (Array.isArray(headers)) {
      const hit = headers.find(([k]) => String(k).toLowerCase() === name.toLowerCase());
      return hit ? hit[1] : null;
    }
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === name.toLowerCase()) return headers[k];
    }
    return null;
  }

  function noteMessageId(id) {
    if (typeof id === "string" && id) state.lastMessageId = id;
  }

  function toPluginMessage(m, live) {
    return {
      id: m._id,
      channelId: m.channel,
      authorId: m.author,
      content: typeof m.content === "string" ? m.content : "",
      live,
    };
  }

  async function runMessageHooks(messages, live) {
    await ready;
    return window.__stoatPlus.runMessageHooks(messages.map((m) => toPluginMessage(m, live)));
  }

  // ---------- fetch: outgoing messages + history ----------

  const MESSAGES_ROUTE = /^\/channels\/([^/?#]+)\/messages(?:\?.*)?$/;

  window.fetch = async function (input, init) {
    let url = "";
    let method = "GET";
    try {
      url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : (input && input.url) || "";
      method = String(
        (init && init.method) || (input instanceof Request ? input.method : "GET"),
      ).toUpperCase();
      const token = headerValue(init && init.headers, "X-Session-Token");
      if (token) {
        state.token = token;
        const base = API_ROUTE.exec(url);
        if (base) state.apiBase = base[1];
      }
    } catch {
      /* never break the app over bookkeeping */
    }

    const route =
      state.apiBase && url.startsWith(state.apiBase)
        ? MESSAGES_ROUTE.exec(url.slice(state.apiBase.length))
        : null;

    if (
      route &&
      method === "POST" &&
      init &&
      typeof init.body === "string" &&
      (state.counts.send || state.counts.commands)
    ) {
      try {
        await ready;
        const data = JSON.parse(init.body);
        if (data && typeof data.content === "string") {
          const result = await window.__stoatPlus.runBeforeSend({
            channelId: route[1],
            content: data.content,
            replyIds: (data.replies || []).map((r) => r.id),
            hasAttachments: !!(data.attachments && data.attachments.length),
          });
          if (result.action === "cancel") return blockedResponse(route[1]);
          if (result.content !== data.content) {
            data.content = result.content;
            init = { ...init, body: JSON.stringify(data) };
          }
        }
      } catch (e) {
        log("send hook failed, sending unchanged", e);
      }
    }

    const res = await nativeFetch(input, init);

    if (route && method === "GET" && res.ok) {
      try {
        return await filterHistory(res);
      } catch (e) {
        log("history hook failed", e);
      }
    }
    return res;
  };

  /**
   * The web client expects the created message back. Answering with a message
   * it already has cached makes it drop the pending bubble without drawing
   * anything new.
   */
  function blockedResponse(channelId) {
    const body = {
      _id: state.lastMessageId || "01STOATPLUSBLOCKED00000000",
      channel: state.lastMessageId ? channelId : "stoat-plus-blocked",
      author: state.selfId || "",
      content: "",
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  async function filterHistory(res) {
    const clone = res.clone();
    const data = await clone.json();
    const list = Array.isArray(data) ? data : data && Array.isArray(data.messages) ? data.messages : null;
    if (!list) return res;
    for (const m of list) noteMessageId(m && m._id);
    if (!state.counts.message || !list.length) return res;

    const results = await runMessageHooks(list, false);
    let changed = false;
    results.forEach((r, i) => {
      if (r === null) return;
      changed = true;
      // Hidden history messages keep their slot so paging still works.
      if (r === false) {
        list[i].content = HIDDEN_TEXT;
        delete list[i].attachments;
        delete list[i].embeds;
      } else {
        list[i].content = r;
      }
    });
    if (!changed) return res;
    return new Response(JSON.stringify(data), {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  }

  // ---------- WebSocket: live messages ----------

  const FRAME = /^\{"type":"(Message|Bulk|Ready)"/;
  const queues = new WeakMap();

  async function processFrame(raw) {
    const kind = FRAME.exec(raw)[1];
    if (kind === "Ready") {
      try {
        const frame = JSON.parse(raw);
        const me = (frame.users || []).find((u) => u.relationship === "User");
        if (me) state.selfId = me._id;
      } catch {
        /* ignore */
      }
      return raw;
    }

    const idMatch = /"_id":"([0-9A-Z]{26})"/.exec(raw);
    if (idMatch) noteMessageId(idMatch[1]);
    if (!state.counts.message) return raw;

    const frame = JSON.parse(raw);
    if (frame.type === "Message") {
      const [r] = await runMessageHooks([frame], true);
      if (r === false) return null;
      if (typeof r === "string") {
        frame.content = r;
        return JSON.stringify(frame);
      }
      return raw;
    }

    // Bulk: { type: "Bulk", v: [frames...] }
    const subs = (frame.v || []).filter((f) => f && f.type === "Message");
    if (!subs.length) return raw;
    const results = await runMessageHooks(subs, true);
    const hide = new Set();
    results.forEach((r, i) => {
      if (r === false) hide.add(subs[i]);
      else if (typeof r === "string") subs[i].content = r;
    });
    frame.v = frame.v.filter((f) => !hide.has(f));
    return JSON.stringify(frame);
  }

  function wrapOnMessage(ws, handler) {
    return function (event) {
      const data = event.data;
      const interesting = typeof data === "string" && FRAME.test(data.slice(0, 24));
      const q = queues.get(ws);
      // Fast path keeps the app's own timing when nothing is queued.
      if (!interesting && q.depth === 0) return handler.call(ws, event);

      q.depth++;
      q.chain = q.chain
        .then(() => (interesting ? processFrame(data) : data))
        .catch((e) => {
          log("message hook failed, passing frame through", e);
          return data;
        })
        .then((out) => {
          if (out === null) return; // hidden
          handler.call(ws, out === data ? event : new MessageEvent("message", { data: out }));
        })
        .finally(() => q.depth--);
    };
  }

  class StoatPlusWebSocket extends NativeWebSocket {
    constructor(url, protocols) {
      super(url, protocols);
      let isEvents = false;
      try {
        const u = new URL(String(url));
        isEvents = u.searchParams.get("format") === "json" && u.searchParams.has("token");
        if (isEvents) state.token = u.searchParams.get("token");
      } catch {
        /* ignore */
      }
      if (isEvents) queues.set(this, { depth: 0, chain: Promise.resolve() });
    }

    set onmessage(handler) {
      super.onmessage =
        typeof handler === "function" && queues.has(this) ? wrapOnMessage(this, handler) : handler;
    }

    get onmessage() {
      return super.onmessage;
    }
  }
  window.WebSocket = StoatPlusWebSocket;

  // ---------- branding: "Stoat+" in the title bar ----------

  function brandTitlebar() {
    // The title bar wordmark is the first svg in the draggable title area.
    const marks = document.querySelectorAll('div[style*="app-region: drag"] > svg:first-child');
    for (const svg of marks) {
      const next = svg.nextElementSibling;
      if (next && next.hasAttribute("data-stoat-plus-mark")) continue;
      const plus = document.createElement("span");
      plus.setAttribute("data-stoat-plus-mark", "");
      plus.textContent = "+";
      plus.style.cssText =
        "font:700 17px/1 system-ui,sans-serif;margin-inline-start:calc(1px - var(--gap-md, 8px));" +
        "color:var(--md-sys-color-primary,#ff5b4f);transform:translateY(-3px);";
      svg.after(plus);
    }
  }
  // ---------- "Plugins" entry in the Settings sidebar ----------
  // The sidebar is drawn by the remote web app, so we find it by its labels
  // and copy an existing entry to match its look.

  const PUZZLE_SVG =
    '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.5 11H19V7a2 2 0 0 0-2-2h-4V3.5a2.5 2.5 0 0 0-5 0V5H4a2 2 0 0 0-2 2v3.8h1.5a2.7 2.7 0 0 1 0 5.4H2V20a2 2 0 0 0 2 2h3.8v-1.5a2.7 2.7 0 0 1 5.4 0V22H17a2 2 0 0 0 2-2v-4h1.5a2.5 2.5 0 0 0 0-5z"/></svg>';

  function findLabel(label) {
    return document.evaluate(
      `//*[not(self::script) and not(self::style)][normalize-space(text())="${label}"]`,
      document.body, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null,
    ).singleNodeValue;
  }

  function commonAncestor(a, b) {
    const seen = new Set();
    for (let x = a; x; x = x.parentElement) seen.add(x);
    for (let y = b; y; y = y.parentElement) if (seen.has(y)) return y;
    return null;
  }

  function addSettingsEntry() {
    if (!document.body || document.querySelector("[data-stoat-plus-settings]")) return;
    const appearance = findLabel("Appearance");
    const notifications = findLabel("Notifications");
    if (!appearance || !notifications) return;
    const list = commonAncestor(appearance, notifications);
    if (!list) return;

    // The entry to insert after: "Desktop" if it's in this list, else "Notifications".
    const desktop = findLabel("Desktop");
    const anchorLabel = desktop && list.contains(desktop) ? desktop : notifications;
    let anchor = anchorLabel;
    let depth = 0;
    while (anchor.parentElement !== list) { anchor = anchor.parentElement; depth++; }

    // Copy an entry that's never highlighted as the open page, so the copy isn't either.
    let source = anchor;
    let sourceLabel = anchorLabel;
    for (const name of ["Source Code", "What's New", "Feedback"]) {
      const el = findLabel(name);
      if (!el) continue;
      let item = el;
      for (let i = 0; i < depth && item.parentElement; i++) item = item.parentElement;
      if (item.tagName === anchor.tagName) { source = item; sourceLabel = el; break; }
    }

    const path = [];
    for (let x = sourceLabel; x !== source; x = x.parentElement) {
      path.unshift([...x.parentElement.children].indexOf(x));
    }
    const entry = source.cloneNode(true);
    let label = entry;
    for (const i of path) label = label.children[i];
    label.textContent = "Plugins";

    // Prefer the anchor's icon style (an icon-font glyph), set to "extension" (a puzzle piece).
    const isGlyph = (el, not) =>
      el !== not && el.children.length === 0 && /^[a-z_]+$/.test(el.textContent.trim());
    const anchorGlyph = [...anchor.querySelectorAll("*")].find((el) => isGlyph(el, anchorLabel));
    const oldIcon = entry.querySelector("svg") ||
      [...entry.querySelectorAll("*")].find((el) => isGlyph(el, label));
    const svg = entry.querySelector("svg");
    if (anchorGlyph && oldIcon) {
      const glyph = anchorGlyph.cloneNode(true);
      glyph.textContent = "extension";
      oldIcon.replaceWith(glyph);
    } else if (svg) {
      const tmp = document.createElement("div");
      tmp.innerHTML = PUZZLE_SVG;
      const icon = tmp.firstChild;
      for (const attr of ["class", "style", "width", "height"]) {
        if (svg.hasAttribute(attr)) icon.setAttribute(attr, svg.getAttribute(attr));
      }
      if (!svg.hasAttribute("width") && !svg.hasAttribute("class")) {
        icon.setAttribute("width", "20");
        icon.setAttribute("height", "20");
      }
      svg.replaceWith(icon);
    } else {
      // Icon font (Material Symbols): the icon is a short lowercase word.
      for (const el of entry.querySelectorAll("*")) {
        if (el !== label && el.children.length === 0 && /^[a-z_]+$/.test(el.textContent.trim())) {
          el.textContent = "extension";
          break;
        }
      }
    }

    for (const el of [entry, ...entry.querySelectorAll("*")]) {
      el.removeAttribute("href");
      el.removeAttribute("target");
      el.removeAttribute("aria-current");
      el.removeAttribute("aria-selected");
      el.removeAttribute("id");
    }
    entry.setAttribute("data-stoat-plus-settings", "");
    entry.setAttribute("role", "button");
    entry.style.cursor = "pointer";
    entry.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openManager();
    }, true);
    anchor.after(entry);
  }

  let domTimer = null;
  function onDomChange() {
    brandTitlebar();
    if (domTimer) return;
    domTimer = setTimeout(() => {
      domTimer = null;
      try { addSettingsEntry(); } catch (e) { console.warn("[Stoat+] settings entry", e); }
    }, 150);
  }
  new MutationObserver(onDomChange).observe(document, { childList: true, subtree: true });

  // ---------- loading ----------

  async function loadPlugins() {
    const files = native ? await native.listPlugins() : [];
    const list = await window.__stoatPlus.loadAll(files);
    markReady();
    if (managerOpen) renderManager();
    return list;
  }

  window.__stoatPlusBoot = function () {
    loadPlugins()
      .then((list) => {
        log(`loaded ${list.length} plugin(s), ${list.filter((p) => p.running).length} running`);
        if (!localStorage.getItem("stoatplus:welcomed")) {
          localStorage.setItem("stoatplus:welcomed", "1");
          toast("Stoat+ is ready. Press Ctrl+Shift+P to manage plugins.");
        }
      })
      .catch((e) => {
        markReady();
        log("failed to load plugins", e);
        toast("Stoat+ couldn't load plugins. Press Ctrl+Shift+P for details.");
      });

    window.addEventListener(
      "keydown",
      (e) => {
        if (e.ctrlKey && e.shiftKey && (e.key === "P" || e.key === "p")) {
          e.preventDefault();
          e.stopPropagation();
          managerOpen ? closeManager() : openManager();
        } else if (e.key === "Escape" && managerOpen) {
          e.preventDefault();
          e.stopPropagation();
          closeManager();
        }
      },
      true,
    );
    if (native) native.onOpenManager(() => openManager());
  };

  // ---------- plugin manager ----------

  let managerOpen = false;
  let managerHost = null;
  let managerRoot = null;
  const expanded = new Set();

  const MANAGER_CSS = `
    :host { all: initial; }
    .backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.55); z-index: 2147483646;
      display: flex; align-items: center; justify-content: center; font: 14px/1.45 system-ui, sans-serif; }
    .panel { background: #1e1f22; color: #e8e8ea; width: min(720px, calc(100vw - 32px));
      max-height: calc(100vh - 48px); border-radius: 14px; display: flex; flex-direction: column;
      box-shadow: 0 12px 48px rgba(0,0,0,.5); overflow: hidden; }
    header { display: flex; align-items: center; gap: 12px; padding: 16px 20px; border-bottom: 1px solid #2c2d31; }
    header h1 { font-size: 18px; margin: 0; flex: 1; font-weight: 600; }
    .bar { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px 20px; border-bottom: 1px solid #2c2d31; }
    .list { overflow: auto; padding: 12px 20px 20px; display: flex; flex-direction: column; gap: 10px; }
    .card { background: #2b2d31; border-radius: 10px; padding: 12px 14px; }
    .row { display: flex; align-items: flex-start; gap: 12px; }
    .info { flex: 1; min-width: 0; }
    .name { font-weight: 600; }
    .meta { color: #a3a6ad; font-size: 12px; }
    .desc { margin-top: 4px; color: #cfd1d5; }
    .err { margin-top: 6px; color: #ff8a8a; font-size: 12px; white-space: pre-wrap; }
    .badge { display: inline-block; font-size: 11px; padding: 1px 6px; border-radius: 6px; background: #3a3c42; color: #cfd1d5; margin-left: 6px; }
    button { font: inherit; color: #e8e8ea; background: #3a3c42; border: 0; border-radius: 8px; padding: 6px 12px; cursor: pointer; }
    button:hover { background: #45474e; }
    button.primary { background: #ff5b4f; color: #fff; }
    button.danger { background: transparent; color: #ff8a8a; }
    button.link { background: transparent; padding: 6px 8px; color: #a3a6ad; }
    input[type=text], input[type=number], textarea, select { font: inherit; color: #e8e8ea; background: #1e1f22;
      border: 1px solid #3a3c42; border-radius: 8px; padding: 6px 8px; width: 100%; box-sizing: border-box; }
    textarea { min-height: 84px; resize: vertical; font-family: ui-monospace, Consolas, monospace; font-size: 13px; }
    .settings { margin-top: 10px; padding-top: 10px; border-top: 1px solid #3a3c42; display: flex; flex-direction: column; gap: 10px; }
    .field label { display: block; font-size: 12px; color: #a3a6ad; margin-bottom: 4px; }
    .field .hint { font-size: 12px; color: #80838a; margin-top: 3px; }
    .check { display: flex; align-items: center; gap: 8px; }
    .switch { position: relative; width: 40px; height: 22px; flex: none; margin-top: 2px; }
    .switch input { opacity: 0; width: 0; height: 0; }
    .slider { position: absolute; inset: 0; background: #4e5058; border-radius: 22px; cursor: pointer; transition: .15s; }
    .slider::before { content: ""; position: absolute; width: 16px; height: 16px; left: 3px; top: 3px; background: #fff; border-radius: 50%; transition: .15s; }
    .switch input:checked + .slider { background: #3ba55d; }
    .switch input:checked + .slider::before { transform: translateX(18px); }
    .switch input:disabled + .slider { opacity: .4; cursor: not-allowed; }
    .install { display: flex; gap: 8px; padding: 0 20px 12px; }
    .empty { color: #a3a6ad; padding: 20px 0; text-align: center; }
    .cmds { color: #a3a6ad; font-size: 12px; padding: 0 20px 14px; }
    code { background: #1e1f22; padding: 1px 5px; border-radius: 5px; }
  `;

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "className") el.className = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return el;
  }

  function openManager() {
    if (!managerHost) {
      managerHost = document.createElement("div");
      managerHost.id = "stoat-plus-manager";
      managerRoot = managerHost.attachShadow({ mode: "open" });
    }
    if (!managerHost.isConnected) document.body.appendChild(managerHost);
    managerOpen = true;
    renderManager();
  }

  function closeManager() {
    managerOpen = false;
    if (managerHost) managerHost.remove();
  }

  let installOpen = false;

  function renderManager() {
    if (!managerRoot) return;
    const plugins = window.__stoatPlus.list();
    const commands = window.__stoatPlus.commands();

    const backdrop = h(
      "div",
      {
        className: "backdrop",
        onmousedown: (e) => {
          if (e.target === backdrop) closeManager();
        },
      },
      h(
        "div",
        { className: "panel" },
        h(
          "header",
          {},
          h("h1", {}, "Plugins"),
          h("span", { className: "meta" }, `Stoat+ runtime ${window.__stoatPlus.version}`),
          h("button", { className: "link", title: "Close (Esc)", onclick: closeManager }, "✕"),
        ),
        h(
          "div",
          { className: "bar" },
          h("button", { onclick: () => native && native.openFolder() }, "Open plugins folder"),
          h(
            "button",
            {
              onclick: () => {
                installOpen = !installOpen;
                renderManager();
              },
            },
            "Install from URL",
          ),
          h(
            "button",
            {
              onclick: async () => {
                await loadPlugins();
                toast("Plugins reloaded");
              },
            },
            "Reload plugins",
          ),
        ),
        installOpen ? renderInstall() : null,
        commands.length
          ? h(
              "div",
              { className: "cmds" },
              "Commands: ",
              ...commands.map((c) => h("code", { title: `${c.description} (${c.plugin})` }, `/${c.name}`)).flatMap((el, i) => (i ? [" ", el] : [el])),
            )
          : null,
        h(
          "div",
          { className: "list" },
          plugins.length
            ? plugins.map(renderPlugin)
            : h("div", { className: "empty" }, "No plugins yet. Put .js files in the plugins folder, then reload."),
        ),
      ),
    );

    managerRoot.replaceChildren(h("style", {}, MANAGER_CSS), backdrop);
  }

  function renderInstall() {
    const input = h("input", { type: "text", placeholder: "https://example.com/my-plugin.js" });
    const go = async () => {
      const url = input.value.trim();
      if (!url) return;
      try {
        const res = await native.install(url);
        toast(`Installed ${res.file}. Turn it on below.`);
        installOpen = false;
        await loadPlugins();
      } catch (e) {
        toast(`Install failed: ${String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "")}`);
      }
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") go();
    });
    setTimeout(() => input.focus(), 0);
    return h("div", { className: "install" }, input, h("button", { className: "primary", onclick: go }, "Install"));
  }

  function renderPlugin(p) {
    const toggle = h("input", {
      type: "checkbox",
      checked: p.enabled && p.supported,
      disabled: !p.supported,
      onchange: async (e) => {
        await window.__stoatPlus.setEnabled(p.id, e.target.checked);
        renderManager();
      },
    });
    const hasSettings = Object.keys(p.settingsSchema || {}).length > 0;
    const open = expanded.has(p.id);

    return h(
      "div",
      { className: "card" },
      h(
        "div",
        { className: "row" },
        h(
          "div",
          { className: "info" },
          h(
            "div",
            { className: "name" },
            p.name,
            !p.supported ? h("span", { className: "badge" }, `${p.platforms.join(", ")} only`) : null,
            p.platforms.length === 1 && p.supported ? h("span", { className: "badge" }, "desktop only") : null,
          ),
          h("div", { className: "meta" }, `v${p.version}${p.author ? ` · ${p.author}` : ""} · ${p.file}`),
          p.description ? h("div", { className: "desc" }, p.description) : null,
          p.error ? h("div", { className: "err" }, p.error) : null,
        ),
        hasSettings
          ? h(
              "button",
              {
                className: "link",
                onclick: () => {
                  open ? expanded.delete(p.id) : expanded.add(p.id);
                  renderManager();
                },
              },
              open ? "Hide settings" : "Settings",
            )
          : null,
        h(
          "button",
          {
            className: "danger",
            title: "Delete this plugin file",
            onclick: async () => {
              if (!confirm(`Delete ${p.name}? This removes ${p.file} from the plugins folder.`)) return;
              await window.__stoatPlus.setEnabled(p.id, false);
              window.__stoatPlus.forget(p.id);
              await native.remove(p.file);
              await loadPlugins();
            },
          },
          "Delete",
        ),
        h("label", { className: "switch", title: p.supported ? "On/off" : "Not available on desktop" }, toggle, h("span", { className: "slider" })),
      ),
      open && hasSettings ? renderSettings(p) : null,
    );
  }

  function renderSettings(p) {
    const save = (key, value) => window.__stoatPlus.setSetting(p.id, key, value);
    const fields = Object.entries(p.settingsSchema).map(([key, def]) => {
      const value = p.settings[key];
      const label = def.label || key;
      const hint = def.description ? h("div", { className: "hint" }, def.description) : null;
      let control;
      switch (def.type) {
        case "boolean":
          return h(
            "div",
            { className: "field" },
            h(
              "label",
              { className: "check" },
              h("input", { type: "checkbox", checked: !!value, onchange: (e) => save(key, e.target.checked) }),
              label,
            ),
            hint,
          );
        case "number":
          control = h("input", { type: "number", value: String(value ?? 0), onchange: (e) => save(key, Number(e.target.value)) });
          break;
        case "text":
          control = h("textarea", { onchange: (e) => save(key, e.target.value) });
          control.value = value ?? "";
          break;
        case "select": {
          control = h(
            "select",
            { onchange: (e) => save(key, e.target.value) },
            (def.options || []).map((o) => {
              const opt = typeof o === "string" ? { value: o, label: o } : o;
              return h("option", { value: opt.value, selected: opt.value === value }, opt.label || opt.value);
            }),
          );
          break;
        }
        default:
          control = h("input", { type: "text", value: value ?? "", onchange: (e) => save(key, e.target.value) });
      }
      return h("div", { className: "field" }, h("label", {}, label), control, hint);
    });
    return h("div", { className: "settings" }, fields);
  }
})();
