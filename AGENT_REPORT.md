# Agent Report: v1 Removal Phase 1c (cmd + page)

## Scope

Convert `cmd` and `page` core renderers from v1 iframe-in-extension-host
loading to v2 standalone BrowserWindows using `tile-preload.cjs` with a
`trustedBuiltin` capability grant. Same pattern HUD was converted to in
Phase 1b.

## Plan

1. chore: plan stub (this file)
2. feat(cmd): merge background.{html,js} into index.html (single-file core renderer)
3. refactor(cmd): use api.pubsub.* instead of v1 api.publish/subscribe
4. feat(cmd-glue): launch cmd with tile-preload + trustedBuiltin grant, drop loadExtInHost
5. feat(page): single-file resident renderer for open/modal commands
6. refactor(page): use api.pubsub.* instead of v1 api.publish/subscribe
7. feat(page-glue): launch page-bg with tile-preload + trustedBuiltin grant, drop loadExtInHost

## Status (pending — will be updated as work lands)

(to be filled in as commits land)
