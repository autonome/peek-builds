# drag-pasteboard-probe

Read-only macOS probes of what an OS drag carries while it is in flight. Neither needs Peek
running or opens a window. Run one, then drag something from another app.

- `drag-pasteboard-watch.swift [seconds]` lists the drag pasteboard's types on every change
  and reads `public.url`, plain text and the URL name. Appends to
  `/tmp/peek-space-drop-pasteboard.log`.
- `drag-pasteboard-wildcard.swift [seconds]` asks for the data behind every type present,
  repeatedly for 5 s after the first change, and exits. Appends to
  `/tmp/peek-space-drop-wildcard.log`.

```
swift tools/drag-pasteboard-probe/drag-pasteboard-wildcard.swift 600
```

Result for Firefox, used by `features/spaces/DESIGN.md` ("Dropping web addresses on a space"):
a tab dragged from the tab strip carries only `org.mozilla.MozillaWildcard`, whose data is nil
to other processes. The address-bar site icon and in-page links carry `public.url`.
