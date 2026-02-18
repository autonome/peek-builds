export declare const keyToCode: Record<string, string>;

export interface ParsedShortcut {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  code: string;
}

export interface InputEvent {
  type: string;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  control: boolean;
  code: string;
}

export interface ModeConditions {
  majorMode?: string;
}

export declare function parseShortcut(shortcut: string): ParsedShortcut;

export declare function inputMatchesShortcut(
  input: InputEvent,
  parsed: ParsedShortcut
): boolean;

export interface ShortcutRegistry {
  register(
    shortcut: string,
    source: string,
    callback: () => void,
    modeConditions?: ModeConditions
  ): void;
  unregister(
    shortcut: string,
    source?: string,
    modeConditions?: ModeConditions
  ): void;
  handle(input: InputEvent, focusedWindowId?: number): boolean;
  unregisterAll(address: string): void;
  clear(): void;
}

export declare function createShortcutRegistry(options?: {
  checkModeConditions?: (windowId: number, majorMode: string) => boolean;
  debug?: boolean;
}): ShortcutRegistry;
