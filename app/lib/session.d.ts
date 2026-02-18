/**
 * Session snapshot — shared pure logic for save/restore.
 *
 * Contains type definitions, URL extraction, parameter sanitization,
 * snapshot validation, crash detection heuristics, and restore
 * sequencing/ordering logic.
 *
 * @module session
 */

// ============================================================================
// Type definitions
// ============================================================================

export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowContext {
  mode: string | null;
  modeMetadata: Record<string, unknown> | null;
}

export interface WindowDescriptor {
  url: string;
  key: string | undefined;
  title: string;
  bounds: Rectangle;
  source: string;
  params: Record<string, unknown>;
  zOrder: number;
  focused: boolean;
  context?: WindowContext;
}

export interface SessionMetadata {
  lastSaveReason: string;
  lastSaveAt: number;
  windowCount: number;
  cleanShutdown: boolean;
  crashCount: number;
  lastRestoreAt?: number;
  restoreCount?: number;
}

export interface SessionSnapshot {
  version: 1;
  createdAt: number;
  reason: 'before-quit' | 'autosave' | 'manual';
  windows: WindowDescriptor[];
}

// ============================================================================
// Constants
// ============================================================================

export declare const MAX_CRASH_COUNT: number;
export declare const RESTORE_STRIP_KEYS: Set<string>;
export declare const SYSTEM_WINDOW_URLS: string[];

// ============================================================================
// URL extraction
// ============================================================================

export declare function extractRealUrl(url: string): string;
export declare function extractCanvasBounds(url: string): Rectangle | null;

// ============================================================================
// Parameter sanitization
// ============================================================================

export declare function sanitizeParams(params: Record<string, unknown>): Record<string, unknown>;
export declare function stripRestoreParams(params: Record<string, unknown>): Record<string, unknown>;

// ============================================================================
// Snapshot validation
// ============================================================================

export declare function isValidDescriptor(descriptor: WindowDescriptor): boolean;
export declare function isSystemWindowUrl(url: string): boolean;
export declare function validateSnapshot(snapshot: SessionSnapshot): { validWindows: WindowDescriptor[] } | null;

// ============================================================================
// Crash detection heuristics
// ============================================================================

export declare function determineCrashAction(
  wasCleanShutdown: boolean,
  crashCount: number
): 'restore' | 'ask' | 'skip';

export declare function computeCrashCount(
  wasCleanShutdown: boolean,
  previousCrashCount: number
): number;

// ============================================================================
// Restore sequencing / ordering
// ============================================================================

export declare function sortWindowsByZOrder(windows: WindowDescriptor[]): WindowDescriptor[];

export declare function computeRestoreBounds(
  bounds: Rectangle,
  isOnScreen: (x: number, y: number) => boolean
): { width: number; height: number; x?: number; y?: number };

export declare function buildRestoreOptions(
  descriptor: WindowDescriptor,
  isOnScreen: (x: number, y: number) => boolean
): Record<string, unknown>;

// ============================================================================
// Restore result analysis
// ============================================================================

export declare function isPartialRestore(result: {
  restored: number;
  failed: number;
  total: number;
}): boolean;

// ============================================================================
// Snapshot construction helpers
// ============================================================================

export declare function buildSnapshot(
  windows: WindowDescriptor[],
  reason: 'before-quit' | 'autosave' | 'manual'
): SessionSnapshot;

export declare function buildMetadata(
  reason: 'before-quit' | 'autosave' | 'manual',
  windowCount: number,
  existing?: Partial<SessionMetadata>,
  opts?: { cleanShutdown?: boolean }
): SessionMetadata;
