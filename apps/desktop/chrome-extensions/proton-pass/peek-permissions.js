/* Peek: chrome.permissions early-install shim. See patch-chrome-extensions.js. */
(function() {
  var DEBUG_PERMISSIONS = false;
  function _log() { if (DEBUG_PERMISSIONS) console.log.apply(console, ['[peek:permissions:html]'].concat(Array.prototype.slice.call(arguments))); }

  // Surface popup-side unhandled errors / rejections to main stderr
  // via console.error. These would otherwise be swallowed by Proton's
  // Sentry handler before any visible UI feedback.
  try {
    window.addEventListener('error', function(ev) {
      try {
        var stack = ev.error && ev.error.stack ? ev.error.stack : '(no stack)';
        console.error('[peek:popup-error]', ev.message, '@', ev.filename + ':' + ev.lineno + ':' + ev.colno, '\n', stack);
      } catch(_) {}
    }, true);
    window.addEventListener('unhandledrejection', function(ev) {
      try {
        var r = ev.reason;
        var msg = r && r.message ? r.message : String(r);
        var stack = r && r.stack ? r.stack : '(no stack)';
        console.error('[peek:popup-unhandledrejection]', msg, '\n', stack);
      } catch(_) {}
    }, true);
  } catch(e) {}

  function NoopEvent() { this._l = []; }
  NoopEvent.prototype.addListener = function(fn) { this._l.push(fn); };
  NoopEvent.prototype.removeListener = function(fn) { this._l = this._l.filter(function(x) { return x !== fn; }); };
  NoopEvent.prototype.hasListener = function(fn) { return this._l.indexOf(fn) !== -1; };
  NoopEvent.prototype.hasListeners = function() { return this._l.length > 0; };

  function _clearLastError(c) { try { delete c.runtime.lastError; } catch(e) {} }

  var _real;
  function _getChrome() { return _real; }

  var _permsObj = {
    request: function(perms, callback) {
      _log('request:', JSON.stringify(perms));
      _clearLastError(_getChrome());
      if (typeof callback === 'function') callback(true);
      return Promise.resolve(true);
    },
    contains: function(perms, callback) {
      _log('contains:', JSON.stringify(perms));
      _clearLastError(_getChrome());
      if (typeof callback === 'function') callback(true);
      return Promise.resolve(true);
    },
    getAll: function(callback) {
      var c = _getChrome();
      var result = { permissions: [], origins: [] };
      try {
        if (c && c.runtime && c.runtime.getManifest) {
          var m = c.runtime.getManifest();
          result = { permissions: m.permissions || [], origins: m.host_permissions || [] };
        }
      } catch(e) {}
      _clearLastError(c);
      if (typeof callback === 'function') callback(result);
      return Promise.resolve(result);
    },
    remove: function(perms, callback) {
      _clearLastError(_getChrome());
      if (typeof callback === 'function') callback(true);
      return Promise.resolve(true);
    },
    onAdded: new NoopEvent(),
    onRemoved: new NoopEvent(),
  };
  globalThis.__peekPermissions = _permsObj;

  // chrome.tabs.create polyfill: Electron's native chrome.tabs in extension
  // popup BrowserWindow contexts exposes query() but not create(). Proton's
  // login-click handler calls chrome.tabs.create({url: forkAuthUrl}) and
  // throws TypeError if absent — its .finally then unconditionally
  // window.close()s the popup, so the user sees a popup that disappears with
  // no visible auth page. We delegate to window.open(url, '_blank'); the
  // popup BrowserWindow's setWindowOpenHandler routes through invokeWindowOpen
  // and opens the URL as a Peek page tile.
  var _fakeTabId = 1000;
  function _peekTabsCreate(props, callback) {
    var url = (props && props.url) || 'about:blank';
    try { window.open(url, '_blank'); } catch(_) {}
    var tab = { id: ++_fakeTabId, index: 0, windowId: 0, active: true, url: url, title: '', highlighted: false, pinned: false, incognito: false, selected: false };
    if (typeof callback === 'function') { try { callback(tab); } catch(_) {} }
    return Promise.resolve(tab);
  }

  function _patchChrome(c) {
    if (!c || typeof c !== 'object') return;
    try {
      Object.defineProperty(c, 'permissions', { value: _permsObj, writable: true, configurable: true, enumerable: true });
      _log('installed chrome.permissions on captured chrome');
    } catch(e) {
      try { c.permissions = _permsObj; _log('installed via assignment'); }
      catch(e2) { _log('install failed:', e.message, '/', e2.message); }
    }

    try {
      if (c.tabs && typeof c.tabs.create !== 'function') {
        try { c.tabs.create = _peekTabsCreate; _log('installed chrome.tabs.create polyfill'); }
        catch(_) {
          try { Object.defineProperty(c.tabs, 'create', { value: _peekTabsCreate, writable: true, configurable: true, enumerable: true }); _log('installed chrome.tabs.create via defineProperty'); }
          catch(_) {}
        }
      }
    } catch(_) {}
  }

  // Install an accessor that always returns our patched chrome and
  // silently swallows reassignments. Proton's bundled "extension API
  // isolation" runs globalThis.chrome = proxy inside a forEach loop;
  // a throwing lock (writable:false) aborts that forEach and breaks
  // popup init. A no-op setter lets the assignment "succeed" without
  // actually replacing what the binding returns.
  function _installLock() {
    try {
      Object.defineProperty(globalThis, 'chrome', {
        configurable: false, enumerable: true,
        get: function() { return _real; },
        set: function() { /* swallow — Proton's chrome rewrap is a no-op */ },
      });
      _log('chrome accessor-locked');
    } catch(e) { _log('lock globalThis.chrome failed:', e.message); }
  }

  if (typeof chrome !== 'undefined' && chrome) {
    _real = chrome;
    _patchChrome(_real);
    _installLock();
    return;
  }

  // chrome not yet defined. Install accept-once setter to capture
  // Electron's assignment, then convert to a locked accessor.
  try {
    Object.defineProperty(globalThis, 'chrome', {
      configurable: true,
      enumerable: true,
      get: function() { return _real; },
      set: function(v) {
        _real = v;
        _patchChrome(_real);
        // Replace this accept-once accessor with the silent-swallow lock.
        _installLock();
      },
    });
    _log('chrome accept-once setter installed');
  } catch(e) { _log('chrome setter install failed:', e.message); }
})();
