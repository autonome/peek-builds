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
//   PROBE_WINDOW       — window creation mode, to localize WHAT grabs focus:
//                          'none'        — no window (bare process)
//                          'inactive'    — BrowserWindow({show:false}) then
//                                          showInactive() + opacity 0 (the
//                                          real app's HEADLESS path)
//                          'show'        — BrowserWindow({show:true}) (a real
//                                          visible window activates the app)
//                          'hidden'      — BrowserWindow({show:false}), never
//                                          shown
const { app, BrowserWindow } = require('electron');

app.on('window-all-closed', () => { /* keep alive regardless of windows */ });

app.whenReady().then(() => {
  if (process.platform === 'darwin' && process.env.PROBE_JS_ACCESSORY === '1') {
    app.setActivationPolicy('accessory');
  }

  const mode = process.env.PROBE_WINDOW || 'none';
  if (mode !== 'none') {
    const win = new BrowserWindow({ show: false, width: 400, height: 300 });
    if (mode === 'inactive') {
      win.setOpacity(0);
      win.showInactive();
    } else if (mode === 'show') {
      win.show();
    }
    // 'hidden' → leave it {show:false}, never call any show
    if (process.env.PROBE_ACTIVATE === '1') {
      // Explicit app-level activation — positive control: does an
      // exec-launched Electron become frontmost when it forces activation?
      win.show();
      win.focus();
      app.focus({ steal: true });
    }
  }

  const hold = Number(process.env.PROBE_HOLD_MS || 2500);
  setTimeout(() => app.quit(), hold);
});
