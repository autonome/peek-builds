/**
 * Web Tiles protocols — one declaration per protocol
 *
 * A protocol is declared once: its name, the capability that gates it, and its
 * methods as main-process handlers. From that single declaration come
 *
 *  - one IPC handler per method (`tile:protocol:<name>:<method>`), each
 *    checking the tile token (through the IPC gate) and the capability on
 *    every call, reporting a refusal the same way the hand-written
 *    `tile:*` handlers do;
 *  - the JavaScript module served to tiles at
 *    `peek://<tile-id>/.well-known/web-tiles/<name>.js`, which a tile loads
 *    with `await import('/.well-known/web-tiles/<name>.js')`;
 *  - the answer to "may this tile use this protocol", used both when serving
 *    the module and when deciding whether a tile that declares the protocol
 *    `required` in its manifest can be opened at all.
 *
 * Serving a module is NOT the security gate. A protocol module is page
 * JavaScript, and any tile can call the preload bridge directly whatever
 * modules it was served; the per-call check below is the gate. Leaving a
 * module unserved only gives a tile a clean "not available", so an unknown
 * protocol and one the tile was not granted get the same failure.
 *
 * Design and the reasoning behind every choice: docs/design/tile-protocols.md.
 */

import { registerTileIpc } from './tile-ipc-gate.js';
import { publishCapabilityViolation } from './tile-violations.js';
import { DEBUG, TILE_STRICT } from './config.js';
import type { CapabilityGrant, TileCapabilities, TileManifest } from './tile-manifest.js';

// ─── Declaration ────────────────────────────────────────────────────

/**
 * A protocol method's main-process implementation. It receives the caller's
 * capability grant, the arguments the tile passed, and the tile token (which
 * the existing `tile:*` handlers pass on to violation reports).
 */
export type ProtocolMethodHandler = (
  grant: CapabilityGrant,
  args: unknown[],
  token: string,
) => unknown | Promise<unknown>;

export interface TileProtocolDeclaration {
  /** The protocol name, as it appears in the module URL and the manifest. */
  name: string;
  /** The capability a tile must hold for this protocol to exist for it. */
  capability: keyof TileCapabilities;
  /** Method name -> main-process handler. The module exports exactly these. */
  methods: Record<string, ProtocolMethodHandler>;
}

/** How a tile's manifest may list a protocol it uses. */
export type ProtocolRequirement = 'required' | 'optional';

export const PROTOCOL_REQUIREMENTS: readonly ProtocolRequirement[] = ['required', 'optional'];

/** Where a protocol module is served from, under a tile's own origin. */
export const PROTOCOL_MODULE_PREFIX = '.well-known/web-tiles/';

/**
 * The legacy shared host. Pages on `peek://ext/<id>/` carry no tile identity
 * in the host, so they are never served protocols — they move to their own
 * `peek://<tile-id>/` host first.
 */
const LEGACY_SHARED_HOST = 'ext';

// ─── Registry ───────────────────────────────────────────────────────

const protocols = new Map<string, TileProtocolDeclaration>();

/**
 * Host-to-tile event queue, per tile, per protocol.
 *
 * A protocol module's handlers attach only after a dynamic `import()`
 * resolves, which is later than the preload's `tile:lifecycle:ready`. So a
 * protocol that pushes events must hold them per tile until that tile's own
 * protocol module signals ready, and then deliver the queue in order — the
 * queue lives here rather than in each protocol so no protocol can omit it.
 *
 * `atproto` pushes no events, so nothing enqueues yet: this holds the shape
 * and the place, not the mechanism. See docs/design/tile-protocols.md,
 * "Events from host to tile", for what goes here.
 */
const pendingProtocolEvents = new Map<string, Map<string, unknown[]>>();

/** Drop a tile's queued protocol events; called when the tile goes away. */
export function clearPendingProtocolEvents(tileId: string): void {
  pendingProtocolEvents.delete(tileId);
}

/** Registered protocol names, for diagnostics and tests. */
export function registeredProtocolNames(): string[] {
  return [...protocols.keys()].sort();
}

