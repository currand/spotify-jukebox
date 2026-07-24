# Spec: Jukebox

## Objective

Jukebox is a self-hosted web application that lets party guests control the host's Spotify playback queue via phone — without being a player itself. The host runs Jukebox on a home Docker server; guests join via QR code or link, search for tracks, upvote songs, veto unwanted tracks, and use a one-time boost to jump a song toward the front.

**Primary user:** Host (Spotify Premium, home server, one active Connect device).

**Secondary users:** Party guests (anonymous, mobile browser, no Spotify account required).

**Success looks like:**
- Host creates a party in under 2 minutes (OAuth once, pick seed playlist, share QR).
- Up to 50 guests concurrently browse, vote, and add tracks with sub-5s perceived latency via polling.
- Virtual queue behavior (upvotes, boost lane, vetoes) matches spec even though Spotify's native queue cannot be reordered or edited.
- Entire stack runs in Docker Compose on a modest home server (~256 MB RAM for the app container).

### User stories

| Actor | Story |
|---|---|
| Host | I log in with Spotify once so Jukebox can control playback on my active device. |
| Host | I start a party, pick a seed playlist, and share a QR code. |
| Host | I turn the party on or off with a single switch. |
| Host | I configure veto threshold and guest rate limits before or during a party. |
| Host | I see a warning when no Spotify device is active, while guests can still add/vote. |
| Host | I manage the virtual queue: add, shuffle, reorder, force-next, clear upcoming, skip, ban guests, reset votes, and “start from here.” |
| Host | After a server restart or network blip, music keeps playing and the virtual queue/history are intact. |
| Guest | I scan a QR code and enter a display name before I can add, vote, veto, or boost. |
| Guest | I see the current queue, who added each song, and live upvote counts. |
| Guest | I search for tracks or browse an artist's top tracks and add one to the queue. |
| Guest | I upvote songs I want to hear sooner (not my own). |
| Guest | I veto a song; if enough guests agree, it is removed/skipped. |
| Guest | I boost one song per party (mine or anyone else's) into a FIFO priority lane. |

---

## Tech Stack

| Layer | Choice | Rationale |
|---|---|---|
| Language | TypeScript | Host preference; shared types across API and UI |
| Runtime | Bun | Low memory, fast startup, built-in TS |
| HTTP framework | Hono | Lightweight, good Bun support |
| Database | SQLite (`bun:sqlite` or `better-sqlite3`) | Zero extra container, sufficient for 50 guests |
| Frontend | React + Vite | Mobile-first SPA, static assets served by API |
| Spotify | Web API + OAuth 2.0 Authorization Code (host only) | Queue control requires Premium |
| Tunnel | cloudflared | HTTPS without port forwarding |
| Container | Docker Compose | Self-hosted requirement |

---

## Commands

```bash
# Setup
cp .env.development.example .env.development   # local dev
cp .env.production.example .env.production     # home server (jukebox app)
cp .env.cloudflared.example .env.cloudflared # tunnel token only

# Or: bun run setup:dev / bun run setup:prod

# Development (loads .env.development, no Cloudflare)
bun install
bun run dev

# Quality
bun run lint
bun run typecheck
bun test

# Production (Docker loads .env.production + cloudflared)
docker compose up --build -d

# Logs
docker compose logs -f jukebox
docker compose logs -f cloudflared
```

---

## Project Structure

```
jukebox/
├── docker-compose.yml
├── Dockerfile
├── docs/
│   └── SPEC.md                 # This document
├── src/
│   ├── server/
│   │   ├── index.ts            # Hono app entry
│   │   ├── routes/             # REST route handlers
│   │   ├── services/
│   │   │   ├── spotify.ts      # Spotify API client
│   │   │   ├── sync.ts         # Virtual queue → Spotify sync worker
│   │   │   ├── queue.ts        # Virtual queue logic
│   │   │   ├── search.ts       # Search + artist browse
│   │   │   ├── dedup.ts        # Fuzzy title deduplication
│   │   │   └── rate-limit.ts   # Sliding-window limits
│   │   ├── db/
│   │   │   ├── schema.ts       # SQLite schema + migrations
│   │   │   └── queries.ts
│   │   └── middleware/
│   │       ├── guest-session.ts
│   │       └── host-auth.ts
│   ├── client/
│   │   ├── main.tsx
│   │   ├── pages/              # Guest view, Host admin
│   │   └── components/
│   └── shared/
│       └── types.ts            # Shared API types
├── tests/
│   ├── unit/
│   └── integration/
└── package.json
```

---

## Code Style

- **Formatting:** Prettier defaults; 2-space indent.
- **Naming:** `camelCase` for variables/functions, `PascalCase` for types/components, `kebab-case` for route paths.
- **Imports:** Absolute from `@/` mapped to `src/`.
- **Errors:** Return typed API errors `{ error: string, code: string }` with appropriate HTTP status; never leak Spotify tokens.
- **Comments:** Only for non-obvious sync logic and rate-limit windows.

```typescript
// Example: queue sort comparator
function compareQueueItems(a: QueueItem, b: QueueItem): number {
  if (a.upvoteCount !== b.upvoteCount) return b.upvoteCount - a.upvoteCount;
  return a.addedAt.getTime() - b.addedAt.getTime();
}
```

---

## Testing Strategy

| Level | Tool | Scope |
|---|---|---|
| Unit | `bun:test` | Queue sorting, dedup fuzzy match, rate-limit windows, boost lane FIFO |
| Integration | `bun:test` + in-memory SQLite | API routes with mocked Spotify client |
| Manual | Host checklist | End-to-end against real Spotify account in dev |

**Coverage target:** ≥80% on `services/` (queue, sync, rate-limit, dedup). UI smoke-tested manually.

**Mocking:** All Spotify API calls mocked in tests via injectable `SpotifyClient` interface.

---

## Boundaries

### Always
- Validate all guest input server-side.
- Enforce rate limits and party-on/off state on every mutating endpoint.
- Require a non-empty display name before any guest mutation (add / upvote / veto / boost).
- Store Spotify refresh token encrypted at rest.
- Run `bun test` before commits.

### Ask first
- Adding npm dependencies beyond core stack.
- Changing SQLite schema after initial migration.
- Modifying Docker Compose service topology.
- Any feature not listed in this spec.

### Never
- Commit `.env.development`, `.env.production`, `.env.cloudflared`, `.env.local`, Spotify client secrets, or refresh tokens.
- Expose host Spotify credentials to guests.
- Build audio playback or stream Spotify content in the browser.
- Synchronize or broadcast Spotify audio (Spotify Developer Policy).

---

## Architecture

### Overview

```
Guest phones ──poll──▶ cloudflared ──▶ Jukebox API ──▶ SQLite
                                              │
                                              ▼
                                    Spotify Sync Worker
                                              │
                                              ▼
                              Spotify Web API (host account)
                                              │
                                              ▼
                              Active Connect device (any)
```

Jukebox maintains a **virtual queue** as the source of truth. A background sync worker translates virtual state into Spotify `add-to-queue` and `skip` calls. The UI never shows Spotify's raw queue directly.

### Spotify API constraints

| Supported | Not supported |
|---|---|
| Add to queue | Reorder queue |
| Read queue / playback state | Remove item from queue |
| Skip next / previous | Guarantee ordering under concurrent Player API calls |

**Implication:** Tracks already pushed to Spotify but later demoted or vetoed are **skipped** when they reach the front. Upvote resorting applies only to tracks not yet sent to Spotify.

**Search limit (Feb 2026):** Max 10 results per search request. UI paginates or prompts refinement.

### Virtual queue

**Normal queue:** Sorted by upvote count (desc), then `addedAt` (asc).

**Boost lane:** Separate FIFO queue. When the current track ends, the next track is taken from the boost lane if non-empty; otherwise from the normal queue head.

**Track lifecycle:** `pending` → `queued` (sent to Spotify) → `playing` → `played` | `skipped` | `vetoed`

**Visible queue:** Guests see `pending`, `queued`, and `playing`. Terminal states (`played`, `skipped`, `vetoed`) leave the active list but remain in history for dedup (see Deduplication).

### Interaction rules

| Action | Rule |
|---|---|
| Upvote | One upvote per guest per song. Cannot upvote a song you added. Host-seeded songs may be upvoted by any guest. |
| Boost | One boost per guest per party. May boost any pending (not yet playing) song — including your own or someone else's. Costs the single boost either way. Cannot boost a song already in the boost lane. |
| Veto | One veto per guest per song. Allowed on own songs, but the UI must warn before confirming (“You’re about to veto a song you added”). Not allowed on the currently playing track. When veto count reaches the party threshold, the song is immediately set to `vetoed`, removed from the guest queue UI, and never played; if it was already `queued` in Spotify’s buffer, it is skipped when it would reach the front (or skipped from the buffer on next sync). |
| Display name | Required (non-empty) before any mutating action. Join may create a session without a name; first mutation must set one (or join UI requires it before enabling actions). |

### Spotify sync worker

Runs on an interval (~2s) when a party is **on**:

1. Poll `GET /me/player/currently-playing` (and queue if needed).
2. If no active device / no playback: **do not fail guest mutations**. Set host-visible warning `spotify_device_inactive`. Skip Spotify write calls until a device is active again.
3. Detect track transitions; mark previous item `played` or `skipped`.
4. Select next virtual track (boost lane first, then normal head; never select vetoed).
5. Maintain a Spotify queue buffer of **3–5** upcoming tracks via `POST /me/player/queue` (prefer smoothness over fine-grained reorderability).
6. If the currently playing Spotify track is vetoed or no longer in the virtual queue, call `POST /me/player/next`.
7. Do not add duplicate URIs already in the Spotify queue buffer.
8. If the virtual queue has no upcoming tracks: stop adding to Spotify; guest UI shows “Add something!” Now-playing may finish naturally; Spotify’s own autoplay/recommendations are out of scope — Jukebox does not try to keep music going.

**Device targeting:** No explicit `device_id`; operate on whichever device is currently active on the host account.

### Deduplication

Before adding a track, compare **normalized title only** (not artist) against:

- All **active** queue items (`pending`, `queued`, `playing`)
- The **20 most recent** terminal items (`played`, `skipped`, `vetoed`), ordered by when they left the active queue

Matching:

- Normalize: lowercase, strip punctuation, collapse whitespace.
- Match if Levenshtein ratio ≥ 0.85 on title, OR exact normalized title match.
- Reject add with `{ error: "This song is already in the queue", code: "DUPLICATE" }`.

Search results are not deduplicated — only queue insertion.

### Rate limits (defaults, all configurable per party)

Sliding-window counters per guest per action type:

| Action | Default limit | Window |
|---|---|---|
| Add track | 3 | 20 minutes |
| Upvote | 10 | 60 minutes |
| Veto | 3 | 30 minutes |
| Boost | 1 | Per party (lifetime of guest session in that party) |

Return `429` with `{ error: "...", code: "RATE_LIMITED", retryAfterMs: number }`.

### Party lifecycle

- **Cardinality:** Exactly **one active party** at a time. Creating a new party ends/archives the previous one (status becomes historical; guests of the old party can no longer mutate).
- **Binary switch:** Party is either `on` or `off` (admin toggle). No auto-expiry timer.
- When **off:** Guests can still load the page but all mutations return `403`. Sync worker idle.
- When **on:** Sync worker active; guests can interact within rate limits.
- **Seed playlist:** Imported **once on party creation**. Import **all** tracks from the selected Spotify playlist in playlist order. Each seed track enters the normal queue with 0 upvotes, attributed to "Host". Turning the party off/on does **not** re-seed or clear guest adds.

### Host authentication

- Host admin (`/admin`) is gated by **Spotify OAuth only** (Authorization Code flow for the host Premium account).
- Successful OAuth establishes a host session cookie.
- No additional PIN/password in v1.
- Spotify Developer Dashboard should keep the app in **Development mode** with only the host’s account allowlisted.

### Host controls

- Spotify OAuth connect / disconnect
- Create party (name, seed playlist, slug) — ends any previous active party
- Party on/off switch
- Configure: veto threshold, rate-limit windows
- Display QR code + share link
- Warning banner when Spotify has no active device
- **Queue management (host overrides):**
  - Add tracks to the virtual queue (no guest rate limits; attributed to "Host")
  - **Shuffle:** Randomize all upcoming tracks in the **normal lane** (`pending` + `queued`, not playing). Leave **boost lane** order and **now-playing** untouched. Mark shuffled items back to `pending` as needed and **rebuild** the Spotify buffer (do not skip current track).
  - Remove any non-playing queue item immediately (no veto threshold)
  - Force a song to play next (move to front of boost lane / host priority)
  - Manual reorder (move up/down within the normal upcoming list)
  - Clear remaining queue (keep now-playing; mark all other upcoming as host-cleared/`skipped`)
  - Skip currently playing track (`POST /me/player/next` + mark virtual item `skipped`)
  - Ban/disable a guest session (blocks further mutations; existing queue items stay unless host removes them)
  - Reset upvote counts on a song (to 0; clears vote rows for that item)
  - **Start from here:** Host selects an upcoming song; every upcoming track that would play **before** it (in play order: boost lane FIFO, then normal by votes/`addedAt`) is removed (`skipped`); the selected song and everything after it remain. Effectively “start the queue from here.” Rebuild Spotify buffer; never skip now-playing unless the host separately skips.
- **History:**
  - View song history for the active party (`played`, `skipped`, `vetoed`) for audit and recovery visibility
  - Queue recovery is primarily via durable SQLite + **Start from here**, not bulk history replay

Host actions bypass guest rate limits and ownership restrictions.

### Persistence & restart resilience

- SQLite on a Docker volume is the source of truth for the virtual queue, history, votes, guests, and party config.
- A Jukebox container restart **must not**:
  - Re-import the seed playlist
  - Clear or reshuffle the virtual queue
  - Skip or restart the currently playing Spotify track
- On startup (or after Spotify/network reconnect) when a party is `on`:
  1. Load party + queue from SQLite (unchanged).
  2. Poll Spotify currently-playing; if something is already playing, **adopt it** as now-playing if it matches a virtual item, otherwise leave Spotify alone and mark virtual `playing` only when we next control a transition.
  3. Soft-reconcile: **rebuild** the Spotify upcoming buffer (3–5) to match the virtual upcoming list **without** skipping the current track.
  4. If Spotify is unreachable briefly, keep serving guests from SQLite; resume sync when API is back; show host warning.
- Guest mutations never require Spotify to be reachable; only the sync worker does.

### Guest identity

- Anonymous session via HTTP-only cookie (`guest_session`).
- Display name required before mutations (add / upvote / veto / boost).
- Names shown on adds and (where applicable) boosts/vetoes in the UI.
- No Spotify login for guests.

### Cloudflare

- **Production only.** Development runs on `127.0.0.1` without a tunnel.
- **cloudflared** provides the public **HTTPS** URL required for production Spotify OAuth and guest QR links.
- Set up the tunnel before registering the **production** Spotify app redirect URI.
- No Cloudflare Access, Workers, or other Cloudflare features in v1.

**Environment files:**

| File | Use |
|---|---|
| `.env.development` | Local dev — separate Spotify dev app, `http://127.0.0.1` URLs |
| `.env.production` | Docker **jukebox** service — Spotify prod app, HTTPS URLs, `ENCRYPTION_KEY`, `HOST_SETUP_TOKEN` |
| `.env.cloudflared` | Docker **cloudflared** service only — `TUNNEL_TOKEN` |
| `.env.local` | Optional overrides (gitignored), loaded after the env file above |

**Production secrets to generate:**

```bash
openssl rand -hex 32   # ENCRYPTION_KEY (≥ 32 characters)
openssl rand -hex 16   # HOST_SETUP_TOKEN — enter in Admin before Connect Spotify
```

`HOST_SETUP_TOKEN` is optional in development. Required in production.

**Allowed URL patterns:**

| Environment | `BASE_URL` | `SPOTIFY_REDIRECT_URI` |
|---|---|---|
| Development | `http://127.0.0.1:5173` | `http://127.0.0.1:3000/api/v1/host/spotify/callback` |
| Production | `https://{tunnel-hostname}` | `https://{tunnel-hostname}/api/v1/host/spotify/callback` |

Spotify rejects `http://localhost`. Config validation enforces these rules at startup.

---

## Data Model

### `parties`

| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | UUID |
| slug | TEXT UNIQUE | URL-safe, used in join link |
| name | TEXT | Display name |
| status | TEXT | `on` \| `off` \| `archived` |
| veto_threshold | INTEGER | Default 3 |
| seed_playlist_id | TEXT | Spotify playlist ID |
| rate_limits | JSON | `{ add: { count, windowMs }, upvote: {...}, veto: {...} }` |
| created_at | DATETIME | |
| updated_at | DATETIME | |

Invariant: at most one party with `status IN ('on', 'off')`; others are `archived`.

### `guests`

| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | UUID |
| party_id | TEXT FK | |
| session_token | TEXT UNIQUE | Cookie value |
| display_name | TEXT NULL | Required before mutations |
| boost_used | BOOLEAN | Default false |
| disabled | BOOLEAN | Host ban; blocks mutations when true |
| created_at | DATETIME | |

### `queue_items`

| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | UUID |
| party_id | TEXT FK | |
| spotify_uri | TEXT | |
| track_name | TEXT | Denormalized for dedup/display |
| artist_name | TEXT | Display only (not used in dedup) |
| album_art_url | TEXT NULL | |
| upvote_count | INTEGER | Denormalized counter |
| veto_count | INTEGER | Denormalized counter |
| status | TEXT | `pending` \| `queued` \| `playing` \| `played` \| `skipped` \| `vetoed` |
| is_boosted | BOOLEAN | In boost lane |
| boost_position | INTEGER NULL | FIFO order within boost lane |
| added_by_guest_id | TEXT NULL FK | NULL = host seed |
| added_at | DATETIME | |
| finished_at | DATETIME NULL | When moved to terminal status (for “recent 20” dedup) |

### `votes`

| Column | Type | Notes |
|---|---|---|
| guest_id | TEXT FK | |
| queue_item_id | TEXT FK | |
| created_at | DATETIME | PRIMARY KEY (guest_id, queue_item_id) |

### `vetoes`

| Column | Type | Notes |
|---|---|---|
| guest_id | TEXT FK | |
| queue_item_id | TEXT FK | |
| created_at | DATETIME | PRIMARY KEY (guest_id, queue_item_id) |

### `rate_limit_events`

| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | Auto-increment |
| guest_id | TEXT FK | |
| action | TEXT | `add` \| `upvote` \| `veto` |
| created_at | DATETIME | Indexed for sliding window queries |

### `host_credentials`

| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | Single row |
| access_token | TEXT | Encrypted |
| refresh_token | TEXT | Encrypted |
| expires_at | DATETIME | |
| updated_at | DATETIME | |

### `host_sessions`

| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | Session token |
| created_at | DATETIME | |
| expires_at | DATETIME | |

---

## API Design

Base path: `/api/v1`

### Host (Spotify OAuth session cookie)

| Method | Path | Description |
|---|---|---|
| GET | `/host/spotify/login` | Redirect to Spotify OAuth |
| GET | `/host/spotify/callback` | OAuth callback → host session |
| GET | `/host/spotify/status` | Connected, token expiry, `deviceActive` warning |
| POST | `/host/logout` | Clear host session |
| POST | `/host/parties` | Create party (archives previous active party; imports seed) |
| GET | `/host/parties/current` | Current non-archived party |
| PATCH | `/host/parties/:id` | Update config, toggle on/off |
| GET | `/host/parties/:id/qr` | QR code PNG/SVG for join URL |
| POST | `/host/parties/:id/queue` | Host add track `{ uri }` (no rate limit; attributed to Host) |
| POST | `/host/parties/:id/queue/shuffle` | Shuffle normal upcoming lane; preserve boost lane + now-playing; rebuild buffer |
| POST | `/host/parties/:id/queue/clear` | Clear all upcoming; keep now-playing |
| POST | `/host/parties/:id/queue/start-from/:itemId` | Start queue from this upcoming item (drop everything before it in play order) |
| PATCH | `/host/parties/:id/queue/:itemId` | Host overrides: `{ action: "force_next" \| "move_up" \| "move_down" \| "reset_votes" }` |
| DELETE | `/host/parties/:id/queue/:itemId` | Host remove song (not currently playing) |
| POST | `/host/parties/:id/skip` | Skip currently playing track |
| PATCH | `/host/parties/:id/guests/:guestId` | `{ disabled: boolean }` ban/unban |
| GET | `/host/parties/:id/history` | Terminal history (`played` / `skipped` / `vetoed`) |

### Guest

| Method | Path | Description |
|---|---|---|
| POST | `/parties/:slug/join` | Create guest session; optional `{ displayName }` |
| PATCH | `/parties/:slug/me` | Set/update `{ displayName }` (required before mutations) |
| GET | `/parties/:slug` | Party info + status |
| GET | `/parties/:slug/queue` | Active virtual queue + attribution |
| GET | `/parties/:slug/now-playing` | Current track |
| GET | `/parties/:slug/search?q=` | Track search (max 10) + artist matches for browse |
| GET | `/parties/:slug/artists/:id/top-tracks` | Artist top tracks |
| POST | `/parties/:slug/queue` | Add track `{ uri }` |
| POST | `/parties/:slug/queue/:itemId/upvote` | Upvote |
| POST | `/parties/:slug/queue/:itemId/veto` | Veto |
| POST | `/parties/:slug/queue/:itemId/boost` | One-time boost |

Mutating guest endpoints return `403` with `code: "DISPLAY_NAME_REQUIRED"` if the guest has no display name.

### Polling

Guests poll `GET /parties/:slug/queue` every **3 seconds** when party is on. `ETag` / `If-None-Match` supported for 304 responses to reduce payload.

---

## UI Pages

### Guest (`/p/:slug`)

- Prompt for display name before enabling add/upvote/veto/boost
- Now playing banner
- Empty upcoming queue: show “Add something!”
- Queue list: art, title, artist, upvotes, added-by name, veto count
- Search bar with results; tap artist → top tracks view
- Actions per song: upvote (hidden/disabled on own songs), veto (disabled on now-playing; confirm warning if vetoing own song), boost (disabled if used or already boosted)
- Show remaining rate-limit quota subtly (e.g. "2 adds left")

### Host (`/admin`)

- Spotify connect status
- Create party (archives previous) + seed playlist picker (search or paste URL)
- On/off toggle (prominent)
- Warning when no active Spotify device / Spotify unreachable
- Veto threshold + rate-limit config
- QR code + copy link
- Queue management: add, shuffle, remove, force next, reorder, clear upcoming, skip now-playing, start-from-here
- Guests list: ban/unban
- Reset votes on a song
- History panel: browse past tracks (`played` / `skipped` / `vetoed`)

---

## Docker Compose

```yaml
services:
  jukebox:
    build: .
    restart: unless-stopped
    volumes:
      - jukebox-data:/data        # SQLite + encrypted tokens
    env_file:
      - .env.production           # SPOTIFY_*, BASE_URL, ENCRYPTION_KEY, HOST_SETUP_TOKEN

  cloudflared:
    image: cloudflare/cloudflared:latest
    restart: unless-stopped
    command: tunnel run
    env_file:
      - .env.cloudflared          # TUNNEL_TOKEN only
    depends_on:
      - jukebox

volumes:
  jukebox-data:
```

The jukebox service is **not** published to the host; only cloudflared exposes it.

---

## Spotify Developer Setup

Use **two Spotify apps** (recommended): one for development, one for production.

### Development app

1. Redirect URI: `http://127.0.0.1:3000/api/v1/host/spotify/callback`
2. Credentials go in `.env.development`

### Production app

1. Redirect URI: `https://{tunnel-hostname}/api/v1/host/spotify/callback`
2. Credentials go in `.env.production`
3. Set up Cloudflare Tunnel **before** registering this redirect URI
4. Generate `ENCRYPTION_KEY` and `HOST_SETUP_TOKEN`; add `TUNNEL_TOKEN` to `.env.cloudflared` (not `.env.production`)

Both apps:

- Required scopes: `user-modify-playback-state`, `user-read-playback-state`, `playlist-read-private`
- Host must have **Spotify Premium**
- Development mode; allowlist only the host account

**Setup order (production):** Cloudflare Tunnel → `.env.production` + `.env.cloudflared` → Spotify prod app → `docker compose up` → Admin (enter `HOST_SETUP_TOKEN`) → Connect Spotify

**Policy note:** Jukebox is for personal, non-commercial home use. Spotify prohibits commercial use and broadcasting synchronized content.

---

## Success Criteria

- [ ] Host completes OAuth and creates a party with seed playlist import on create.
- [ ] Creating a new party archives the previous one; only one non-archived party exists.
- [ ] Guest cannot mutate until display name is set.
- [ ] Guest joins via QR, adds a track, sees it in queue within one poll cycle.
- [ ] Guest cannot upvote their own song; can upvote others once each.
- [ ] Upvoting reorders pending tracks in the virtual queue.
- [ ] Boost places any eligible pending track in FIFO boost lane (including own); one boost per guest.
- [ ] Veto of own song shows a confirmation warning; currently playing cannot be vetoed.
- [ ] Veto at threshold immediately hides the song from the queue; if already buffered in Spotify, it is skipped and never plays.
- [ ] Duplicate title (fuzzy) against active + last 20 terminal tracks is rejected.
- [ ] Rate limits enforced with correct sliding windows; returns `429` with retry hint.
- [ ] Party off switch blocks all guest mutations within one poll cycle.
- [ ] No active Spotify device: guests can still add/vote; host sees warning; sync resumes when device active.
- [ ] Empty upcoming queue shows “Add something!”; Jukebox does not invent filler tracks.
- [ ] 50 concurrent guest sessions stable on target home hardware.
- [ ] Host can add, remove, shuffle (normal lane), force-next, reorder, clear upcoming, skip now-playing, reset votes, and ban guests.
- [ ] Host “Start from here” drops upcoming tracks before the selection and keeps the rest; does not skip now-playing; rebuilds Spotify buffer.
- [ ] History is retained for the party (audit/recovery visibility).
- [ ] Container restart preserves SQLite queue/history and does not skip/restart now-playing; sync soft-reconciles (rebuilds) the Spotify buffer.
- [ ] Brief Spotify/network outages keep guest queue ops working; host sees a warning until sync resumes.

---

## Implementation Plan (high level)

1. **Scaffold** — Bun + Hono + Vite + SQLite + Docker Compose
2. **Host OAuth** — Spotify auth, token storage, refresh, host session
3. **Party CRUD** — Create (archive previous), seed import on create, on/off toggle, persistence
4. **Guest sessions** — Join flow, display name gate
5. **Virtual queue** — Add, upvote, veto, boost, dedup, rate limits
6. **Host overrides** — Add/remove/shuffle/force-next/reorder/clear/skip/ban/reset-votes/start-from-here + history view
7. **Search** — Track search + artist top tracks proxy
8. **Sync worker** — Buffer 3–5, skip logic, inactive-device warning, restart soft-reconcile (rebuild buffer, never skip current)
9. **Guest UI** — Mobile queue view, search, actions, polling
10. **Host UI** — Admin, QR, config, device warning, full queue/history tools
11. **cloudflared** — Tunnel wiring + docs

---

## Open Questions

None — all requirements resolved. Spec is ready for Phase 2 (Plan).
