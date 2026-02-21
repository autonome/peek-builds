/**
 * Generic OAuth loopback HTTP server for handling OAuth callbacks.
 *
 * Starts a temporary HTTP server on 127.0.0.1 with an OS-assigned port.
 * Returns the port so the caller can build a redirect_uri, then waits
 * for the OAuth callback GET request and returns the query parameters.
 *
 * Reusable by any extension or future OAuth flow.
 */

import * as http from 'node:http';

const SUCCESS_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Authorization Complete</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#1a1a1a;color:#e0e0e0}
.card{text-align:center;padding:2rem}.check{font-size:3rem;margin-bottom:1rem}</style></head>
<body><div class="card"><div class="check">&#10003;</div><p>Authorization complete. Closing...</p></div>
<script>setTimeout(function(){window.close()},500)</script></body></html>`;

interface LoopbackServer {
  port: number;
  waitForCallback: () => Promise<{ params: Record<string, string> }>;
  cancel: () => void;
}

export function createLoopbackServer(opts?: {
  callbackPath?: string;
  timeoutMs?: number;
}): Promise<LoopbackServer> {
  const callbackPath = opts?.callbackPath ?? '/callback';
  const timeoutMs = opts?.timeoutMs ?? 120_000;

  return new Promise((resolveOuter, rejectOuter) => {
    let settled = false;
    let callbackResolve: (value: { params: Record<string, string> }) => void;
    let callbackReject: (reason: Error) => void;

    const callbackPromise = new Promise<{ params: Record<string, string> }>((res, rej) => {
      callbackResolve = res;
      callbackReject = rej;
    });

    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', `http://127.0.0.1`);

      if (req.method === 'GET' && url.pathname === callbackPath) {
        const params: Record<string, string> = {};
        url.searchParams.forEach((v, k) => { params[k] = v; });

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(SUCCESS_HTML);

        callbackResolve!({ params });
        cleanup();
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      }
    });

    const timeout = setTimeout(() => {
      if (!settled) {
        callbackReject!(new Error('OAuth callback timed out'));
        cleanup();
      }
    }, timeoutMs);

    function cleanup() {
      settled = true;
      clearTimeout(timeout);
      try { server.close(); } catch {}
    }

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        rejectOuter(new Error('Failed to bind loopback server'));
        return;
      }

      resolveOuter({
        port: addr.port,
        waitForCallback: () => callbackPromise,
        cancel: () => {
          if (!settled) {
            callbackReject!(new Error('OAuth flow cancelled'));
            cleanup();
          }
        },
      });
    });

    server.on('error', (err) => {
      if (!settled) {
        rejectOuter(err);
        cleanup();
      }
    });
  });
}