export function getTileProtocol(name: string): TileProtocolDeclaration | null {
  return protocols.get(name) ?? null;
}

/** Forget every registration — tests only. */
export function __resetTileProtocolsForTest(): void {
  protocols.clear();
  pendingProtocolEvents.clear();
}

// ─── Refusal reporting ──────────────────────────────────────────────

/**
 * Report a refused protocol call exactly as the hand-written `tile:*`
 * handlers do: publish a capability violation, and throw under TILE_STRICT.
 *
 * This duplicates `tile-ipc.ts handleViolation()` rather than importing it,
 * because that function is module-local to `tile-ipc.ts`, which imports
 * `electron` at the top level and so cannot be loaded by the main-process
 * unit runner (`ELECTRON_RUN_AS_NODE=1`).
 */
function reportProtocolViolation(
  grant: CapabilityGrant | null,
  capability: string,
  op: string,
  reason: string,
  token?: string,
): void {
  const msg = `[tile-protocols] ${op} rejected: ${reason}`;
  publishCapabilityViolation({
    tileId: grant?.tileId ?? null,
    capability,
    op,
    token,
    reason,
  });
  if (TILE_STRICT) throw new Error(msg);
  DEBUG && console.log(msg);
}

// ─── Gating ─────────────────────────────────────────────────────────

/**
 * Does this capability set hold `capability`? Same shape of test as
 * `tile-ipc.ts hasCapability()`: present and not `false`.
 */
function capabilitiesHold(
  capabilities: TileCapabilities | null | undefined,
  capability: keyof TileCapabilities,
): boolean {
  if (!capabilities) return false;
  const value = capabilities[capability];
  return value !== undefined && value !== false;
}

/**
 * May a tile with this capability grant call this protocol? A trustedBuiltin
 * grant bypasses the capability test, as it does for every other `tile:*`
 * handler.
 */
export function grantHoldsProtocol(grant: CapabilityGrant | null, name: string): boolean {
  const declaration = protocols.get(name);
  if (!declaration || !grant) return false;
  if (grant.trustedBuiltin) return true;
  return capabilitiesHold(grant.capabilities, declaration.capability);
}

/**
 * May a tile whose manifest declares these capabilities be served this
 * protocol's module? This is the serving-time question, asked of the
 * manifest rather than a live grant, because a module request arrives before
 * (and independently of) any token.
 */
export function capabilitiesHoldProtocol(
  name: string,
  capabilities: TileCapabilities | null | undefined,
): boolean {
  const declaration = protocols.get(name);
  if (!declaration) return false;
  return capabilitiesHold(capabilities, declaration.capability);
}

// ─── Module source ──────────────────────────────────────────────────

/**
 * The module a tile imports. Every method forwards through the one generic
 * preload bridge, so the module itself holds no privilege.
 */
export function buildProtocolModuleSource(name: string, methodNames: string[]): string {
  const call = (method: string) =>
    `export const ${method} = (...args) => __call(${JSON.stringify(method)}, args);`;
  return [
    `// Web Tiles protocol module for "${name}", served by Peek.`,
    `// Generated from the protocol's declaration in main/tile-protocols.ts.`,
    `const __bridge = globalThis.app && globalThis.app.tileProtocol;`,
    `if (typeof __bridge !== 'function') {`,
    `  throw new Error('web-tiles protocol bridge unavailable in this tile');`,
    `}`,
    `const __call = (method, args) => __bridge(${JSON.stringify(name)}, method, args);`,
    ...methodNames.map(call),
    `export default { ${methodNames.join(', ')} };`,
    ``,
  ].join('\n');
}

/**
 * The protocol name a tile-origin request is asking for, or `null` if the
 * request is not for a protocol module. `pathname` is the path within the
 * tile's own origin, without a leading slash.
 */
