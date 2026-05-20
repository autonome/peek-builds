# Todo Commands — DISABLED

This feature is checked in but **disabled by design**. Discovery skips it
because the manifest is named `manifest.json.disabled` — no `manifest.json`
means `discoverFeatures()` walks past the directory.

## Why disabled

The two cmd-panel commands in `background.js` (`todo`, `done`) work, but
they're not enough to be daily-use:

- No way to **list** outstanding todos without opening the tags grid and
  filtering by `#todo` manually.
- No way to **search** todos from the cmd panel — `done <match>` does a
  blind first-match-wins lookup with no suggestion UI.
- No **inline editing** — once a todo's body is set you have to open the
  item in the editor like any other text item.
- The original task spec called for `todo <text> <tab>/<down>` to search
  existing todos and open one in the editor; that needs cmd-panel
  suggestion-source plumbing this feature doesn't have yet.

## Re-enabling

When the listing / search / inline-edit flows land, rename:

```
mv manifest.json.disabled manifest.json
```

…and the feature picks up automatically on next app start.

## What's here

- `manifest.json.disabled` — declares `todo` and `done` commands.
- `background.html` / `background.js` — handlers using `getOrCreateTag` →
  `tagItem`/`untagItem` and `getItemsByTag` for the `done` lookup.
- `config.js` — id/labels stub.

The handlers wire to `cmd:execute:todo` and `cmd:execute:done`. Reactivate
by restoring the manifest filename — no code changes needed.
