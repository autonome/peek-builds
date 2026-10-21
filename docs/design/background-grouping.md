# Background grouping with corrections as labels

Status: proposal, not built. The settled rules this builds on live in
`docs/local-ai-needle-research.md` ("Task detection and automatic workspaces, Firefox-style",
"Bake-off plan"). This document replaces only one part of that plan: where the labelled data
comes from.

## The idea

Instead of hand-labelling one week of visits before anything runs, a cheap heuristic grouper
runs continuously, proposes groups of pages, and records every correction to a proposal. The
corrections then serve three purposes:

1. They are hard constraints on the next grouping pass, so accepted work is never reshuffled.
2. Once there are enough of them, they are the training set for the weights that combine the
   signals.
3. They are the evaluation set. The bake-off compares candidates on them instead of on a
   hand-labelled week.

The heuristics have to be useful from the first day without any learning. Learning only
refines them.

## What already exists

- Visits: `item_visits` in `apps/desktop/main/datastore.ts` (`recordItemVisit()`) already
  carries timestamp, duration, scroll depth, interaction, window type and the `prevId`/`nextId`
  navigation chain. That covers every session and navigation signal the research doc lists.
- Items: title, domain, frecency and tags (`items`, `item_tags`).
- Entities: `features/entities/entity-store.js addObservation()` writes one `item_events` row
  per entity per URL per day. The row is keyed by the URL string, not the url item id, so a
  URL-to-item lookup is needed before entities can join visits.
- Workspaces: a space is a `space:`-prefixed tag (`features/spaces/DESIGN.md`). Accepting a
  proposal therefore means applying a `space:<name>` tag. No promote step, and no use of the
  `item_groups` tables.
- Feedback precedent: `entity-store.js setEntityFeedback()` with suppression on thumbs-down.
- Manual labelling: `features/bake-off-labeling`. This loop complements it, since a hand label
  is still the cleanest label.
- Missing: any clustering, any proposal state or proposal UI, any embedding store.
  *Unverified*: whether page body text is persisted for url items. `page:content-ready` carries
  only url, title and window id.

## The loop

**Sessions.** Visits are cut into sessions at an idle gap, starting at 30 minutes as the
research doc says, and also wherever the `prevId` chain breaks across windows. Sessions are
derived on each pass and never stored.

**Pair signals**, each a number from 0 to 1, between two url items:

| Signal | Source |
| --- | --- |
| Title text similarity (TF-IDF cosine over title tokens) | `items.title` |
| Same registrable domain; shared URL path prefix | `items.content` (the URL) |
| Navigated one from the other | `item_visits.prevId` / `nextId` |
| Co-occurred in a session; time between visits | `item_visits` |
| Shared entities | entity observations, joined by URL |
| Shared user tags (excluding `space:` tags) | `item_tags` |
| Body-text similarity | only if body text turns out to be stored |

An embedding similarity is one more column in this table, added later by the bake-off. It is
not a different architecture.

**Score.** A weighted sum of the signals, with hand-set weights at first. This is the non-ML
baseline the research doc requires every job to keep.

**Two speeds.**

- *On each visit*: score the visited item against every open proposal and accepted space it
  touches. Attach it above a threshold, or leave it in the unassigned pool otherwise.
- *On idle, at most hourly*: re-cluster the recent window (two weeks) with agglomerative
  average-linkage clustering under must-link and cannot-link constraints. Keep only clusters
  that pass the cohesion filter: at least 3 items, at least 2 sessions, and an average pair
  score above a threshold. Name each from its most frequent title tokens.

**Where it runs.** Heuristics only, so it can run in the main process at first. If it ever
blocks input, move it to a utility process. The research doc's proposed `ml` service does not
exist yet and is not needed for this.

## Proposals and corrections

Proposals live in a new local table that is never synced, holding an id, a name, the member
item ids with a score per member, the score band, and created/decided times. A table avoids the
research doc's provisional `~auto:` tag, which would need a sync exclusion that tag code does
not have today.

Each correction is an `item_events` row with type `grouping:<action>`. Its metadata holds the
proposal id, the item ids involved, the signal vector for each affected pair at that moment,
and the scorer version.

| What the person does | Recorded as | Effect on the next pass |
| --- | --- | --- |
| Accepts a proposal | `grouping:accept` | applies `space:<name>`; members must-link |
| Rejects a whole proposal | `grouping:reject` | pairs count as weak negatives, no hard constraint |
| Removes one item | `grouping:remove` | cannot-link between that item and the rest |
| Adds an item to a proposal or space | `grouping:add` | must-link |
| Merges two proposals | `grouping:merge` | must-link across both |
| Splits a proposal | `grouping:split` | cannot-link across the parts |
| Renames | `grouping:rename` | the new name becomes anchor text |
| Undoes any of the above | `grouping:undo` | reverts the constraint |

Only explicit actions count as labels. Leaving a proposal alone is not acceptance, and a
proposal that is never decided expires after N days with no label.

Only the accepted result syncs (the `space:` tag). The proposals and grouping events stay
local, because together they amount to a detailed browsing log.

## From corrections to learning

- **Pair labels.** Every must-link pair is a positive and every cannot-link pair is a negative.
  Each label stores the signal vector from the moment of the decision, so a weight fit is plain
  logistic regression over those rows. Refit once there are a few hundred labelled pairs. Keep
  the hand-set weights whenever the fit does not beat them on held-out labels.
- **The online metric** is the acceptance rate per score band, which is the same number the
  research doc uses to move a band from suggesting to filing automatically (about 90%).
- **Selection bias.** Corrections exist only for what was proposed, so pairs the scorer never
  surfaced go unlabelled, and a model fitted on them learns to agree with the scorer. Two
  mitigations: show a small fixed share of proposals drawn from just below the threshold, and
  treat a hand-made `space:` tag or a `bake-off-labeling` export as unbiased labels.
- **The bake-off** then runs on the accumulated labels: replay each candidate scorer against
  the recorded decisions and compare agreement, with the heuristic baseline as the bar.

## What this makes harder

- A biased label set. The mitigations above reduce the bias without removing it, so the
  hand-labelled week remains the tiebreak if the replayed bake-off is close.
- A proposal surface that annoys. Nothing files automatically at first, and the proposal count
  has to stay small (a handful per day), or rejections will stand for "stop showing me this"
  rather than "these pages don't belong together".
- Two places to read grouping state: accepted spaces in tags, and open proposals in the local
  table.

## Open questions

- Is page body text stored for url items? If it is, body similarity joins the signal table; if
  it isn't, titles and URLs carry text similarity alone.
- Where proposals appear. A tray in the command panel, a section in the spaces feature, or a
  notice when a proposal is new.
- Whether to join entity observations to items by looking up the URL each time, or to change
  `addObservation()` so it records the item id.

## First step

Run the heuristic grouper offline, read-only, against a copy of the real profile's
`datastore.sqlite`, never the live profile, over the last two weeks. The output is a
throwaway report of the proposed groups, with each group's top signals, kept outside the repo.
Looking through that report decides whether the proposals are good enough to put in front of
anyone, before any UI or table exists. This needs a copy of the production profile, so it
runs on this laptop.
