// Standalone Electron reproducer for v2 tile pubsub pattern.
// Two BrowserWindows, sandboxed + contextIsolated, share a CJS preload.
// Main process records subscriptions and broadcasts publishes to other windows.

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const LOG_PATH = '/tmp/v2-pubsub-mini.log';
fs.writeFileSync(LOG_PATH, '');

function log(...args) {
  const line = `[main ${new Date().toISOString()}] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}`;
  console.error(line);
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch {}
}

log('main starting');

// topic -> Set<webContentsId>
const subs = new Map();
// Track windows by id for broadcasting
const tileWindows = new Set();

function recordSub(senderId, topic) {
  if (!subs.has(topic)) subs.set(topic, new Set());
  subs.get(topic).add(senderId);
  log('recorded subscription', { senderId, topic, current: [...subs.get(topic)] });
}

function broadcast(topic, data, exceptId) {
  const recipients = subs.get(topic);
  log('broadcast', { topic, data, exceptId, recipients: recipients ? [...recipients] : null });
  if (!recipients) return 0;
  let n = 0;
  for (const win of tileWindows) {
    if (win.isDestroyed()) continue;
    const wcid = win.webContents.id;
    if (wcid === exceptId) continue;
    if (!recipients.has(wcid)) continue;
    log('  -> sending pubsub:message to wcid', wcid);
    win.webContents.send('pubsub:message', { topic, data });
    n++;
  }
  return n;
}

// IPC handlers (registered BEFORE creating windows)
ipcMain.on('tile:pubsub:subscribe', (evt, { topic }) => {
  log('IPC tile:pubsub:subscribe', { topic, sender: evt.sender.id });
  recordSub(evt.sender.id, topic);
});

ipcMain.on('tile:pubsub:unsubscribe', (evt, { topic }) => {
  log('IPC tile:pubsub:unsubscribe', { topic, sender: evt.sender.id });
  subs.get(topic)?.delete(evt.sender.id);
});

ipcMain.on('tile:pubsub:publish', (evt, { topic, data }) => {
  log('IPC tile:pubsub:publish', { topic, data, sender: evt.sender.id });
  const n = broadcast(topic, data, evt.sender.id);
  log('broadcast complete', { delivered: n });
});

ipcMain.on('mini:log', (evt, msg) => {
  log(`[renderer wcid=${evt.sender.id}] ${msg}`);
});

function createWindow(htmlPath, title) {
  const win = new BrowserWindow({
    width: 600,
    height: 400,
    title,
    show: false, // headless-ish; we just need them loaded
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  tileWindows.add(win);
  win.on('closed', () => tileWindows.delete(win));
  win.webContents.on('console-message', (_e, _level, message, line, source) => {
    log(`[wc ${win.webContents.id} console] ${message}`);
  });
  win.webContents.on('did-finish-load', () => {
    log(`window ${title} (wcid=${win.webContents.id}) finished loading`);
  });
  win.loadFile(htmlPath);
  return win;
}

app.whenReady().then(async () => {
  log('app ready');

  const sub = createWindow(path.join(__dirname, 'subscriber.html'), 'subscriber');
  const pub = createWindow(path.join(__dirname, 'publisher.html'), 'publisher');

  // Wait for both to finish loading
  await Promise.all([
    new Promise(r => sub.webContents.once('did-finish-load', r)),
    new Promise(r => pub.webContents.once('did-finish-load', r)),
  ]);
  log('both windows loaded; subscriber=' + sub.webContents.id + ' publisher=' + pub.webContents.id);

  // Give subscriber a beat to register its subscription
  await new Promise(r => setTimeout(r, 250));

  log('=== auto-test: triggering publish from publisher window ===');
  // Ask publisher to publish via executeJavaScript (no user click needed)
  const result = await pub.webContents.executeJavaScript(
    "window.app.publish('test-topic', {hello: 'world', ts: Date.now()})"
  );
  log('publish call result from publisher renderer:', result);

  // Wait up to 1s for subscriber to receive
  const start = Date.now();
  let received = null;
  while (Date.now() - start < 1000) {
    received = await sub.webContents.executeJavaScript('window.__received || null');
    if (received) break;
    await new Promise(r => setTimeout(r, 50));
  }

  if (received) {
    log('=== ASSERTION PASS: subscriber received ===', received);
    log('VERDICT: STANDALONE_WORKS');
  } else {
    log('=== ASSERTION FAIL: subscriber did NOT receive within 1s ===');
    log('VERDICT: STANDALONE_FAILS');
  }

  // Quit shortly after so we get clean stdout
  setTimeout(() => {
    log('quitting');
    app.quit();
  }, 250);
});

app.on('window-all-closed', () => app.quit());
