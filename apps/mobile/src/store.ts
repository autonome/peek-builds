// Dependency-free external store for the unified item list.
//
// Filtering / sorting / pagination now live in SQL (Rust `query_items` command).
// The frontend keeps a single page-able list here and fetches more on scroll,
// instead of loading all items and filtering in JS on every keystroke.
//
// Consumed via React's useSyncExternalStore (see useStore below). No deps added.

import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ItemType = "page" | "text" | "tagset" | "image";

interface ItemMetadata {
  title?: string;
  selectedText?: string;
  sourceApp?: string;
  sharedAt?: string;
  // _sync omitted here; the store never reads it.
  [k: string]: unknown;
}

// Mirror of App.tsx's UnifiedItem (kept structurally identical).
export interface UnifiedItem {
  id: string;
  type: ItemType;
  url?: string;
  content?: string;
  tags: string[];
  saved_at: string;
  metadata?: ItemMetadata;
  thumbnail?: string;
  mime_type?: string;
  width?: number;
  height?: number;
}

// Backend row shape returned by `query_items`. DB type 'url' maps to UI 'page'.
interface ItemRow {
  id: string;
  type: "url" | "text" | "tagset" | "image";
  url?: string;
  content?: string;
  metadata?: ItemMetadata;
  tags: string[];
  saved_at: string;
  thumbnail?: string;
  mime_type?: string;
  width?: number;
  height?: number;
}

export interface Cursor {
  saved_at: string;
  id: string;
}

interface QuerySlice {
  search: string;
  itemType: "all" | ItemType;
  sort: "newest" | "oldest";
  selectedTags: string[];
}

interface ListSlice {
  items: UnifiedItem[];
  cursor: Cursor | null;
  hasMore: boolean;
  loading: boolean;
}

interface ConfigSlice {
  archiveTag: string;
  offlineTag: string;
  autoHideTags: string[];
}

interface State {
  query: QuerySlice;
  list: ListSlice;
  config: ConfigSlice;
}

const PAGE_LIMIT = 30;
const SEARCH_DEBOUNCE_MS = 150;

// ---------------------------------------------------------------------------
// Core store (getState / setState / subscribe)
// ---------------------------------------------------------------------------

let state: State = {
  query: { search: "", itemType: "all", sort: "newest", selectedTags: [] },
  list: { items: [], cursor: null, hasMore: false, loading: false },
  config: { archiveTag: "archive", offlineTag: "offline", autoHideTags: ["from:history"] },
};

const listeners = new Set<() => void>();

function getState(): State {
  return state;
}

// Shallow-merge a partial state. Each slice is replaced wholesale by the caller,
// so unchanged slices keep their reference (lets selectors stay stable).
function setState(partial: Partial<State>): void {
  state = { ...state, ...partial };
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const store = { getState, setState, subscribe };

// ---------------------------------------------------------------------------
// useStore hook — selects a stable slice via useSyncExternalStore.
// Selectors MUST return primitives or stable references (do not build new
// objects/arrays in the selector) or React will loop on getSnapshot.
// ---------------------------------------------------------------------------

export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(state),
  );
}

// ---------------------------------------------------------------------------
// query_items plumbing
// ---------------------------------------------------------------------------

function rowToUnified(row: ItemRow): UnifiedItem {
  // map DB 'url' -> UI 'page'; text/tagset/image pass through.
  const type: ItemType = row.type === "url" ? "page" : row.type;
  return {
    id: row.id,
    type,
    url: row.url,
    content: row.content,
    tags: row.tags,
    saved_at: row.saved_at,
    metadata: row.metadata,
    thumbnail: row.thumbnail,
    mime_type: row.mime_type,
    width: row.width,
    height: row.height,
  };
}

function buildArgs(cursor: Cursor | null) {
  const { query, config } = state;
  return {
    search: query.search,
    tags: query.selectedTags,
    itemType: query.itemType,
    archiveTag: config.archiveTag,
    autoHideTags: config.autoHideTags,
    sort: query.sort,
    cursor,
    limit: PAGE_LIMIT,
  };
}

