/**
 * Page-side instrumentation for harness scenarios.
 *
 * Injected via CDP `Page.addScriptToEvaluateOnNewDocument` so it runs in main
 * world before any page script on every new document. Useful when the page
 * under test is silently catching errors (Sentry, try/catch around feature
 * detection, etc.) — we wrap the obvious channels so the swallowed signals
 * surface as console output that the tracer captures.
 *
 * What it does (all logs prefixed `[peek-instrument]` for grep):
 *   - Proxies `window.chrome.runtime` so every property access and method
 *     call is logged with the property name and (for calls) arguments.
 *   - Adds `window.addEventListener('error', ...)` and
 *     `'unhandledrejection'` to capture trapped errors.
 *   - Wraps `console.error` / `console.warn` to also log via `console.log`
 *     under the instrument prefix (Sentry sometimes monkey-patches these to
 *     swallow them; logging via console.log preserves a copy).
 *   - Wraps `window.fetch` to log URLs and statuses (network is already
 *     captured by CDP, but having a page-side fetch log lets us correlate
 *     calls back to the JS callsite via stacks).
 *
 * Designed to be safe to inject on every page (no-op if chrome / fetch / etc.
 * aren't there).
 */

export function getInstrumentationSource(): string {
  return `(function(){
    if (window.__peekInstrumented) return;
    window.__peekInstrumented = true;

    var TAG = '[peek-instrument]';
    var origLog = console.log.bind(console);
    function logTag() {
      var args = [TAG].concat(Array.prototype.slice.call(arguments));
      try { origLog.apply(console, args); } catch (_) {}
    }

    // ---- chrome.runtime Proxy (with re-wrap loop) ----
    // Race note: this script registers via CDP addScriptToEvaluateOnNewDocument
    // and runs early in main world. Our runtime-external polyfill ALSO runs
    // early (preload + addScriptToEvaluateOnNewDocument) and replaces
    // chrome.runtime via defineProperty. Whichever runs second wins. We tag
    // any Proxy we install with __peekRuntimeProxyTagged on the parent
    // window.chrome (Proxy itself can't carry custom marker reliably) and
    // re-wrap on a few microtask/timeout ticks so we end up wrapping the
    // polyfill (or native, whichever survives).
    var seen = {};
    function makeRuntimeProxy(rt) {
      return new Proxy(rt, {
        get: function(target, prop, receiver) {
          var key = String(prop);
          if (!seen[key]) { seen[key] = 0; }
          seen[key]++;
          if (seen[key] === 1 || seen[key] % 50 === 0) {
            logTag('chrome.runtime GET', key, '#' + seen[key]);
          }
          var v = Reflect.get(target, prop, receiver);
          if (typeof v === 'function') {
            return function() {
              var argv = Array.prototype.slice.call(arguments);
              var argSummary;
              try { argSummary = JSON.stringify(argv).slice(0, 300); }
              catch (_) { argSummary = '(unserializable args)'; }
              logTag('chrome.runtime CALL', key, argSummary);
              try {
                var r = v.apply(target, argv);
                if (r && typeof r.then === 'function') {
                  r.then(function(rv){
                    var rs;
                    try { rs = JSON.stringify(rv).slice(0, 300); } catch (_) { rs = '(unserializable)'; }
                    logTag('chrome.runtime RESOLVE', key, rs);
                  }, function(re){
                    logTag('chrome.runtime REJECT', key, (re && re.message) || String(re));
                  });
                }
                return r;
              } catch (e) {
                logTag('chrome.runtime THREW', key, (e && e.message) || String(e));
                throw e;
              }
            };
          }
          return v;
        },
      });
    }
    function installProxy(reason) {
      try {
        if (!window.chrome || !window.chrome.runtime) return false;
        var c = window.chrome;
        // window.chrome.__peekProxiedRuntimeRef points at the underlying
        // runtime object we last wrapped. If it matches the current value,
        // chrome.runtime IS our proxy already — skip.
        if (c.__peekProxiedRuntimeRef === c.runtime) return false;
        var underlying = c.runtime;
        var proxy = makeRuntimeProxy(underlying);
        Object.defineProperty(c, 'runtime', {
          value: proxy, writable: true, configurable: true, enumerable: true,
        });
        c.__peekProxiedRuntimeRef = proxy;
        logTag('chrome.runtime proxy installed', reason || '', 'on', location.href);
        return true;
      } catch (e) {
        logTag('chrome.runtime proxy install FAILED', (e && e.message) || String(e));
        return false;
      }
    }
    installProxy('immediate');
    queueMicrotask(function(){ installProxy('microtask'); });
    setTimeout(function(){ installProxy('t+0'); }, 0);
    setTimeout(function(){ installProxy('t+50'); }, 50);
    setTimeout(function(){ installProxy('t+250'); }, 250);
    setTimeout(function(){ installProxy('t+1000'); }, 1000);

    // ---- Error / rejection listeners ----
    window.addEventListener('error', function(ev) {
      logTag('window.error',
        (ev.error && ev.error.message) || ev.message,
        ev.filename + ':' + ev.lineno + ':' + ev.colno);
      if (ev.error && ev.error.stack) {
        logTag('window.error stack', String(ev.error.stack).slice(0, 1000));
      }
    }, true);
    window.addEventListener('unhandledrejection', function(ev) {
      var r = ev.reason;
      logTag('unhandledrejection',
        (r && r.message) || String(r),
        (r && r.stack) ? String(r.stack).slice(0, 1000) : '(no stack)');
    }, true);

    // ---- console.error / console.warn wrapping ----
    var origErr = console.error.bind(console);
    var origWarn = console.warn.bind(console);
    console.error = function() {
      var argv = Array.prototype.slice.call(arguments);
      try { logTag.apply(null, ['console.error'].concat(argv)); } catch (_) {}
      try { origErr.apply(console, argv); } catch (_) {}
    };
    console.warn = function() {
      var argv = Array.prototype.slice.call(arguments);
      try { logTag.apply(null, ['console.warn'].concat(argv)); } catch (_) {}
      try { origWarn.apply(console, argv); } catch (_) {}
    };

    // ---- fetch wrapping (best-effort; CDP already captures responses) ----
    if (typeof window.fetch === 'function') {
      var origFetch = window.fetch.bind(window);
      window.fetch = function(input, init) {
        var url = (typeof input === 'string') ? input : (input && input.url) || '';
        if (url.indexOf('account.proton.me') !== -1 || url.indexOf('proton.me/api') !== -1) {
          logTag('fetch CALL', (init && init.method) || 'GET', url);
        }
        return origFetch(input, init).then(function(res){
          if (url.indexOf('account.proton.me') !== -1 || url.indexOf('proton.me/api') !== -1) {
            logTag('fetch RESP', res.status, url);
          }
          return res;
        }, function(err){
          logTag('fetch FAIL', (err && err.message) || String(err), url);
          throw err;
        });
      };
    }

    logTag('instrumentation installed on', location.href);
  })();`;
}
