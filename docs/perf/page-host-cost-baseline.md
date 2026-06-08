# Page-host cost — baseline (2026-06-02) → hybrid result (2026-06-08)

Before/after measurement for perf epic **`d8e7efa5`** (lever in task **`ed717516`**: collapse
the per-page page-host). The **baseline** was captured before building the "hybrid" redesign;
the **hybrid result** ([§ Results — hybrid](#results--hybrid-measured-2026-06-08)) measures the
win against the **same** restored 46-page session. Re-run with `scripts/perf/` (see
[Reproduce](#reproduce)).

## TL;DR

**Result (2026-06-08): the hybrid cut ~41% of processes, ~⅓ of RAM, and nearly all of the
continuous idle CPU + compositor tax** on the identical session — full table in
[§ Results — hybrid](#results--hybrid-measured-2026-06-08).

The **baseline** below: a real prod session (the author's ~46 open pages), fully restored and
**sitting idle**, costs:

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

## Results — hybrid measured (2026-06-08)

The hybrid landed and was measured against the **identical** frozen 46-page session, same
visible-run method as the baseline. **Every reducible cost dropped; both predicted wins
materialized.**

### System conditions (held constant vs the baseline)

- **Same restored session.** An APFS copy-on-write clone of the frozen
  `~/peek-perf-baseline/default-2026-06-02` snapshot — the exact 46-page session the baseline
  measured — into a throwaway `perfhybrid` profile. Apples-to-apples; the live prod profile
  was never touched.
- **Same machine / OS.** macOS (Darwin 25.5). **Visible** run (windows painting at real
  opacity), so the compositor cost is paid and comparable to the baseline's *visible* column.
  Display config is immaterial — the baseline A/B showed <1.5% across 5K-external vs
  laptop-alone — so one visible measurement is representative.
- **Hybrid enabled via `PEEK_PAGEHOST_HYBRID=1`** (defaults **off** — `main/debug-flag.ts:51`).
  Fresh build from source. **No `DEBUG`** (it auto-opens DevTools on every `peek://` window →
  contaminated counts).
- **Same sampler + settle.** `scripts/perf/sample.sh ITERS=14 INTERVAL=15 DELTA=3`; figures
  read from the **settled plateau** (t=120–195 s: `loading=0`, load avg ~2.3, RSS flat, ~93%
  system idle), not the restore spike. CPU via cputime-delta (true instantaneous).
- **Same proc matcher.** By `--user-data-dir=…/Peek/perfhybrid` — `entry.ts:786` sets
  `userData` from `PROFILE`, and Electron propagates `--user-data-dir` to **every** helper, so
  renderer/gpu/utility procs are all counted *and* isolated from any other concurrent Peek
  instance sharing the same dist.

### As-built hybrid architecture (what moved the numbers)

Per page, the old transparent-canvas page-host — **Process A** (the `page.js` chrome *and* the
`<webview>` embedder, one renderer) + **Process B** (the `<webview>` guest content, its own
renderer) + a **fullscreen transparent canvas** window — is replaced by:

- **One opaque content window per page** whose content is a **`WebContentsView`** attached
  directly to the window: a single content webContents, **no wrapper/embedder renderer**. (In
  `peek-cli debug-list-windows` these report `"hybrid": true`.) The content stays an isolated
  webContents (own session + preload), so the chrome-extension compat layer — content-script
  injection, runtime-external preload, permission handler, page-widget `executeJavaScript` —
  **re-attaches** rather than disappears.
- **One shared chrome overlay for the whole app** — a single `peek://app/page/overlay.html`
  window (`Peek Page Overlay`, exactly one instance in the window list) repositioned over the
  active content window — instead of the per-page navbar/widgets DOM riding on a per-page
  transparent canvas.

So the two structural deletions are **(1)** the per-page embedder renderer (−1 renderer
process/page) and **(2)** the per-page fullscreen transparent canvas (−the per-pixel
alpha-composite **and** its continuous idle paint loop, ×N pages).

### Before → after (settled idle, both visible)

| Dimension (settled idle) | Baseline (canvas + `<webview>`) | Hybrid (`WebContentsView` + shared overlay) | Δ |
|---|---|---|---|
| Top-level windows | 54 | 55 | ≈ (per-page window still 1:1) |
| **Renderer processes** | 107 | **63** | **−44 (−41%)** |
| Electron total processes | 112 | 66 | −46 (−41%) |
| **Renderer RSS** | ~15.4 GB | **~10.5 GB** | **−5.0 GB (−32%)** |
| Electron total RSS | ~16.7 GB | ~11.05 GB | −5.6 GB (−34%) |
| GPU-process RSS | ~475 MB | ~356 MB | −119 MB (−25%) |
| **Electron CPU @ idle** | ~118% | **~1–3%** | **−~115 pts** |
| GPU CPU @ idle | ~33% | ~0% | −33 pts |
| **WindowServer CPU @ idle** | ~47% | **~12–16%** | **−~32 pts (−68%)** |
| WindowServer RSS | ~270 MB | ~203 MB | −67 MB (−25%) |
| System idle | ~83% | ~93% | +10 pts |

(ps RSS over-counts the shared Electron framework per process — trust the **deltas**, which
are large and stable across the whole settled plateau.)

### Reading the result

- **Process / RAM win (lever 1).** The −44 renderers are precisely the per-page embedder
  renderers the `WebContentsView` migration removes (the baseline's "~46 of 107" estimate).
  ~−5 GB renderer RSS. **Window count is unchanged** because each page is still its own
  top-level window — the win is in *processes*, not windows.
- **Compositor win (lever 2).** Collapsing N transparent fullscreen canvases into opaque
  positioned windows + one shared overlay drops WindowServer CPU 47%→~14% and GPU CPU 33%→0%.
- **Idle CPU — larger than projected.** Electron idle CPU fell **~118% → ~1–3%**. The old
  transparent canvases ran a continuous paint/composite path *even at idle*; opaque static
  content has nothing to repaint. This **cross-validates**: Electron CPU, WindowServer CPU, and
  GPU CPU all collapse in lockstep — a coherent architectural result, not a sampling artifact.
  The baseline's "~2 cores, continuously" idle tax is essentially gone.

**Net:** on the identical session, the hybrid removes ~41% of processes, ~⅓ of RAM, and nearly
all of the continuous idle CPU + compositor tax.

## Implication for the redesign (`ed717516`)

Two reducible costs, and the **hybrid** captures both (**now measured 2026-06-08 — see
[§ Results — hybrid](#results--hybrid-measured-2026-06-08); both levers validated**):

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
46-page restore. See that directory's `README.txt`. **Used 2026-06-08** for the hybrid result
above; retained for re-measurement (safe to delete per its `README.txt` now that the win is
recorded).
