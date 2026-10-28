/** Neutral system-resume signal. Backends without this concept need not emit it. */
const listeners = new Set<() => void>();

export function onSystemResume(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function notifySystemResume(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (err) {
      console.error('[system-resume] Listener threw:', err);
    }
  }
}

export function __resetSystemResumeForTest(): void {
  listeners.clear();
}
