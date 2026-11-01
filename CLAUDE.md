# Kharcha — project context

Simple Android expense & budget tracker in PKR, built for the owner's personal Android phone.
Requirements from the owner: super simple, responsive, easy to use; categories with PKR budgets;
track spending; keep every previous month's data. They want a **real installable APK**, not a PWA/web app.

## Status (2026-11-01)
- v1.1 (credits, inline custom categories) built, signed and tested on an Android 15 emulator, including upgrading
  from v1.0 with data in place. Installable file: `Kharcha-v1.1.apk` (project root).
- Not yet verified on the real phone: the Share backup button (Android share sheet) and
  saving backups on Android 10 or older.

## Stack
- Plain HTML/CSS/JS (no framework, no build step for the app code) in `www/`.
- Wrapped as a native Android app with **Capacitor 8.5** (`android/` is the generated Gradle project).
- Plugins: `@capacitor/preferences` (main data store), `filesystem` + `share` (backups/CSV),
  `app` (back button).
- `src/native.js` is bundled by esbuild into `www/native.js` and exposes the plugins as `window.Native`.
  Plugin IIFE builds can't be loaded with plain `<script>` tags (filesystem expects a `synapse` global),
  so keep the esbuild step.
- `app.js` checks `Native` (null in a browser) so `www/` also still runs as a PWA (`sw.js`, `manifest.webmanifest`).

## Files
| Path | Purpose |
|---|---|
| `www/index.html` | Shell: top bar, month switcher, `#view`, FAB, tab bar |
| `www/app.js` | All app logic: state, budget model, rendering, sheets, backup, navigation |
| `www/styles.css` | Mobile-first styles, light/dark via `prefers-color-scheme` |
| `src/native.js` | Capacitor plugin bridge (bundled to `www/native.js`; don't edit the bundle) |
| `capacitor.config.json` | appId `com.kharcha.app`, webDir `www`, SystemBars insets = css |
| `android/app/build.gradle` | `versionCode`/`versionName`, release signing config |
| `keystore/kharcha-release.jks` + `android/keystore.properties` | Release signing key + passwords (secret, gitignored) |

## Data model (`app.js`)
Stored as JSON under key `kharcha.v1`, in Capacitor Preferences (source of truth in the app) and mirrored to localStorage.
- `categories[]`: `{id, name, icon, color, budget, archived}`. `budget` is the default for current and future months.
- `budgets{ 'YYYY-MM': { catId: amount } }`: per-month snapshot so editing a budget never rewrites past months.
  Months without a snapshot inherit the nearest earlier one (past) or the defaults (current/future).
- `expenses[]`: `{id, amount, catId, note, date:'YYYY-MM-DD', createdAt}`.
- `credits[]`: `{id, amount, note, date, createdAt}`: money received. `note` is the "From" field. Credits don't affect budgets;
  balance is that month's credit minus spending, with no carry-over between months.
- `migrate()` adds `credits` to data and backups from before v1.1. Run anything loaded or restored through it.
- Categories with expenses are archived (not deleted) so history still shows them.
- Backups are `{app:'kharcha', exportedAt, data}` JSON; restore also accepts a bare state object.

## Behaviour notes
- Android back button: handled by an `App.addListener('backButton')` in `app.js`: close sheet → go Home → minimise.
  The plugin's default only calls `webView.goBack()` and never exits, so don't rely on history in native mode.
- Safe areas: Capacitor injects `--safe-area-inset-*`; CSS uses `--safe-t`/`--safe-b` with `env()` fallback,
  plus a `body::before` strip behind the transparent status bar.
- Editing a category focuses and selects the budget field so typing replaces the old value.

## Build & run
Environment: JDK 21, Android SDK at `~/Android/Sdk` (platform 36, build-tools 36), Node 22 via nvm.
`ANDROID_HOME` is not set in non-interactive shells. Export it in commands:
```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22
export ANDROID_HOME=$HOME/Android/Sdk
npm run apk        # esbuild bundle + cap sync + signed release APK
npm run apk:debug  # debuggable build (WebView inspectable)
```
Output: `android/app/build/outputs/apk/release/app-release.apk`. Copy it to the root as `Kharcha-vX.Y.apk`.
For each release, bump `versionCode` and `versionName` in `android/app/build.gradle`.
Updates must be signed with the same keystore, or the owner has to uninstall, which loses on-device data.

## Testing
- Emulator AVD `kharcha_test` (android-35, x86_64, KVM). Start headless:
  `$ANDROID_HOME/emulator/emulator -avd kharcha_test -no-window -no-audio -gpu swiftshader_indirect -no-snapshot`
- Drive the WebView of a **debug** build over CDP: `adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>`,
  then `puppeteer-core` `connect({browserURL:'http://127.0.0.1:9333'})`. Screenshots: `adb exec-out screencap -p`.
- Debug and release builds have different signatures, so `adb uninstall com.kharcha.app` before switching.
- Programmatic `el.click()` gives no user activation, so pushState entries can be skipped by Back. Test the
  back button with `adb shell input keyevent 4`. Remember the first back press closes the soft keyboard.
- First launch on the emulator can show a blank screen for about 8 s while the WebView starts. That's not a bug.
