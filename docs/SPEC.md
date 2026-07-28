# Spec: Jukebox

## Objective

Jukebox is a self-hosted web application that lets party guests control the host's Spotify playback queue via phone — without being a player itself. The host runs Jukebox on a home Docker server; guests join via QR code or link, search for tracks, upvote songs, downvote unwanted tracks, and use a one-time boost to jump a song toward the front.

**Primary user:** Host (Spotify Premium, home server, one active Connect device).

**Secondary users:** Party guests (anonymous, mobile browser, no Spotify account required).

**Success looks like:**
- Host creates a party in under 2 minutes (OAuth once, pick seed playlist, share QR).
- Up to 50 guests concurrently browse, vote, and add tracks with sub-5s perceived latency via polling.
- Virtual queue behavior (upvotes, boost lane, downvotes) matches spec even though Spotify's native queue cannot be reordered or edited.
- Entire stack runs in Docker Compose on a modest home server (~256 MB RAM for the app container).

### User stories

| Actor | Story |
|---|---|
| Host | I log in with Spotify once so Jukebox can control playback on my active device. |
| Host | I start a party, pick a seed playlist, and share a QR code. |
| Host | I turn the party on or off with a single switch. |
| Host | I configure downvote threshold and guest rate limits before or during a party. |
| Host | I see a warning when no Spotify device is active, while guests can still add/vote. |
| Host | I manage the virtual queue: add, shuffle, reorder, force-next, clear upcoming, skip, ban guests, reset votes, and “start from here.” |
| Host | After a server restart or network blip, music keeps playing and the virtual queue/history are intact. |
| Guest | I scan a QR code and enter a display name before I can add, vote, downvote, or boost. |
| Guest | I see the current queue, who added each song, and live upvote counts. |
| Guest | I search for tracks or browse an artist's songs and add one to the queue. |
| Guest | I upvote songs I want to hear sooner (not my own). |
| Guest | I downvote a song; if enough guests agree, it is removed/skipped. |
| Guest | I boost one song per party (mine or anyone else's) into a priority lane sorted by upvotes. |

---

## Tech Stack

| Layer | Choice | Rationale |
|---|---|---|
| Language | TypeScript | Host preference; shared types across API and UI |
| Runtime | Bun | Low memory, fast startup, built-in TS |
| HTTP framework | Hono | Lightweight, good Bun support |
| Database | SQLite (`bun:sqlite`) | Zero extra container, sufficient for 50 guests |
| Frontend | React + Vite | Mobile-first SPA, static assets served by API |
| Spotify | Web API + OAuth 2.0 Authorization Code (host only) | Queue control requires Premium |
| Tunnel | cloudflared | HTTPS without port forwarding |
| Container | Docker Compose | Self-hosted requirement |

---

## Commands

**Deployment** (Docker only — see [README.md](../README.md)):

```bash
# Setup
cp .env.production.example .env.production
cp .env.cloudflared.example .env.cloudflared   # tunnel only
cp .env.example .env                           # optional registry/port

# Production
docker compose --profile default up --build -d

# Production + Cloudflare Tunnel
docker compose --profile default --profile tunnel \
  -f docker-compose.yml -f docker-compose.tunnel.yml up --build -d

# Mock Spotify (no real credentials)
docker compose --profile mock up --build -d

# Logs
docker compose --profile default logs -f jukebox
docker compose --profile default --profile tunnel logs -f cloudflared
docker compose --profile mock logs -f jukebox-mock spotify-mock
```

**Local development and tests** — see [CONTRIBUTING.md](../CONTRIBUTING.md) (requires Bun).

---

## Project Structure

```
jukebox/
├── docker-compose.yml
├── Dockerfile
├── services/
│   └── spotify-mock/           # Dev-only Spotify API mock for scale testing
├── docs/
│   ├── SPEC.md                 # This document
│   ├── SECURITY.md             # Pre-GitHub checklist + production hardening
│   ├── TEST_PLAN.md            # UAT/QAT scenario tables
│   ├── TODO.md                 # Bug/enhancement log
│   └── ENDURANCE_TEST_ISSUES.md # Load-test findings
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
│   └── unit/                   # Unit + in-memory-SQLite integration tests
└── package.json
```

---

## Code Style

- **Formatting:** No formatter configured — match existing style; 2-space indent.
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
- Require a non-empty display name before any guest mutation (add / upvote / downvote / boost).
- Store Spotify refresh token encrypted at rest.
- Run `bun test` before commits — see [CONTRIBUTING.md](../CONTRIBUTING.md).

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

**Implication:** Tracks already pushed to Spotify but later demoted or downvoted are **skipped** when they reach the front. Upvote resorting applies only to tracks not yet sent to Spotify.

**Search limit (Feb 2026):** Max 10 results per search request. UI paginates or prompts refinement.

### Virtual queue

**Normal queue:** Sorted by upvote count (desc), then `addedAt` (asc).

**Boost lane:** Separate priority lane. Within the lane, tracks sort by upvote count (desc), then `boost_position` (asc) as tie-breaker. When the current track ends, the next track is taken from the boost lane if non-empty; otherwise from the normal queue head.

**Track lifecycle:** `pending` → `queued` (sent to Spotify) → `playing` → `played` | `skipped` | `downvoted`

**Visible queue:** Guests see `pending`, `queued`, and `playing`. Terminal states (`played`, `skipped`, `downvoted`) leave the active list; `played` and `downvoted` feed recent dedup history (see Deduplication). `skipped` does not.

### Interaction rules

| Action | Rule |
|---|---|
| Upvote | One upvote per guest per song. Cannot upvote a song you added. Host-seeded songs may be upvoted by any guest. |
| Boost | One boost per guest per party. May boost any pending (not yet playing) song — including your own or someone else's. Costs the single boost either way. Cannot boost a song already in the boost lane. |
| Downvote | One downvote per guest per song. Allowed on own songs, but the UI must warn before confirming (“You’re about to downvote a song you added”). Not allowed on the currently playing track. When downvote count reaches the party threshold, the song is immediately set to `downvoted`, removed from the guest queue UI, and never played; if it was already `queued` in Spotify’s buffer, it is skipped when it would reach the front (or skipped from the buffer on next sync). |
| Display name | Required (non-empty) before any mutating action. Join may create a session without a name; first mutation must set one (or join UI requires it before enabling actions). |

### Spotify sync worker

When a party is **on**, a background worker keeps the virtual queue aligned with Spotify playback:

1. Poll `GET /me/player` (with `/me/player/currently-playing` fallback) for device state, current track URI, and timing (`progress_ms`, `duration_ms`).
2. **Adaptive polling (default):** schedule the next poll ~7s before the current track is expected to end; wake immediately on queue mutations, skip, and host play/pause. Set `SYNC_FAST_POLL=1` to restore fixed 10s polling.
3. If no active device / no playback: **do not fail guest mutations**. Set host-visible warning `spotify_device_inactive`. Skip Spotify write calls until a device is active again.
4. Detect track transitions; mark previous item `played` or `skipped`.
5. Select next virtual track (boost lane first, then normal head; never select downvoted).
6. Maintain **one** Spotify queue buffer slot via `POST /me/player/queue` when empty (Spotify's Web API only supports appending, not batch/lookahead queueing).
7. If the currently playing Spotify track is downvoted or no longer in the virtual queue, call `POST /me/player/next`.
8. Do not add duplicate URIs already in the Spotify queue buffer.
9. If the virtual queue has no upcoming tracks: stop adding to Spotify; guest UI shows “Add something!” Now-playing may finish naturally; Spotify’s own autoplay/recommendations are out of scope — Jukebox does not try to keep music going.

**Host playback controls:** Admin can Start/Stop Spotify playback (`PUT /me/player/play` / `pause`) and Skip the current track.

**Device targeting:** While a party is active, all Spotify **write** calls (`play`, `pause`, `queue`, `skip`, bootstrap start) use the party's selected `target_spotify_device_id`. Player **read** calls stay unscoped (`GET /me/player`) so sync can observe whichever device is playing after transfer.

**Bootstrap on first Turn ON:** When `bootstrap_playlist_id` is null and the virtual queue is all `pending`, Jukebox creates a private playlist named exactly **`party.name`**, adds the first 1–2 upcoming tracks, and starts it on the selected device via `PUT /me/player/play?device_id=…` with `context_uri`. Resume skips bootstrap when a bootstrap playlist already exists and the queue has `playing`/`queued` items.

### Deduplication

Before adding a track, compare **folded title and artist** against:

- All **active** queue items (`pending`, `queued`, `playing`)
- The **20 most recent** terminal items with status `played` or `downvoted`, ordered by `finished_at DESC`

`skipped` items are excluded — guests may re-add songs they removed.

Matching (see `src/shared/dedup.ts`):

- **Title fold:** NFKD accent strip, lowercase, strip cosmetic suffixes (`Remaster`, `Explicit`, `Clean`), alphanumeric-only key.
- **Artist fold:** NFKD, strip leading `The` / trailing `, The`, primary artist before `,` / `&` / `feat.`, alphanumeric-only key.
- **Primary match:** exact fold equality on title and artist.
- **Fallback:** Levenshtein ratio ≥ 0.85 on folded strings (typos).
- **Duration guard:** when both sides have `duration_ms`, require |Δ| ≤ 5s; otherwise fold match alone applies.

Search UI uses the same logic: URI match or fold match on active items → “In queue”; fold match on history → “Already played”. Search results themselves are not filtered — only add is blocked.

Reject add with `{ error: "This song is already in the queue", code: "DUPLICATE" }`.

### Rate limits (defaults, all configurable per party; see `src/shared/types.ts` `DEFAULT_RATE_LIMITS`)

Sliding-window counters per guest per action type, plus a party-wide search budget:

| Action | Default limit | Window | Scope |
|---|---|---|---|
| Add track | 3 | 20 minutes | Per guest |
| Upvote | 10 | 60 minutes | Per guest |
| Downvote | 3 | 30 minutes | Per guest |
| Boost | 1 | 10 minutes | Per guest (sliding window) |
| Search | 6 | 60 seconds | Per guest |
| Party search | 24 | 30 seconds | Whole party (shared budget across all guests) |

Boost also enforces a one-time-use flag (`guests.boost_used`) per party — a guest can have at most one active boost regardless of the sliding window; unboosting refunds it. An optional per-party `boost_cap` limits how many tracks may be boosted at once.

Return `429` with `{ error: "<action-specific message>", code: "RATE_LIMITED", retryAfterMs: number }`. The `error` string names the limit hit (e.g. `"You've added your limit of 3 songs. Try again in 12 minutes."`) rather than a generic message.

### Party lifecycle

- **Cardinality:** Exactly **one active party** at a time. Creating a new party ends/archives the previous one (status becomes historical; guests of the old party can no longer mutate).
- **End party:** Soft-archives the party (`status = 'archived'`) without terminalizing queue items, so the host can **resume** the same party later (same slug, guest sessions, votes, and queue order).
- **Resume party:** Reactivates an archived party as `off`. Only available when the archived party still has `pending`/`queued`/`playing` items. Legacy parties fully terminalized before this feature support seed import only.
- **Previous parties:** Admin lists all archived parties; any can seed a new party’s track list, or be resumed when `canResume` is true.
- **Binary switch:** Party is either `on` or `off` (admin toggle). No auto-expiry timer.
- When **off:** Guests can still load the page but all mutations return `403`. Sync worker idle.
- When **on:** Sync worker active; guests can interact within rate limits.
- **Seed playlist:** Imported **once on party creation**. Import **all** tracks from the selected Spotify playlist in playlist order. Each seed track enters the normal queue with 0 upvotes, attributed to "Host". Turning the party off/on does **not** re-seed or clear guest adds.

### Host authentication

- Host admin (`/admin`) session is established via **Spotify OAuth** (Authorization Code flow for the host Premium account); successful OAuth sets a host session cookie.
- **Production** may require `HOST_SETUP_TOKEN` (`openssl rand -hex 16`) as a query param or `X-Host-Setup-Token` header on `/host/spotify/login`, so a leaked public URL alone cannot be used to connect a stranger's Spotify account and take over admin. **Not required** when binding to `127.0.0.1` only (`BIND_HOST=127.0.0.1`), when Docker publishes on localhost only (default `127.0.0.1:JUKEBOX_PORT`), when `BASE_URL` uses `127.0.0.1`, when using Cloudflare Tunnel (`CLOUDFLARE_TUNNEL=1`, set automatically by `docker-compose.tunnel.yml`), or when `DISABLE_HOST_SETUP_TOKEN=1`. Never required in development (`JUKEBOX_ENV=development`).
- When the setup token is disabled, admin UI hides the **Host setup token** field; `/host/spotify/status` returns `hostSetupTokenRequired: false`.
- No separate host password/PIN beyond the setup token (when enabled) — see `docs/SECURITY.md`.
- Spotify Developer Dashboard should keep the app in **Development mode** with only the host's account allowlisted.

### Host controls

- Spotify OAuth connect / disconnect
- Create party (name, seed playlist, slug) — ends any previous active party; rejects party names that collide with an existing Spotify playlist (`409 PLAYLIST_NAME_COLLISION`)
- **Target player picker** — list Spotify Connect devices (`GET /host/spotify/devices`); save selection on the party (`PATCH` with `spotifyDeviceId`); Turn ON requires a compatible device (`400 DEVICE_REQUIRED`)
- Resume archived party (same slug; preserves guests, queue, votes) or import any archived party’s track list as seed for a new party
- **Delete archived party** — removes party data and deletes the bootstrap Spotify playlist if present
- Party on/off switch (Turn ON runs bootstrap playback on the selected device when needed)
- Configure: downvote threshold, rate-limit windows
- Display QR code + share link
- Warning banner when Spotify has no active playback on the target device (recovery state after bootstrap)
- **Queue management (host overrides):**
  - Add tracks to the virtual queue (no guest rate limits; attributed to "Host")
  - **Shuffle:** Randomize all upcoming tracks in the **normal lane** (`pending` + `queued`, not playing). Leave **boost lane** order and **now-playing** untouched. Mark shuffled items back to `pending` as needed and **rebuild** the Spotify buffer (do not skip current track).
  - Remove any non-playing queue item immediately (no downvote threshold)
  - Force a song to play next (move to front of boost lane / host priority)
  - Manual reorder (move up/down within the normal upcoming list)
  - Clear remaining queue (keep now-playing; mark all other upcoming as host-cleared/`skipped`)
  - Skip currently playing track (`POST /me/player/next` + mark virtual item `skipped`)
  - Ban/disable a guest session (blocks further mutations; existing queue items stay unless host removes them)
  - Reset upvote counts on a song (to 0; clears vote rows for that item)
  - **Start from here:** Host selects an upcoming song; every upcoming track that would play **before** it (in play order: boost lane FIFO, then normal by votes/`addedAt`) is removed (`skipped`); the selected song and everything after it remain. Effectively “start the queue from here.” Rebuild Spotify buffer; never skip now-playing unless the host separately skips.
- **History:**
  - View song history for the active party (`played`, `skipped`, `downvoted`) for audit and recovery visibility
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
  3. Soft-reconcile: **refill** the single Spotify upcoming buffer slot to match the virtual upcoming list **without** skipping the current track.
  4. If Spotify is unreachable briefly, keep serving guests from SQLite; resume sync when API is back; show host warning.
- Guest mutations never require Spotify to be reachable; only the sync worker does.

### Guest identity

- Anonymous session via HTTP-only cookie (`guest_session`).
- Display name required before mutations (add / upvote / downvote / boost).
- Names shown on adds and (where applicable) boosts/downvotes in the UI.
- No Spotify login for guests.

### Cloudflare

- **Optional.** Use compose profile `tunnel` with `docker-compose.tunnel.yml` (see README).
- Default production compose exposes port 3000 for your own reverse proxy or LAN access.
- **cloudflared** provides public HTTPS when using the tunnel profile; set tunnel hostname → `http://jukebox:3000`.
- The tunnel overlay sets `CLOUDFLARE_TUNNEL=1` on the jukebox container, which **disables `HOST_SETUP_TOKEN`** — protect admin with Cloudflare Access, a custom frontend, or by turning the tunnel off when not hosting.
- Set up the tunnel (if used) before registering the **production** Spotify app redirect URI.
- No Cloudflare Access, Workers, or other Cloudflare features in v1.

### Mock Spotify (development only)

- **Optional.** `docker compose --profile mock up --build -d` runs `jukebox-mock` + `spotify-mock` sidecar.
- Set `SPOTIFY_MODE=mock` (dev only) to point at `SPOTIFY_API_BASE_URL` / `SPOTIFY_ACCOUNTS_BASE_URL`.
- No OAuth, encryption requirements, or real Spotify credentials needed for scale testing.
- Mock service implements search, player, queue, playlist seed, device list, playlist create/delete, context playback, and token refresh stubs.

**Environment files:**

| File | Use |
|---|---|
| `.env.development` | Local dev + mock stack — Spotify dev app or mock placeholders |
| `.env.production` | Docker **jukebox** service — Spotify prod app, public `BASE_URL`, secrets |
| `.env.cloudflared` | Optional — tunnel profile only (`TUNNEL_TOKEN`) |
| `.env` | Optional — Compose interpolation (`JUKEBOX_IMAGE`, `JUKEBOX_PORT`) |
| `.env.local` | Optional overrides (gitignored), loaded after the env file above |

**Production secrets to generate:**

```bash
openssl rand -hex 32   # ENCRYPTION_KEY (≥ 32 characters)
openssl rand -hex 16   # HOST_SETUP_TOKEN — only when required (see docs/SECURITY.md)
```

`HOST_SETUP_TOKEN` is optional in development. Required in production for public deployments only — not for localhost-only (`BIND_HOST=127.0.0.1`) or Cloudflare tunnel (`CLOUDFLARE_TUNNEL=1`).

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
| downvote_threshold | INTEGER | Default 3 |
| seed_playlist_id | TEXT | Spotify playlist ID |
| rate_limits | JSON | `{ add, upvote, downvote, boost, search, partySearch }`, each `{ count, windowMs }` |
| boost_cap | INTEGER NULL | Optional cap on concurrently boosted tracks |
| bootstrap_playlist_id | TEXT NULL | Ephemeral Spotify playlist created on first Turn ON |
| target_spotify_device_id | TEXT NULL | Selected Spotify Connect device for write calls |
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
| tutorial_seen | BOOLEAN | Default false; dismissable first-use walkthrough |
| last_seen_at | DATETIME NULL | Updated on activity; used for stale-guest purge |
| last_ip | TEXT NULL | Used for display-name reclaim IP check |
| created_at | DATETIME | |

### `queue_items`

| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | UUID |
| party_id | TEXT FK | |
| spotify_uri | TEXT | |
| track_name | TEXT | Denormalized for dedup/display |
| artist_name | TEXT | Denormalized for dedup/display |
| album_art_url | TEXT NULL | |
| duration_ms | INTEGER NULL | Track length when known (duration guard) |
| upvote_count | INTEGER | Denormalized counter |
| downvote_count | INTEGER | Denormalized counter |
| status | TEXT | `pending` \| `queued` \| `playing` \| `played` \| `skipped` \| `downvoted` \| `unblocked` |
| is_boosted | BOOLEAN | In boost lane |
| boost_position | INTEGER NULL | FIFO order within boost lane |
| boosted_by_guest_id | TEXT NULL FK | Guest who boosted (may differ from `added_by_guest_id`) |
| manual_order | INTEGER NULL | Host shuffle/reorder override |
| from_seed | BOOLEAN | Imported from the party's seed playlist |
| from_spotify | BOOLEAN | Adopted from Spotify's own queue (added outside Jukebox) |
| added_by_guest_id | TEXT NULL FK | NULL = host seed |
| added_at | DATETIME | |
| finished_at | DATETIME NULL | When moved to terminal status (for “recent 20” dedup) |

### `votes`

| Column | Type | Notes |
|---|---|---|
| guest_id | TEXT FK | |
| queue_item_id | TEXT FK | |
| created_at | DATETIME | PRIMARY KEY (guest_id, queue_item_id) |

### `downvotes`

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
| action | TEXT | `add` \| `upvote` \| `downvote` \| `boost` \| `search` |
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

### `oauth_states`

| Column | Type | Notes |
|---|---|---|
| state | TEXT PK | One-time OAuth CSRF token |
| created_at | DATETIME | Enforces 10-minute TTL |

### `host_settings`

| Column | Type | Notes |
|---|---|---|
| key | TEXT PK | e.g. `default_guest_limits` |
| value | JSON | |
| updated_at | DATETIME | |

Party-independent defaults (rate limits, downvote threshold, boost cap) applied to newly created parties; falls back to `JUKEBOX_DEFAULT_RATE_LIMITS` env, then code defaults.

### `metrics_sessions` / `metrics_snapshots`

Time-series diagnostics history (one session per app start; snapshots on interval, rate-limit events, and startup) backing the Admin diagnostics/history views. Not part of core party logic.

---

## API Design

Base path: `/api/v1`

### Host (Spotify OAuth session cookie)

| Method | Path | Description |
|---|---|---|
| GET | `/host/spotify/login` | Redirect to Spotify OAuth |
| GET | `/host/spotify/callback` | OAuth callback → host session |
| GET | `/host/spotify/status` | Connected, token expiry, sync/device warnings, `hostSetupTokenRequired` |
| GET | `/host/spotify/playlists` | Current user's non-empty Spotify playlists for seed picker (track count from list API; no duration) |
| GET | `/host/spotify/devices` | Spotify Connect devices for target-player picker (compatible + incompatible, sorted active first) |
| POST | `/host/logout` | Clear host session |
| POST | `/host/parties` | Create party (archives previous active party; imports seed; `409 PLAYLIST_NAME_COLLISION` if name matches existing Spotify playlist) |
| GET | `/host/parties/current` | Current non-archived party |
| GET | `/host/parties/archived` | List archived parties with resume/export summary |
| GET | `/host/parties/last-ended` | Most recent archived party export (backward compat) |
| GET | `/host/parties/:id/export` | Export track list for any archived party |
| POST | `/host/parties/:id/end` | Soft-archive party (preserves queue for resume) |
| POST | `/host/parties/:id/resume` | Reactivate archived party (same slug; guests/tokens/queue intact) |
| DELETE | `/host/parties/:id` | Delete archived party and its bootstrap Spotify playlist |
| PATCH | `/host/parties/:id` | Update config, `spotifyDeviceId`, toggle on/off (`400 DEVICE_REQUIRED` without device on first Turn ON) |
| GET | `/host/parties/:id/qr` | QR code PNG/SVG for join URL |
| POST | `/host/parties/:id/queue` | Host add track `{ uri }` (no rate limit; attributed to Host) |
| POST | `/host/parties/:id/queue/shuffle` | Shuffle normal upcoming lane; preserve boost lane + now-playing; rebuild buffer |
| POST | `/host/parties/:id/queue/clear` | Clear all upcoming; keep now-playing |
| POST | `/host/parties/:id/queue/start-from/:itemId` | Start queue from this upcoming item (drop everything before it in play order) |
| PATCH | `/host/parties/:id/queue/:itemId` | Host overrides: `{ action: "force_next" \| "move_up" \| "move_down" \| "reset_votes" }` |
| DELETE | `/host/parties/:id/queue/:itemId` | Host remove song (not currently playing) |
| POST | `/host/parties/:id/skip` | Skip currently playing track |
| PATCH | `/host/parties/:id/guests/:guestId` | `{ disabled: boolean }` ban/unban |
| GET | `/host/parties/:id/history` | Terminal history (`played` / `skipped` / `downvoted`) |
| GET | `/host/parties/:id/search?q=` | Track search + artist matches |
| GET | `/host/parties/:id/artists/:id/tracks?name=&filter=all\|credited` | Artist track search (same as guest) |
| POST | `/host/parties/:id/sync` | Force an immediate sync tick |
| POST | `/host/parties/:id/play` / `/pause` | Start/stop Spotify playback on the party's target device |
| GET | `/host/parties/:id/guests` | List guests with admin view (last seen, quota usage) |
| DELETE | `/host/parties/:id/guests` | Clear all guests from the party |
| POST | `/host/parties/:id/guests/purge-stale` | Remove guests inactive beyond a threshold |
| POST | `/host/parties/:id/guests/:guestId/reset-limits` | Reset a guest's rate-limit usage |
| POST | `/host/parties/:id/history/:itemId/unblock` | Un-terminalize a history item back into the queue |
| GET / PATCH | `/host/settings/default-rate-limits` | Party-independent default guest limits (`JUKEBOX_DEFAULT_RATE_LIMITS` override) |
| GET | `/host/diagnostics` | Live API/search/cache metrics (current process session) |
| GET | `/host/metrics/sessions` | List persisted metrics sessions (one per app start) |
| GET | `/host/metrics/sessions/:id/snapshots` | Snapshot timeline for a session (`?reason=rate_limit`) |
| GET | `/host/metrics/sessions/:id/snapshots/:snapshotId` | Full diagnostics payload at a point in time |

### Guest

| Method | Path | Description |
|---|---|---|
| POST | `/parties/:slug/join` | Create guest session; optional `{ displayName }` |
| PATCH | `/parties/:slug/me` | Set/update `{ displayName }` (required before mutations) |
| GET | `/parties/:slug` | Party info + status |
| GET | `/parties/:slug/queue` | Active virtual queue + attribution + `nowPlaying` |
| GET | `/parties/:slug/search?q=` | Track search (max 10) + artist matches for browse |
| GET | `/parties/:slug/artists/:id/tracks?name=&filter=all\|credited` | Artist track search (`artist:{name}`; `credited` filters to that artist) |
| POST | `/parties/:slug/queue` | Add track `{ uri }` |
| POST | `/parties/:slug/queue/:itemId/upvote` | Upvote |
| POST | `/parties/:slug/queue/:itemId/downvote` | Downvote |
| POST | `/parties/:slug/queue/:itemId/boost` | One-time boost |
| POST | `/parties/:slug/queue/:itemId/unboost` | Undo a boost (refunds `boost_used`) |
| GET | `/parties/:slug/me` | Current guest session info |
| GET | `/parties/:slug/me/info` | Guest profile stats (votes, downvotes, boosts) |
| GET | `/parties/:slug/me/songs` | Guest's own active + history songs ("My Songs") |
| DELETE | `/parties/:slug/me/songs/:itemId` | Remove a guest's own pending song |

There is no separate `now-playing` endpoint — the current track is included as `nowPlaying` in the `/queue` response.

Mutating guest endpoints return `403` with `code: "DISPLAY_NAME_REQUIRED"` if the guest has no display name.

### Polling

Guests poll `GET /parties/:slug/queue` every **3 seconds** when party is on. `ETag` / `If-None-Match` supported for 304 responses to reduce payload.

---

## UI Pages

### Guest (`/p/:slug`)

- Prompt for display name before enabling add/upvote/downvote/boost
- Now playing banner
- Empty upcoming queue: show “Add something!”
- Queue list: art, title, artist, upvotes, added-by name, downvote count
- Search bar with results; tap artist → songs or credited “top tracks” view (both use Spotify track search, not `/artists/{id}/top-tracks`)
- Actions per song: upvote (hidden/disabled on own songs), downvote (disabled on now-playing; confirm warning if downvoting own song), boost (disabled if used or already boosted)
- Show remaining rate-limit quota subtly (e.g. "2 adds left")

### Host (`/admin`)

- Spotify connect status
- Create party (archives previous) + seed playlist picker (Spotify account playlists)
- On/off toggle (prominent)
- Warning when no active Spotify device / Spotify unreachable
- downvote threshold + rate-limit config
- QR code + copy link
- Queue management: add, shuffle, remove, force next, reorder, clear upcoming, skip now-playing, start-from-here
- Guests list: ban/unban
- Reset votes on a song
- History panel: browse past tracks (`played` / `skipped` / `downvoted`)

---

## Docker Compose

**Compose profiles** (`docker-compose.yml`):

| Profile | Services | Command |
|---|---|---|
| `default` | `jukebox` (port published) | `docker compose --profile default up --build -d` |
| `tunnel` | `jukebox` (no host port) + `cloudflared` | `docker compose --profile default --profile tunnel -f docker-compose.yml -f docker-compose.tunnel.yml up --build -d` |
| `mock` | `jukebox-mock` + `spotify-mock` | `docker compose --profile mock up --build -d` |

```yaml
# Simplified — see docker-compose.yml for full config
services:
  jukebox:
    profiles: [default, tunnel]
    env_file: [.env.production]
    ports: ["127.0.0.1:${JUKEBOX_PORT:-3000}:3000"]
    environment:
      BIND_HOST: "0.0.0.0"
      PORT: "3000"

  jukebox-mock:
    profiles: [mock]
    env_file: [.env.development]
    environment:
      SPOTIFY_MODE: mock
      SPOTIFY_API_BASE_URL: http://spotify-mock:8080/v1

  spotify-mock:
    profiles: [mock]
    build: ./services/spotify-mock

  cloudflared:
    profiles: [tunnel]
    env_file: [.env.cloudflared]
```

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
4. Generate `ENCRYPTION_KEY`; add `HOST_SETUP_TOKEN` only for public (non-tunnel, non-localhost) deployments; add `TUNNEL_TOKEN` to `.env.cloudflared` (not `.env.production`)

Both apps:

- Required scopes: `user-modify-playback-state`, `user-read-playback-state`, `playlist-read-private`, `playlist-modify-private`
- Host must have **Spotify Premium**
- Development mode; allowlist only the host account
- Existing installs must **re-connect Spotify** once after upgrading to grant `playlist-modify-private`

**Setup order (production):** Spotify prod app → `.env.production` → `docker compose --profile default up --build -d` (or tunnel overlay + `.env.cloudflared`) → Admin (enter `HOST_SETUP_TOKEN` if required) → Connect Spotify

**Setup order (mock scale test):** `cp .env.development.example .env.development` → `docker compose --profile mock up --build -d` → Admin → Connect Spotify (auto-connected in mock mode)

**Policy note:** Jukebox is for personal, non-commercial home use. Spotify prohibits commercial use and broadcasting synchronized content.

---

## Success Criteria

- [ ] Host completes OAuth, picks a target Spotify Connect device, and creates a party with seed playlist import on create.
- [ ] Party create rejects names that match an existing Spotify playlist (`PLAYLIST_NAME_COLLISION`).
- [ ] Turn ON requires a selected compatible device; bootstrap playlist starts on that device.
- [ ] Sync write calls target the party's selected device.
- [ ] Delete archived party removes bootstrap Spotify playlist.
- [ ] Creating a new party archives the previous one; only one non-archived party exists.
- [ ] Guest cannot mutate until display name is set.
- [ ] Guest joins via QR, adds a track, sees it in queue within one poll cycle.
- [ ] Guest cannot upvote their own song; can upvote others once each.
- [ ] Upvoting reorders pending tracks in the virtual queue.
- [ ] Boost places any eligible pending track in FIFO boost lane (including own); one boost per guest.
- [ ] Downvote of own song shows a confirmation warning; currently playing cannot be downvoted.
- [ ] Downvote at threshold immediately hides the song from the queue; if already buffered in Spotify, it is skipped and never plays.
- [ ] Duplicate title (fuzzy) against active + last 20 terminal tracks is rejected.
- [ ] Rate limits enforced with correct sliding windows; returns `429` with retry hint.
- [ ] Party off switch blocks all guest mutations within one poll cycle.
- [ ] No active playback on target device: guests can still add/vote; host sees warning; bootstrap or manual recovery restores playback.
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
5. **Virtual queue** — Add, upvote, downvote, boost, dedup, rate limits
6. **Host overrides** — Add/remove/shuffle/force-next/reorder/clear/skip/ban/reset-votes/start-from-here + history view
7. **Search** — Track + artist search via Spotify `/search` (dev-mode apps cannot use `/artists/{id}/top-tracks`)
8. **Sync worker** — One-slot buffer, skip logic, device-targeted writes, bootstrap on Turn ON, inactive-device warning, restart soft-reconcile (refill buffer, never skip current)
9. **Guest UI** — Mobile queue view, search, actions, polling
10. **Host UI** — Admin, QR, config, device warning, full queue/history tools
11. **cloudflared** — Tunnel wiring + docs

---

## Open Questions

None — all requirements resolved. Spec is ready for Phase 2 (Plan).
