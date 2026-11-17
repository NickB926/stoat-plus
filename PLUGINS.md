# Writing Stoat+ plugins

A plugin is one `.js` file. The same file works on desktop and Android.

```js
/**
 * @name Hello
 * @id hello
 * @version 1.0.0
 * @author you
 * @description Says hi when you type /hello.
 * @platforms desktop, android
 */
definePlugin({
  settings: {
    greeting: { type: "string", label: "Greeting", default: "Hi there!" },
  },

  start(stoat) {
    stoat.commands.register({
      name: "hello",
      description: "Sends a greeting",
      run: (args) => `${stoat.settings.get("greeting")} ${args}`.trim(),
    });
  },

  stop(stoat) {
    // optional: everything registered through `stoat` is removed automatically
  },
});
```

## Header

The comment at the top is read without running the plugin.

| Tag | Meaning |
| --- | --- |
| `@id` | Unique id (letters, numbers, `-`, `_`, `.`). Defaults to the file name. |
| `@name` | Name shown in the plugin list. |
| `@version`, `@author`, `@description` | Shown in the list. |
| `@platforms` | `desktop`, `android` or both (default both). |

Plugins are **off** until you turn them on. Do your work in `start`, not at the top
of the file: the file is also run once just to read its settings.

## The `stoat` object

### Messages

- `stoat.onBeforeSend(fn)` runs when you send a message. `fn({ channelId, content, replyIds })` returns:
  - nothing: send it unchanged
  - a string, or `{ content }`: send this instead
  - `false`: don't send it
- `stoat.onMessage(fn)` runs on incoming messages, both live and from history. `fn({ id, channelId, authorId, content, live })` returns:
  - nothing: show it unchanged
  - a string: show this text instead (only on your screen)
  - `false`: hide it. Live messages disappear; history shows "*(hidden by a plugin)*" so scrolling back still works.
- `stoat.commands.register({ name, description, run(args, ctx) })` turns `/name args` into whatever `run` returns. If `run` returns nothing, nothing is sent. Unknown `/commands` are sent as normal text.

Hooks can be `async`. A hook that throws or takes more than 3 seconds is skipped, so a broken plugin can't stop you from sending.

All of these return a function that unregisters the hook.

### Settings and storage

- `settings` in `definePlugin` describes the settings form. Types:
  - `string`, `text` (multi-line), `number`, `boolean`
  - `select`, with `options: [{ value, label }]` or a list of strings
  - Each setting takes `label`, `description` and `default`.
- `stoat.settings.get(key)`, `.all()`, `.set(key, value)`, `.onChange((key, value, all) => ...)`
- `stoat.storage.get(key, fallback)`, `.set(key, value)`, `.remove(key)`. Values are JSON, saved per plugin.

### Everything else

- `stoat.toast(text)`: a short pop-up message
- `stoat.self().id`: your user id
- `stoat.api.request(method, path, body)`: calls the Stoat API as you, e.g. `stoat.api.request("GET", "/users/@me")`
- `stoat.api.sendMessage(channelId, content)`
- `stoat.platform`: `"desktop"` or `"android"`
- `stoat.log(...)`: logs to the dev console on desktop, and to logcat (tag `StoatPlus`) on Android
- `stoat.onUnload(fn)`: cleanup to run when the plugin is turned off
- Desktop only: `stoat.ui.addCSS(css)` returns a function that removes the CSS again. Desktop plugins also run in the page, so they can use `document`.

## Installing

- **Desktop:** press Ctrl+Shift+P (or use the tray icon, then Plugins…). From there you can open the plugins folder, install from a link, or reload.
- **Android:** Settings → Plugins → **+** (from a file or a link).

Plugins run inside the app with access to your account, so only install ones you trust.
