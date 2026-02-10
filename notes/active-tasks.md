# Active Tasks

**Last Updated:** 2026-02-10

## In Progress

### Search Extension Research Completed
- Status: Research phase complete
- File: `/Users/dietrich/misc/mpeek/notes/research-search-extension.md`
- Next: Begin Phase 1 implementation (Core Infrastructure)

### Widgets/HUD Research Completed
- Status: Research phase complete
- File: `/Users/dietrich/misc/mpeek/notes/research-widgets-hud.md`
- Next: Implementation planning

## Pending - High Priority

### Search Extension Implementation - Phase 1
**Goal:** Core Infrastructure (2 weeks)
- [ ] Create `extensions/search/` directory structure
- [ ] Define datastore schema for `search_engines` table
- [ ] Implement engine storage CRUD (add, remove, update, list)
- [ ] Seed built-in engines (Google, DuckDuckGo, Bing, Wikipedia)
- [ ] Register per-engine commands (`/google`, `/ddg`, etc.)
- [ ] Test basic search command execution
- **Deliverables:**
  - Extension scaffold with manifest.json
  - Datastore schema migration
  - Command registration working for built-in engines

### UI Componentry Migration
- Status: Significant research complete (see `/Users/dietrich/misc/mpeek/notes/migration-ui-componentry.md`)
- Next: Complete remaining component migrations
- Priority: High (enables other features)

## Pending - Medium Priority

### Search Extension Implementation - Phase 2
**Goal:** Settings UI (2 weeks)
- [ ] Build Settings UI using peek-components (card, list, button)
- [ ] Default engine selection (radio buttons)
- [ ] Enable/disable toggle per engine
- [ ] Add custom engine dialog (form with validation)
- [ ] Edit engine (keyword, URL template)
- [ ] Remove engine (with confirmation)
- [ ] Persist changes to datastore
- **Dependencies:** Phase 1 complete
- **Deliverables:**
  - Functional Settings page at `peek://ext/search/settings.html`
  - CRUD operations for engines
  - Settings schema JSON for integration

### Search Extension Implementation - Phase 3
**Goal:** OpenSearch Discovery (1 week)
- [ ] Content script to detect `<link rel="search">` tags
- [ ] Fetch and parse OpenSearch XML
- [ ] Validate XML schema (ShortName, Url required)
- [ ] Show install prompt (notification or cmd indicator)
- [ ] User confirms → add to datastore
- [ ] Test on popular sites (Wikipedia, GitHub, Stack Overflow)
- **Dependencies:** Phase 2 complete
- **Deliverables:**
  - content-discovery.js content script
  - XML parser with validation
  - Install prompt UI

### Session Restoration
- Status: Research complete (see `/Users/dietrich/misc/mpeek/notes/research-session-restoration.md`)
- Next: Implementation planning
- Priority: Medium

### Userscripts Support
- Status: Research complete (see `/Users/dietrich/misc/mpeek/notes/research-userscripts.md`)
- Next: Implementation planning
- Priority: Medium

## Pending - Lower Priority

### Search Extension Implementation - Phase 4
**Goal:** Search Suggestions (2 weeks)
- [ ] Implement suggestion-provider.js (fetch + parse)
- [ ] Support OpenSearch JSON and Google-style formats
- [ ] Debounce requests (200ms)
- [ ] In-memory cache with TTL (5 min)
- [ ] Integrate with cmd panel dropdown
- [ ] Keyboard navigation (arrow keys, Enter)
- [ ] Attribution footer ("Powered by X")
- **Dependencies:** Phase 3 complete
- **Deliverables:**
  - Suggestion API integration
  - Cache implementation
  - Cmd panel dropdown with suggestions

### Search Extension Implementation - Phase 5
**Goal:** Default Fallback & Polish (1 week)
- [ ] Cmd panel: detect unmatched input
- [ ] Heuristic: check if it's a URL vs search query
- [ ] Use default engine for non-URL input
- [ ] Privacy mode: disable suggestions when enabled
- [ ] Per-engine suggestion toggle
- [ ] Error handling (network failures, timeouts)
- [ ] Logging and telemetry
- **Dependencies:** Phase 4 complete
- **Deliverables:**
  - Default search fallback working
  - Privacy controls functional
  - Error states handled gracefully

### Search Extension Implementation - Phase 6
**Goal:** Testing & Documentation (1 week)
- [ ] Unit tests for engine CRUD
- [ ] Unit tests for suggestion parsing
- [ ] Integration tests: add engine, search, suggestions
- [ ] E2E tests: OpenSearch discovery flow
- [ ] Performance profiling (suggestion latency)
- [ ] User documentation (help text in Settings)
- [ ] Developer documentation (extension API)
- **Dependencies:** Phase 5 complete
- **Deliverables:**
  - Test suite with >80% coverage
  - Documentation in README or help page

### Webview Background Flash Fix
- Status: Research complete (see `/Users/dietrich/misc/mpeek/notes/research-webview-background-flash.md`)
- Next: Implementation planning
- Priority: Low (polish)

### Bundled Web Extensions
- Status: Research complete (see `/Users/dietrich/misc/mpeek/notes/research-bundled-web-extensions.md`)
- Next: Implementation planning
- Priority: Low

## Completed Recently

### Task Management System Setup
- Completed: 2026-02-10
- Created task tracking infrastructure
- Files:
  - `/Users/dietrich/misc/mpeek/notes/active-tasks.md` (this file)
  - `/Users/dietrich/misc/mpeek/notes/task-1-summary.md`

### Groups Migration Summary
- Completed: 2026-02-09
- File: `/Users/dietrich/misc/mpeek/notes/groups-migration-summary.md`
- Summary: Documented the groups model migration and related changes

