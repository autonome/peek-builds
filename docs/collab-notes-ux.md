# Collaborative Notes — UX

**Status:** v1 UX. Companion to [collab-notes-design.md](./collab-notes-design.md).
**Scope:** user journeys, surface allocation per platform, and UX-driven
design decisions that aren't visible in the protocol spec.
**Task:** peek task `053db0fe-5c8d-4fd5-a6e9-6316ab6ae059`.
**Dependent feature:** [contacts](./../features/contacts/) — peek task
`af8abc4a-bb88-41ed-b432-4e8ec8f30030`.

---

## User journeys

### J1. First note, alone

User opens cmd panel, types `new note`. If no atproto account is configured,
Peek prompts (lazy) for sign-in — pick an existing account or add one. Note
opens. User edits. No sharing, no network. Single-user case is the floor of
the UX pyramid — must work without anyone else involved.

### J2. Share with someone

User has a note open. Types `share with @alice.bsky.social` (in the note's
command surface, or via cmd panel scoped to the focused note window). Peek
resolves the handle → DID via atproto handle resolution, auto-adds Alice to
contacts with `source: 'invite-outbound'` and `verified: 'tofu'`, performs
the X3DH handshake using Alice's prekey bundle, writes an encrypted invite
record to sender's PDS. Note's members panel shows Alice as "pending."

### J3. Receive an invite

On Bob's side: a **HUD widget** (desktop) or **notification banner**
(mobile) appears: "Alice invites you to a note." Bob inspects: contact card
shows Alice's handle, avatar, and verification state ("unverified"). Bob
accepts: X3DH completes on Bob's side, the per-note symmetric key is
materialized from the invite (or fetched per the open lexicon question),
and full note state syncs in via the normal update path.

### J4. Real-time co-edit

Both online. WebRTC datachannel established via PDS signalling. Each side
sees the other's edits land within seconds. No remote-cursor support in v1
(deferred per non-goals). A simple **presence indicator** in the note's
chrome — small avatars of currently-active members with a green dot —
surfaces "Alice is here." Heartbeat-driven, not "Alice is typing."

### J5. Async edit (offline → reconnect)

User edits while offline. Edits accumulate locally in the Automerge
datastore. When the device reconnects, Peek writes pending CRDT updates as
transient queue records on the user's own PDS. Remote peers' heads
eventually advance; sender deletes its records. UI shows a small
"syncing… 3 changes pending" indicator that clears once heads converge.

### J6. Manage membership

The note's members panel: list of contacts with role badges (owner /
editor / reader) and presence state. Owner can `add` or `remove` members
via inline controls or `share with` / `unshare from` commands. Removed
members can no longer decrypt new updates (per-note key rotates on
`membershipSeq` bump). Membership rotation is invisible to users beyond
the "Alice removed" entry in the members list.

### J7. Multi-account

User has work + personal atproto accounts. Creating a new note: cmd
prompts "Use which account?" — picks one. Each note records its
account binding in metadata. The note window's chrome shows the active
account (small avatar in the title bar). Switching accounts mid-note
is **not supported in v1** — would require re-handshaking with every
member under the new identity.

### J8. Multi-device, same user

Phone and laptop both signed into `@alice.bsky.social`. Notes auto-sync
between them via the same PDS-queue protocol; Alice is both sender and
receiver across her devices (the X3DH session forks per-device, Signal-
style). From the user's perspective: "my notes follow me." This is the
simplest topology and the Phase 2 acceptance criterion.

---

## Desktop surfaces

Peek desktop has a rich UI vocabulary; we lean on it rather than inventing.

### Note window

A page-host window at `peek://collab-notes/note/<noteId>`. Standard
page-host chrome (navbar, address bar, ESC handling per
`docs/page-host-state-machine.md`). Content area renders the editor —
Automerge-aware text widget rendering `title` and `body`. Width follows
window resize; the placement engine (see
`docs/window-placement.md`) treats it as a content window — `proportional`
default placement.

### Members page widget

Right-edge page widget on the note window, in the same family as
existing tags/entities/notes panels. Shows:
- Avatars + handles for each member
- Role badge (owner/editor/reader)
- Presence dot (active / online / offline)
- "+" button → contact-picker peek-card

Hidden by default; toggled via the page-host's standard page-widget
controls.

### Quick-note peek-card

Hotkey opens a peek-card (overlay-style) with a single text field for
title + body. ESC dismisses, saves as a personal note. "Share" button
on the card promotes to a shared note (opens contact picker). Lowest-
friction path to "make a note."

### Inbound-invite HUD widget

A persistent HUD widget in a screen corner shows the unread-invites
badge. Click → a peek-card lists pending invites with avatar +
contact card + accept/decline. A toast slides in when an invite arrives
if Peek is focused (no toast if backgrounded — relies on push instead;
see mobile).

### Slide variant

Edge-anchored slide presentation for a note — same Automerge doc,
different layout. E.g. a "team standup" note anchored to the top of
the screen. Use the existing slides feature; collab-notes registers
the slide bindings.

### Activity HUD (optional)

Aggregate widget showing currently-active collaborators across all the
user's notes. Useful for "who's around right now?" One avatar row,
clickable to jump to the active note.

### Contacts page

Standalone page at `peek://contacts/`. List view: avatar + handle +
last-interaction timestamp + verification state. Click → contact
profile peek-card with shared-notes list, verification controls,
notes field.

