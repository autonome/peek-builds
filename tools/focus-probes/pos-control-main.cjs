// pos-control-main.cjs — a self-contained Electron app that unconditionally
// creates a visible window and forces activation, then quits. Used as a
// LaunchServices (`open`) positive control to prove the frontmost oracle CAN
// observe an Electron app becoming frontmost — disambiguating "exec-launched
// electron never activates" from "oracle can't see electron".
const { app, BrowserWindow } = require('electron');
app.on('window-all-closed', () => {});
app.whenReady().then(() => {
  const win = new BrowserWindow({ show: true, width: 400, height: 300 });
  win.focus();
  app.focus({ steal: true });
  setTimeout(() => app.quit(), 2500);
});