### Startup Feature Review
- Completed: 2026-02-10
- File: `/Users/dietrich/misc/mpeek/notes/startup-feature-review.md`
- Summary: Reviewed startup configuration and feature set

## Architecture & Planning Documents

### Recent Research Documents
- `/Users/dietrich/misc/mpeek/notes/research-search-extension.md` - Search extension design (complete)
- `/Users/dietrich/misc/mpeek/notes/research-widgets-hud.md` - Widgets/HUD design (complete)
- `/Users/dietrich/misc/mpeek/notes/research-session-restoration.md` - Session restoration design (complete)
- `/Users/dietrich/misc/mpeek/notes/research-userscripts.md` - Userscripts support design (complete)
- `/Users/dietrich/misc/mpeek/notes/research-webview-background-flash.md` - WebView flash fix (complete)
- `/Users/dietrich/misc/mpeek/notes/migration-ui-componentry.md` - UI component migration (in progress)

### Core Architecture Documents
- `/Users/dietrich/misc/mpeek/notes/design-vision.md` - Overall design philosophy
- `/Users/dietrich/misc/mpeek/notes/datastore-architecture.md` - Data storage architecture
- `/Users/dietrich/misc/mpeek/notes/extensibility.md` - Extension system architecture
- `/Users/dietrich/misc/mpeek/notes/core-api.md` - Core API documentation
- `/Users/dietrich/misc/mpeek/notes/shortcuts-api.md` - Shortcuts/hotkey system

### iOS-Specific Documents
- `/Users/dietrich/misc/mpeek/notes/ios-storage-architecture.md` - iOS storage implementation
- `/Users/dietrich/misc/mpeek/notes/research-tauri-mobile.md` - Tauri mobile research
- `/Users/dietrich/misc/mpeek/notes/research-xcodebuild-environment-issues.md` - iOS build troubleshooting

### Sync & Server Documents
- `/Users/dietrich/misc/mpeek/notes/sync-architecture.md` - Sync system design
- `/Users/dietrich/misc/mpeek/notes/sync-architecture-review.md` - Sync system review
- `/Users/dietrich/misc/mpeek/notes/sync-edge-cases.md` - Sync edge case handling
- `/Users/dietrich/misc/mpeek/notes/server-portability-plan.md` - Server deployment options
- `/Users/dietrich/misc/mpeek/notes/cloudflare-vs-railway-evaluation.md` - Hosting comparison

## Open Questions & Decisions Needed

### Search Extension
1. **Default Search Fallback**: Should cmd bar automatically fall back to default search for unmatched input?
   - Recommendation: Smart detection (>3 chars, has spaces) with setting to disable
2. **OpenSearch Auto-Install**: Should Peek automatically install discovered search engines?
   - Recommendation: Smart prompt (first time per domain) with setting for auto-install
3. **Suggestion Privacy Default**: Should search suggestions be enabled by default?
   - Recommendation: Enabled by default with privacy disclosures
4. **Keyword Conflicts**: What happens if two engines have the same keyword?
   - Recommendation: User resolves during installation
5. **Search Result Display**: Where should search results open?
   - Recommendation: User setting (default: new window)
6. **Sync Custom Engines**: Should custom engines sync across devices?
   - Recommendation: Custom engines only (not built-in)

### Widgets/HUD
- Implementation approach TBD after review of research document

## Notes for New Agents

### Getting Started
1. Review `/Users/dietrich/misc/mpeek/CLAUDE.md` for jj workflow and project guidelines
2. Review `/Users/dietrich/misc/mpeek/DEVELOPMENT.md` for architecture overview
3. Check this file for current priorities and task status
4. Always commit before rebasing: `jj commit -m "description"`

### Key Patterns
- **Extensions:** Located in `extensions/` directory, follow manifest.json pattern
- **Components:** Use peek-components from `app/components/`, see research-ui-componentry.md
- **Datastore:** Use datastore API for all persistence, see datastore-architecture.md
- **Commands:** Register via cmd extension, see `extensions/cmd/`
- **Testing:** Use headless tests (`yarn test:electron:bg`), never headed without user request

### iOS Development
- **Build for simulator:** `yarn mobile:ios:dev` (includes HMR)
- **Build for device:** `yarn mobile:ios:xcodebuild:device:full`
- **Build numbers:** Auto-incremented in `backend/tauri-mobile/BUILD_NUMBER`
- **Stale cache:** Run `npm run clean:rust:full` when changing Cargo features
- **Custom protocol:** Only for release builds, never for dev (breaks HMR)

### Testing Philosophy
- Never run `npx playwright test` directly (steals focus)
- Use `yarn test:electron:bg` for background execution
- No timeouts for assertions - use events and deterministic checks
- Test logs go to `/tmp/test-electron.log`

### jj Workflow
- Always use `jj commit`, never git commands
- Commit before any rebase (uncommitted edits can be lost)
- Push to main: `jj rebase -s 'roots(::@ ~ ::main)' -d main && jj bookmark set main -r '@-'`
- Pull from main: `jj rebase -s 'roots(::@ ~ ::main)' -d main`

## Status Legend

- **In Progress**: Currently being worked on
- **Pending - High Priority**: Should be started soon
- **Pending - Medium Priority**: Important but not urgent
- **Pending - Lower Priority**: Nice to have, not blocking
- **Completed Recently**: Finished in the last few days

## Updating This Document

When working on tasks:
1. Move tasks between sections as status changes
2. Add new tasks as they're identified
3. Update the "Last Updated" date
4. Add completion notes for finished tasks
5. Commit changes: `jj commit -m "docs: update active tasks"`