export function protocolNameFromPath(pathname: string): string | null {
  if (!pathname.startsWith(PROTOCOL_MODULE_PREFIX)) return null;
  const rest = pathname.slice(PROTOCOL_MODULE_PREFIX.length);
  if (!rest.endsWith('.js')) return null;
  const name = rest.slice(0, -'.js'.length);
  // One path segment only: no traversal, no nesting.
  if (name.length === 0 || name.includes('/')) return null;
  return name;
}

/**
 * The module source to serve for a request, or `null` to serve nothing —
 * which the caller turns into the same failed response a missing file gets,
 * so an unknown protocol and an ungranted one are indistinguishable to the
 * importing tile.
 *
 * Returns `null` for the legacy shared host, which carries no tile identity.
 */
export function protocolModuleForRequest(
  host: string,
  pathname: string,
  capabilities: TileCapabilities | null | undefined,
): string | null {
  if (host === LEGACY_SHARED_HOST) return null;
  const name = protocolNameFromPath(pathname);
  if (name === null) return null;
  const declaration = protocols.get(name);
  if (!declaration) return null;
  if (!capabilitiesHoldProtocol(name, capabilities)) return null;
  return buildProtocolModuleSource(name, Object.keys(declaration.methods));
}

// ─── Manifest `protocols` field ─────────────────────────────────────

/**
 * The protocols a manifest declares `required` that this host cannot give the
 * tile — either because no such protocol is registered, or because the tile
 * does not hold the gating capability. A tile with any of these is not opened.
 * An `optional` protocol never appears here.
 */
export function unsatisfiedRequiredProtocols(manifest: TileManifest): string[] {
  const declared = (manifest as { protocols?: Record<string, ProtocolRequirement> }).protocols;
  if (!declared) return [];
  const missing: string[] = [];
  for (const [name, requirement] of Object.entries(declared)) {
    if (requirement !== 'required') continue;
    if (!capabilitiesHoldProtocol(name, manifest.capabilities)) missing.push(name);
  }
  return missing;
}

// ─── Registration ───────────────────────────────────────────────────

/** The IPC channel a protocol method is reached on. */
export function protocolChannel(name: string, method: string): string {
  return `tile:protocol:${name}:${method}`;
}

/** The shape `registerTileIpc` is used with here. */
type IpcRegistrar = (
  channel: string,
  descriptor: Parameters<typeof registerTileIpc>[1],
  handler: (
    event: unknown,
    args: { token: string; args?: unknown[] },
    grant: CapabilityGrant,
  ) => unknown,
) => void;

// Indirection so the unit runner can observe the derived handlers without an
// `ipcMain` to register them on, the same seam `atproto-proxy.ts` uses for
// `net`. Production never replaces this.
let ipcRegistrar: IpcRegistrar = registerTileIpc as unknown as IpcRegistrar;

export function __setIpcRegistrarForTest(fake: IpcRegistrar | null): void {
  ipcRegistrar = fake ?? (registerTileIpc as unknown as IpcRegistrar);
}

/**
 * Declare a protocol: record it, and derive one IPC handler per method. The
 * gate checks the token and the sender; the wrapper below checks the
 * capability on every call and reports a refusal the same way the
 * hand-written handlers do.
 */
export function registerTileProtocol(declaration: TileProtocolDeclaration): void {
  if (protocols.has(declaration.name)) {
    throw new Error(`[tile-protocols] protocol already registered: ${declaration.name}`);
  }
  protocols.set(declaration.name, declaration);

  for (const [method, handler] of Object.entries(declaration.methods)) {
    ipcRegistrar(
      protocolChannel(declaration.name, method),
      { mode: 'handle', payloadSchema: { token: 'string', args: 'optional-array' } },
      async (_event, args: { token: string; args?: unknown[] }, grant) => {
        const op = `protocol:${declaration.name}:${method}`;
        if (!grantHoldsProtocol(grant, declaration.name)) {
          reportProtocolViolation(
            grant,
            String(declaration.capability),
            op,
            `${String(declaration.capability)} capability not granted`,
            args.token,
          );
          return { error: `${String(declaration.capability)} capability not granted` };
        }
        return handler(grant, Array.isArray(args.args) ? args.args : [], args.token);
      },
    );
  }
}
