# Stoat+

Modified Stoat clients with a plugin loader for desktop (Windows) and Android.
Plugins are plain JavaScript files, and the same file runs on both. See [PLUGINS.md](PLUGINS.md).

| Folder | What it is |
| --- | --- |
| `shared/` | The plugin runtime (`runtime.js`) and example plugins. Both apps bundle these. |
| `desktop/` | Fork of `stoatchat/for-desktop` (branch `plugins`) |
| `android/` | Fork of `stoatchat/for-android` (branch `plugins`) |

## Building

- **Desktop:** run `build-desktop.bat`. The app ends up in `desktop\out\Stoat Plus-win32-x64\stoat-plus.exe`.
- **Android:** run `build-android.bat`. It produces `Stoat+.apk`, which you install on your phone.

Tests for the runtime: `node --test shared/test/runtime.test.mjs shared/test/android-host.test.mjs`

## Differences from the official apps

- Both apps install next to the official Stoat apps with their own login.
- Desktop doesn't auto-update. The official updater would replace it with the stock app.
- Android has no push notifications. They need Stoat's private Firebase config, so this build uses a placeholder.

## Updating from upstream

Both forks are git clones on a `plugins` branch:

```
cd desktop  (or android)
git fetch origin main --depth 50
git merge origin/main
```

Most Stoat+ changes are in new files, plus a few short blocks marked `Stoat+`.