async function fetchPage(cursor: Cursor | null): Promise<ItemRow[]> {
  return invoke<ItemRow[]>("query_items", buildArgs(cursor));
}

// Guards against out-of-order responses: each reload bumps the token; a stale
// in-flight reload whose token no longer matches discards its result.
let reloadToken = 0;

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

function setSearch(s: string): void {
  setState({ query: { ...state.query, search: s } });
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    searchDebounceTimer = null;
    void reload();
  }, SEARCH_DEBOUNCE_MS);
}

function setItemType(t: "all" | ItemType): void {
  if (t === state.query.itemType) return;
  setState({ query: { ...state.query, itemType: t } });
  void reload();
}

function setSort(s: "newest" | "oldest"): void {
  if (s === state.query.sort) return;
  setState({ query: { ...state.query, sort: s } });
  void reload();
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function setSelectedTags(arr: string[]): void {
  if (arraysEqual(arr, state.query.selectedTags)) return;
  setState({ query: { ...state.query, selectedTags: arr } });
  void reload();
}

function toggleTag(name: string): void {
  const cur = state.query.selectedTags;
  const next = cur.includes(name) ? cur.filter((t) => t !== name) : [...cur, name];
  setSelectedTags(next);
}

function setConfig(cfg: { archiveTag: string; offlineTag: string }): void {
  const { archiveTag, offlineTag } = state.config;
  const changedArchive = cfg.archiveTag !== archiveTag;
  if (cfg.archiveTag === archiveTag && cfg.offlineTag === offlineTag) return;
  setState({
    config: { ...state.config, archiveTag: cfg.archiveTag, offlineTag: cfg.offlineTag },
  });
  if (changedArchive) void reload();
}

async function reload(): Promise<void> {
  const token = ++reloadToken;
  setState({
    list: { items: [], cursor: null, hasMore: false, loading: true },
  });
  try {
    const rows = await fetchPage(null);
    if (token !== reloadToken) return; // superseded by a newer reload
    const items = rows.map(rowToUnified);
    const cursor = items.length > 0 ? lastCursor(items) : null;
    setState({
      list: { items, cursor, hasMore: rows.length === PAGE_LIMIT, loading: false },
    });
  } catch (err) {
    if (token !== reloadToken) return;
    console.error("[store] query_items reload failed:", err);
    setState({ list: { items: [], cursor: null, hasMore: false, loading: false } });
  }
}

async function loadMore(): Promise<void> {
  const { list } = state;
  if (!list.hasMore || list.loading || !list.cursor) return;
  const token = reloadToken; // tie to current reload generation
  const cursor = list.cursor;
  setState({ list: { ...list, loading: true } });
  try {
    const rows = await fetchPage(cursor);
    if (token !== reloadToken) return; // a reload happened mid-flight; drop
    const newItems = rows.map(rowToUnified);
    const merged = state.list.items.concat(newItems);
    setState({
      list: {
        items: merged,
        cursor: merged.length > 0 ? lastCursor(merged) : null,
        hasMore: rows.length === PAGE_LIMIT,
        loading: false,
      },
    });
  } catch (err) {
    if (token !== reloadToken) return;
    console.error("[store] query_items loadMore failed:", err);
    setState({ list: { ...state.list, loading: false } });
  }
}

// Coalesced reload: collapses several reload requests fired in the same tick
// (e.g. a sync that refreshes urls+texts+tagsets+images) into a single fetch.
let coalesceTimer: ReturnType<typeof setTimeout> | null = null;
function reloadCoalesced(): void {
  if (coalesceTimer) return;
  coalesceTimer = setTimeout(() => {
    coalesceTimer = null;
    void reload();
  }, 0);
}

function lastCursor(items: UnifiedItem[]): Cursor {
  const last = items[items.length - 1];
  return { saved_at: last.saved_at, id: last.id };
}

export const actions = {
  setSearch,
  setItemType,
  setSort,
  setSelectedTags,
  toggleTag,
  setConfig,
  reload,
  reloadCoalesced,
  loadMore,
};
