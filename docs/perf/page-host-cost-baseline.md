# Page-host cost — measured baseline (2026-06-02)

Baseline measurement for perf epic **`d8e7efa5`** (lever in task **`ed717516`**: collapse
the per-page page-host). Captured before building the "hybrid" redesign so we can measure the
win afterward against the **same** restored session. Re-run with `scripts/perf/` (see
[Reproduce](#reproduce)).

## TL;DR

A real prod session (the author's ~46 open pages), fully restored and **sitting idle**, costs:

| | value |
|---|---|
| Top-level windows | **54** |
| Renderer processes | **107** |
| Total RAM (Electron RSS) | **~16.7 GB** |
| CPU at idle | **~118% Electron + ~47% WindowServer + ~33% GPU ≈ 2 cores, continuously** |
| Restore spike | **~800% Electron CPU, ~0% system idle, load ~16** |

Each open page = **+1 BrowserWindow + 2 webContents** (a page-host *chrome/embedder* renderer
running `page.js`, plus the `<webview>` guest content renderer) **+ a fullscreen transparent
canvas** that the macOS compositor must alpha-composite continuously.

## How the page-host is built (the thing we're paying for)

Content pages use a **fullscreen transparent canvas** `BrowserWindow` (the "FROZEN" canvas
architecture — see `apps/desktop/CLAUDE.md`). `ipc.ts` loads
`peek://app/page/index.html?url=<realURL>&x&y&w&h` into that window; `renderer/page/page.js`
draws the navbar/widgets/resize-handle as absolutely-positioned DOM **siblings** of a
`<webview id="content">` whose `src` is the real site. So per page:

- **Process A** — the page-host renderer: `page.js` chrome **and** the `<webview>` embedder
  (same renderer). ~120 MB.
- **Process B** — the `<webview>` guest: the real content, its own renderer process.
- **1 window** — a transparent, fullscreen surface → per-pixel alpha compositing in
  WindowServer, ×N pages.

Chromium does **not** coalesce these (Site Isolation is off app-wide, and a `<webview>` always
gets its own process), so the process count grows linearly with open pages.

## Method

Zero code injected into the app. Driven via `peek-cli` (IPC) + OS tools:

- **Windows:** `peek-cli debug-list-windows` (top-level `BrowserWindow`s; `<webview>` guests
  are not windows).
- **Processes / RAM:** `ps -axo pid=,rss=,cputime=,command=`, filtered to this checkout's
  Electron, classified by `--type=` (browser / renderer / gpu-process / utility), summed.
- **CPU (instantaneous):** **cputime-delta** — sample each pid's CPU-seconds twice `DELTA`s
  apart and divide. (`ps %cpu` is a *lifetime* average that washes out load spikes — do not
  use it.)
- **Compositor:** WindowServer RSS + CPU (same cputime-delta).
- **System:** `top -l 2 -n 0` header → CPU user/sys/idle, PhysMem, load average.

Profiles are **APFS copy-on-write clones** of the real prod `default` profile (`cp -c -R`,
instant, near-zero disk, fully isolated — the live profile is only read). Never run on the
live prod profile. See `scripts/perf/README.md`.

### Gotchas that bit us (and are now guarded)

- **Never set `DEBUG=1` for a VISIBLE run.** `ipc.ts:2378` auto-opens detached DevTools on
  every `peek://` window when `DEBUG && !isHeadless()` → ~one devtools webContents per
  page-host → contaminated counts. Headless suppresses it. `peek-cli` and `main.log` both work
  without `DEBUG`.
- **Settle before reading.** 46 heavy pages load over ~20–40 s; sample through the spike to a
  stable plateau (`loading=0`, RSS flat).
- **External transients contaminate** (an AirDrop import mid-run spiked the system). Watch the
  system-CPU line; re-run if something else grabbed the machine.

## Results

### Headless vs visible (does headless under-report?)

Headless renders windows at `opacity:0` — webContents are live but nothing paints. Visible
pays the real compositor cost. Both, same session, to settle:

| | Headless | Visible | Δ |
|---|---|---|---|
| Windows | 54 | 54 | — |
| Renderer procs | 107 | 107 | — |
| Renderer RSS | ~15.75 GB | ~15.65 GB | ~noise |
| WindowServer | ~156 MB, baseline (no paint) | ~265 MB / **~47% CPU** | compositor only in visible |

**Headless is a trustworthy proxy for RAM/process counts** (within noise). The one thing it
hides is the **compositor CPU** — which is large and only visible in a visible run.

### Display config: 5K external vs laptop-alone (does it matter?)

Hypothesis: HiDPI/pixel count on a 5K Studio Display would inflate renderer raster RAM and
WindowServer CPU. **It did not.** Same session, settled idle:

| Dimension (idle) | A: laptop + 5K Studio | B: laptop alone | Δ |
|---|---|---|---|
| Windows | 54 | 54 | — |
| Renderer procs / RAM | 107 / ~15.65 GB | 107 / ~15.43 GB | +1.4% |
| GPU process | 478 MB / ~32% | 475 MB / ~33% | ≈ |
| Electron total | 112 / ~16.9 GB / ~115% | 112 / ~16.67 GB / ~119% | ≈ |
| **WindowServer** | **265 MB / ~48% CPU** | **273 MB / ~46% CPU** | ≈ |
| System idle | ~82% | ~83% | — |
| Restore spike | ~810% Elec / 3% idle / load 15 | ~780% Elec / 2% idle / load 19 | ≈ |

**Every dimension within ~1.5% (noise), WindowServer included.** So the **~47% WindowServer +
~33% GPU idle tax is inherent to the 46-fullscreen-transparent-canvas architecture, not the
display.** A single measurement is representative regardless of monitor.

## Implication for the redesign (`ed717516`)

Two reducible costs, and the **hybrid** captures both:

1. **Process / RAM** — the per-page *embedder* renderer (~46 of the 107, ~43%; multi-GB).
   Removing it requires dropping the `<webview>` embedder: migrate content to a
   **`WebContentsView`** attached directly to the window (1 content webContents/page, no
   wrapper renderer). The content stays an isolated webContents (own session + preload), so
   the compat layer (content-script injection, runtime-external preload, permission handler,
   page-widgets `executeJavaScript`) **re-attaches** rather than disappears.
2. **Compositor** — the ~47% WindowServer + ~33% GPU idle tax from N transparent fullscreen
   canvases. Collapse to **one shared chrome overlay** repositioned over the active content
   window; content windows become opaque/positioned.

**Correction worth recording:** the *literal* "shared overlay, keep `<webview>`" (task
approach 1, a.k.a. "1a") does **not** cut the ~46 processes — a `<webview>` always needs an
embedder renderer, so it only slims RAM + wins the compositor. The **process/RAM win needs the
`WebContentsView` path.** The hybrid = `WebContentsView` content + shared chrome view = both
wins.

## Reproduce

```bash
# 1. Clone the prod profile (instant COW; live profile only read)
cp -c -R "$HOME/Library/Application Support/Peek/default" \
         "$HOME/Library/Application Support/Peek/perfX"

# 2. Build, then launch (HEADLESS for clean RAM/proc; drop PEEK_HEADLESS for a visible run —
#    and NEVER set DEBUG=1 on a visible run)
yarn workspace @peek/desktop build
PROFILE=perfX /Users/<you>/misc/mpeek/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .

# 3. Wait until restored, then sample to settle
PROF=perfX bash scripts/perf/wait-ready.sh
PROF=perfX ITERS=14 INTERVAL=15 DELTA=3 bash scripts/perf/sample.sh

# 4. Tear down + delete the clone
pkill -f '/Users/<you>/misc/mpeek/node_modules/electron/dist/Electron.app'
rm -rf "$HOME/Library/Application Support/Peek/perfX" \
       "$HOME/Library/Application Support/Peek/Partitions/perfX"
```

Full runbook + flags: `scripts/perf/README.md`.

**Frozen baseline profile:** a COW snapshot of the exact session measured here is preserved
(uncommitted) at `~/peek-perf-baseline/` so the hybrid can be measured against the identical
46-page restore. See that directory's `README.txt`.