Cmd commands:
- `contact` — add a contact (prompts for handle or DID)
- `contacts` — open contacts page
- `verify <contact>` — start fingerprint flow

---

## Mobile surfaces

Tauri WebView. Touch input, one-thing-at-a-time, OS background limits.

### Note view (full-screen)

Editor occupies the screen. Header has:
- Back button
- Note title (editable inline on tap)
- Members icon (count badge)
- Sync indicator dot
- Overflow menu (rename, delete, leave, settings)

Footer (if formatting controls are surfaced) hosts those. No page
widgets — they map to sheets summoned from header icons.

### Members sheet

Pulls up from the members icon. Same content as the desktop members
widget but full-width sheet. Tap a member → profile sheet. Tap "+" →
contacts-picker sheet (search + scroll).

### Create flow

Tab bar entry "Notes" → list of notes → "+" → new note (full-screen).
Share-sheet integration: long-press a URL or content elsewhere on the
OS → "Save to Peek" → opens a new note containing it.

### Invite notifications

OS-level push (subject to the push-provider open question — see design
doc). Tapping the push deep-links into the invitations sheet. In-app: a
badge on the Notes tab; pending invites listed at the top of the notes
list.

### Lazy auth sheet

First time the user opens collab-notes: full-screen "Sign in with
atproto" sheet. Lists existing accounts and a "+ Add account" entry —
same surface as `api.identity.addAccount`. Once authed, returns to
note flow.

### Sync indicator

Small dot in the header:
- Solid green: real-time connected to ≥1 peer
- Pulsing: async pending (writes queued or fetching)
- Gray: offline / no peers

Tap → details sheet listing per-member sync state ("syncing to @bob
via PDS, 3 changes pending").

### Background sync (OS integration, Phase 4b)

On mobile, Peek may be backgrounded mid-sync. Use platform background-
fetch hooks:
- iOS: `BGAppRefreshTask` for periodic light checks
- Android: `WorkManager` for the same

The background check is records-only (no full sync): "any new updates
on my peers' PDSes?" If yes, optionally surface a push so the user
opens Peek to actually sync.

### Contacts tab

Dedicated bottom-bar tab. Search by handle. Tap contact → profile
sheet with shared notes + verification + remove.

---

## UX-driven design decisions

These don't appear in the protocol spec but lock UX behavior.

### 1. Per-note account binding (locked)

A note records which Peek-local account it was created under. Members
on the other side address the note via that account's atproto identity.
Switching the bound account on an existing note is not supported in v1.
**Why:** simplifies the X3DH state machine — one identity per note per
device. Re-binding would require re-handshakes with every member, with
a window of unclear membership state.

### 2. Quick-note → shared promotion path (locked)

A solo note is just an Automerge doc with `members.length === 1`. The
"share" button on any note opens the contacts picker; selecting a
contact does an X3DH handshake and appends them to `members`. Same
data model throughout — no separate "shared note" type. **Why:**
preserves the simplicity-first journey; users don't decide
"shared vs. personal" at creation.

### 3. Presence model — minimal heartbeat (Phase 2)

Each active member sends a heartbeat over the WebRTC datachannel every
N seconds (proposed: 10s). Members panel shows a green dot for any
peer whose last heartbeat is within 2 × N. No typing indicators, no
cursor positions, no "Alice is in section 3." **Why:** cheap, easy
to validate, and answers the only presence question users care about
in v1 ("is anyone else looking at this right now?").

### 4. Invitation lexicon — proposal (open)

See design doc § "Open questions" — `space.peek.collab.invite` records
on sender's PDS, encrypted to recipient, rkey HMAC'd. Resolve before
Phase 3. Carried as an open question on the collab-notes task.

### 5. Mobile push provider strategy (open)

Defers to design-doc open question. Tauri mobile push is APNs/FCM-
specific and the no-server constraint complicates token registration.
v1.0 fallback: background-fetch polling on a conservative interval.
v1.1+: a proper push path. Carried as an open question on the
collab-notes task.

---

## Non-goals (UX, v1)

- **Remote-cursor rendering** during co-edit. Possible v1.1 once
  Automerge's cursor-as-CRDT-position is plumbed through the editor.
- **Rich text formatting** beyond what Automerge.Text natively gives.
  Markdown-ish, not WYSIWYG.
- **Standalone contacts cross-device sync.** Contacts are profile-
  local in v1 (the contacts task carries this as its own deferred
  question).
- **Inbound invite preview content.** Recipients see only "sender +
  note title" in the invite UI; the body isn't fetched until accept.
  Avoids partial-state UX and keeps the metadata-exposure surface
  minimal.
- **Search across all notes.** A `notes` listing is enough for v1;
  full-text search is its own work.
- **Bluesky follow-graph import** as a contact source. Privacy +
  opt-in design needed; deferred.

---

## Open UX questions

- **Where exactly does the cmd `share with @alice` live?** Global cmd
  (with implicit "share the focused note") vs. note-scoped cmd (only
  available when a note window is focused). Probably both, with the
  note-scoped variant being the canonical form.
- **Verification UX**. Signal/WhatsApp safety numbers, scannable QR
  codes, or out-of-band shared text? Pick one for v1 to keep UX
  consistent across platforms. Probably "short text string +
  scannable QR with same payload," handed off to the contacts feature.
- **Note-list affordances**. Solo notes vs. shared notes vs. notes
  someone invited me to: same list with role indicators, or
  separate sections? Likely one list with subtle visual cues, sortable
  by recency.
