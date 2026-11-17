# Stoat+

*Unofficial. Not affiliated with Stoat or Revolt Platforms.*

Modified Stoat clients with a plugin loader for desktop (Windows) and Android.
Plugins are plain JavaScript files, and the same file runs on both. See [PLUGINS.md](PLUGINS.md).

| Folder | What it is |
| --- | --- |
| `shared/` | The plugin runtime (`runtime.js`) and example plugins. Both apps bundle these. |
| `desktop/` | Fork of `stoatchat/for-desktop` |
| `android/` | Fork of `stoatchat/for-android` |

## Installing

**Android:** get the APK from the [latest release](https://github.com/NickB926/stoat-plus/releases/latest) and open it on your phone.
For automatic updates, install [Obtainium](https://github.com/ImranR98/Obtainium), tap **Add app** and paste
`https://github.com/NickB926/stoat-plus`. Stoat+ also checks for updates itself (Settings → Plugins → Check for updates).

**Windows:** download the desktop zip from the latest release, unzip it, and run `stoat-plus.exe`.

## Releasing

1. Put the new version in `VERSION`, e.g. `1.0.1`, and commit.
2. Tag it and push: `git tag v1.0.1` then `git push origin main v1.0.1`.
3. GitHub Actions builds the signed APK and the desktop zip and publishes the release.

Releases are signed with the key in `keys/`, which isn't in the repo. Its passwords are stored
as GitHub secrets. **Back up the `keys` folder.** If the key is lost, phones can't update without
uninstalling, which wipes the login and plugins.

## Building

- **Desktop:** run `build-desktop.bat`. The app ends up in `desktop\out\Stoat Plus-win32-x64\stoat-plus.exe`.
- **Android:** run `build-android.bat`. It produces `Stoat+.apk`, which you install on your phone.

Tests for the runtime: `node --test shared/test/runtime.test.mjs shared/test/android-host.test.mjs`

## Differences from the official apps

- Both apps install next to the official Stoat apps with their own login.
- Desktop doesn't auto-update. The official updater would replace it with the stock app.
- Android has no push notifications. They need Stoat's private Firebase config, so this build uses a placeholder.

## Updating from upstream

`android/` and `desktop/` are git subtrees of the official repos:

```
git subtree pull --prefix android https://github.com/stoatchat/for-android main --squash
git subtree pull --prefix desktop https://github.com/stoatchat/for-desktop main --squash
```

Most Stoat+ changes are in new files, plus a few short blocks marked `Stoat+`.
