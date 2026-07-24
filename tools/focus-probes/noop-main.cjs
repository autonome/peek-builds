// noop-main.cjs — the smallest possible Electron "app" for isolating the
// macOS launch-time focus grab.
//
// The suite's focus theft happens PRE-JS: macOS activates a fresh 'regular'
// Electron process frontmost the instant NSApplication finishes launching,
// before any app code runs. So we need NO window and NO app logic to
// reproduce it — a bare `app.whenReady()` process already becomes the active
// app if the bundle's activation policy is 'regular'. That isolates the ONE
// variable under test: does the launched bundle start as accessory (no grab)
// or regular (grab)?
//
// Env:
//   PROBE_HOLD_MS      — how long to stay alive before quitting (default 2500)
//   PROBE_JS_ACCESSORY — if '1', call setActivationPolicy('accessory') in JS
//                        after whenReady (the "too-late" path — proves JS
//                        cannot undo the pre-JS grab).
const { app } = require('electron');

app.on('window-all-closed', () => { /* keep alive; we never open a window */ });

app.whenReady().then(() => {
  if (process.platform === 'darwin' && process.env.PROBE_JS_ACCESSORY === '1') {
    app.setActivationPolicy('accessory');
  }
  const hold = Number(process.env.PROBE_HOLD_MS || 2500);
  setTimeout(() => app.quit(), hold);
});
