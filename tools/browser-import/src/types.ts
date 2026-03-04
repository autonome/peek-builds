/**
 * Shared types for browser-import tool
 */

export interface BrowserProfile {
  browser: BrowserName;
  profileName: string;
  profilePath: string;
  dataFiles: DataFileInfo[];
}

export type BrowserName = 'firefox' | 'chrome' | 'brave';

export interface DataFileInfo {
  type: DataType;
  path: string;
  exists: boolean;
  importable: boolean;
}

export type DataType = 'history' | 'bookmarks' | 'sessions' | 'passwords' | 'cookies' | 'formdata' | 'extensions';

export interface DataInspection {
  type: DataType;
  count: number;
  importable: boolean;
  label: string;
}

export interface HistoryEntry {
  url: string;
  title: string;
  visitCount: number;
  lastVisitTime: number; // Unix ms
  /** Individual visit timestamps (Firefox moz_historyvisits, Chrome visits table) */
  visits?: VisitRecord[];
}

export interface VisitRecord {
  timestamp: number; // Unix ms
  /** Firefox visit type: 1=LINK, 2=TYPED, 3=BOOKMARK, etc. */
  visitType?: number;
}

export interface BookmarkEntry {
  url: string;
  title: string;
  folderPath: string;
  dateAdded: number; // Unix ms
}

export interface SessionTab {
  url: string;
  title: string;
  tabGroup?: string;
  pinned?: boolean;
  lastAccessed?: number; // Unix ms
  windowIndex?: number;
}

export interface ImportResult {
  itemsImported: number;
  tagsCreated: number;
  duplicatesSkipped: number;
  errors: string[];
}

export type ImportType = 'history' | 'bookmarks' | 'sessions';
