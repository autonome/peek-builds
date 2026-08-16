/**
 * Peek MCP Store Types
 *
 * `server.js` talks to a store, not to SQLite directly. `db.js`'s fifteen
 * exports already were a coherent store API — this file names that API as a
 * JSDoc typedef, no runtime code, the same shape as `apps/server/sql/types.js`
 * describes `SqlAdapter`. `store/index.js` picks the implementation that
 * satisfies it (`store/sqlite-store.js` today; an HTTP client is a later step
 * — see docs/mcp-remote-backend-design.md §2.1).
 *
 * Every method is async: `sqlite-store.js` wraps unchanged synchronous
 * `node:sqlite` calls, so the promise always resolves on the same tick, but
 * a future remote implementation needs the interface to already be async.
 *
 * @typedef {Object} ItemQuery
 * @property {string[]} [tags] - Items must have ALL listed tags
 * @property {string} [type] - Filter by item type
 * @property {number} [limit]
 * @property {number} [offset]
 * @property {'recent'|'frecency'} [sort]
 *
 * @typedef {Object} SearchQuery
 * @property {string} query - Whitespace-tokenized; every term must match, in any field
 * @property {string[]} [tags]
 * @property {string} [type]
 * @property {number} [limit]
 * @property {number} [offset]
 *
 * @typedef {Object} ItemView
 * @property {string} id
 * @property {string} type
 * @property {string|null} content
 * @property {string} title
 * @property {string} domain
 * @property {Object|string} metadata
 * @property {string} [mimeType]
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {number} [deletedAt]
 * @property {number} [starred]
 * @property {number} [archived]
 * @property {number} [visitCount]
 * @property {number} [lastVisitAt]
 * @property {number} [frecencyScore]
 * @property {string} [favicon]
 * @property {string[]} tags
 * @property {number} [score] - search_items only
 * @property {string} [snippet] - search_items only
 *
 * @typedef {Object} ResolveResult
 * @property {string|null} id
 * @property {boolean} [ambiguous]
 * @property {{id: string, title: string}[]} [candidates]
 * @property {boolean} [truncated]
 *
 * @typedef {Object} CreateItemInput
 * @property {string} type
 * @property {string} [url]
 * @property {string} [title]
 * @property {string} [content]
 * @property {Object|string} [metadata]
 * @property {string[]} [tags]
 * @property {boolean} [extractHashtags]
 *
 * @typedef {Object} UpdateItemInput
 * @property {string} [title]
 * @property {string} [content]
 * @property {Object|string} [metadata]
 *
 * @typedef {Object} TagQuery
 * @property {string} [search]
 * @property {number} [limit]
 *
 * @typedef {Object} TagView
 * @property {string} id
 * @property {string} name
 * @property {string} color
 * @property {string} description
 * @property {number} itemCount
 *
 * @typedef {Object} TagMutationResult
 * @property {boolean} success
 * @property {string} [itemId]
 * @property {string} [tagName]
 * @property {string} [error]
 *
 * @typedef {Object} EventResult
 * @property {boolean} success
 * @property {string} id
 * @property {string} itemId
 * @property {string} type
 *
 * @typedef {Object} TaskQuery
 * @property {string[]} [tags] - default ['todo']
 * @property {string} [project]
 *
 * @typedef {Object} SessionInfo
 * @property {string} scopeTag - '' means unscoped
 * @property {boolean} readonly
 * @property {string} profileId
 * @property {number|string} datastoreVersion
 * @property {string} backend - e.g. 'sqlite'
 *
 * @typedef {Object} StoreConfig
 * @property {string} [dbPath] - sqlite-store: path to datastore.sqlite
 * @property {string} [scopeTag] - captured at open time; resolveItemId no
 *   longer takes it per call (see docs/mcp-remote-backend-design.md §2.1)
 * @property {boolean} [readonly]
 * @property {string} [remoteUrl] - unused until remote-store.js exists
 * @property {string} [credential]
 *
 * @typedef {Object} PeekStore
 * @property {(q: ItemQuery) => Promise<ItemView[]>} queryItems
 * @property {(q: SearchQuery) => Promise<ItemView[]>} searchItems
 * @property {(id: string, opts?: {events?: number}) => Promise<ItemView|null>} getItem
 * @property {(id: string) => Promise<string[]>} getItemTags
 * @property {(prefix: string) => Promise<ResolveResult>} resolveItemId
 * @property {(input: CreateItemInput) => Promise<ItemView>} createItem
 * @property {(id: string, patch: UpdateItemInput) => Promise<ItemView>} updateItem
 * @property {(id: string) => Promise<{success: boolean, id: string}>} deleteItem
 * @property {(q: TagQuery) => Promise<TagView[]>} listTags
 * @property {(id: string, tagName: string) => Promise<TagMutationResult>} tagItem
 * @property {(id: string, tagName: string) => Promise<TagMutationResult>} untagItem
 * @property {(id: string, type: string, value?: string) => Promise<EventResult>} recordEvent
 * @property {(q: TaskQuery) => Promise<ItemView[]>} listTasks
 * @property {(id: string, notes?: string) => Promise<ItemView>} completeTask
 * @property {(id: string) => Promise<ItemView|null>} getTaskContext
 * @property {() => Promise<SessionInfo>} describe
 * @property {() => Promise<void>} close
 */

// Export empty object - types are defined via JSDoc above.
export default {};
