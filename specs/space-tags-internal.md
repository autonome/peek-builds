---
enabled: false
touches: [apps/desktop/features/spaces/**, apps/desktop/features/tags/**, apps/desktop/renderer/**]
depends-on: []
---

# Workspace tags (`space:*`) are internal tags, not user tags

Peek item `f3c36483`. Disabled: it rides on the hidden-tags framework (Peek item `03dac063`,
`from:*` tags treated as internal), which is still in triage and not built. Enable this spec once
that framework has landed and adjust the requirements to whatever it settled on.

## Problem

The spaces feature tags every item created from a window in a workspace with that workspace's
`space:<name>` tag (`apps/desktop/features/spaces/background.js handleItemCreated()`). With the
default workspace, every content window eventually sits in a workspace and every link opened
from another app lands in the default one, so `space:default` ends up on most items. Tagging
items with their workspace is wanted; the tags appearing beside user-chosen tags everywhere is
noise.

## Requirements

1. `space:*` joins the internal tag namespace the hidden-tags framework defines: filtered out of
   tag pickers, tag clouds, item cards and the tags feature's frecency list by default.
2. The spaces home and panel still list workspaces from `space:*` tags.
3. Search by tag still finds items in a workspace.
4. The framework decides what "internal" means; this work only adds the `space:` prefix to it.
