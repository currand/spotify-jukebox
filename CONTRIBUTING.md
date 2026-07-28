# Contributing

This guide is for developers working on Jukebox locally. **End users** only need Docker — see [README.md](README.md).

## Prerequisites

- [Bun](https://bun.sh) (runtime and test runner)
- Node.js is not required separately — Bun runs the app and tests
- Docker (optional, for mock stack parity or container builds)

Use **separate Spotify Developer apps** for local development and production when running live Spotify.

Spotify rejects `http://localhost` redirect URIs. Always use **`127.0.0.1`** in development.

---

## Local development (live Spotify)

### 1. Spotify dev app

Create a **development** app in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard):

- Redirect URI: `http://127.0.0.1:3000/api/v1/host/spotify/callback`
- Development mode; allowlist your account

### 2. Environment

```bash
cp -n .env.development.example .env.development
# Fill in SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET
```

`HOST_SETUP_TOKEN` is optional in development.

### 3. Install and run

```bash
bun install
bun run dev
```

| | URL |
|---|---|
| **UI (use this)** | http://127.0.0.1:5173/admin |
| **API** | http://127.0.0.1:3000/api/v1 |

Port 3000 is API-only in dev. Visiting it in a browser redirects to the Vite UI on 5173.

### 4. Production-like run (no Vite)

Build and run the production bundle locally:

```bash
bun run build
bun run start
```

Serves UI and API together on the port in `.env.production` (default 3000).

---

## Mock Spotify (local or Docker)

### Docker mock stack

Full container stack with a fake Spotify sidecar — no OAuth, no rate limits:

```bash
cp -n .env.development.example .env.development
docker compose --profile mock up --build -d
```

| | URL |
|---|---|
| **Jukebox** | http://127.0.0.1:3000/admin |
| **Mock Spotify (health)** | http://127.0.0.1:8080/health |

Connect Spotify from Admin — mock mode auto-connects without leaving the app.

The mock starts idle (device present, nothing playing). Tracks play when Jukebox queues them and advance after ~3 minutes by default (`MOCK_TRACK_DURATION_MS` on the `spotify-mock` service).

```bash
docker compose --profile mock down
```

### Mock sidecar + local API

Run only the mock Spotify container while developing against it:

```bash
docker compose --profile mock up spotify-mock -d --build
```

In `.env.development`:

```env
SPOTIFY_MODE=mock
SPOTIFY_API_BASE_URL=http://127.0.0.1:8080/v1
SPOTIFY_ACCOUNTS_BASE_URL=http://127.0.0.1:8080
```

Then `bun run dev` (API on 3000 talks to mock on 8080).

Mock controls: `POST http://127.0.0.1:8080/mock/advance`, `/mock/reset`, `/mock/rate-limit`.

---

## Tests and typecheck

```bash
bun test
bun run typecheck   # tsc --noEmit (alias: bun run lint)
```

Tests use in-memory SQLite and mock Spotify clients — no running containers required.

---

## Load / endurance testing

Prefer the **Docker mock stack** to avoid Spotify rate limits. Use production + real Spotify only for occasional integration checks.

```bash
# Start mock stack first (see above)

# Optional: pre-join guests and save session cookies
JUKEBOX_BASE_URL=http://127.0.0.1:3000 bun run scripts/join-guests.ts --slug my-party --count 30

# Full phased party sim (joins spread over 60 min by default)
JUKEBOX_BASE_URL=http://127.0.0.1:3000 bun run endurance --slug my-party --guests 30 --admin-token <host_session>

# Short smoke (5 min join window)
bun run endurance --slug my-party --guests 5 --join-window-min 5 --admin-token <token> --base-url http://127.0.0.1:3000
```

Flags: `--slug`, `--guests` (max 50), `--join-window-min`, `--admin-token`, `--base-url`, `--guests-file`, `--cache-stress`.

Report: `./data/endurance-{timestamp}.json` with diagnostics and **`firstBlock`** (outbound Spotify call index at first 429).

See [docs/ENDURANCE_TEST_ISSUES.md](docs/ENDURANCE_TEST_ISSUES.md) for troubleshooting.

---

## Docker helpers (package.json)

These wrap `docker compose` for convenience during development:

| Script | Underlying command |
|---|---|
| `bun run docker:up` | `docker compose --profile default up --build -d` |
| `bun run docker:up:tunnel` | `docker compose --profile default --profile tunnel -f docker-compose.yml -f docker-compose.tunnel.yml up --build -d` |
| `bun run docker:up:mock` | `docker compose --profile mock up --build -d` |
| `bun run docker:up:registry` | `docker compose --profile default --env-file .env up -d` |
| `bun run docker:publish` | Multi-arch build and push (see README) |
| `bun run docker:down` | `docker compose --profile default down` |

Setup shortcuts:

```bash
bun run setup:dev    # cp .env.development.example → .env.development
bun run setup:prod   # cp production/cloudflared/example env templates
```

Or copy env templates manually — see [README.md](README.md#environment-files).

---

## Private registry (optional)

Build and run a pre-built image instead of building on the host:

```bash
cp .env.example .env
# Set JUKEBOX_IMAGE=your-registry/jukebox:latest

docker login your-registry.example.com
docker buildx build --platform linux/amd64,linux/arm64 \
  -t your-registry/jukebox:latest --push .

docker compose --profile default --env-file .env up -d
```

Set `JUKEBOX_PLATFORM` in `.env` when building for a single architecture.

---

## Advanced environment tuning

Optional variables in `.env.production` (see `.env.production.example`):

| Variable | Default | Purpose |
|---|---|---|
| `SPOTIFY_API_BUDGET_COUNT` | 90 | Max outbound Spotify API calls per window |
| `SPOTIFY_API_BUDGET_WINDOW_MS` | 30000 | Budget window length |
| `SPOTIFY_DAILY_WARN_CALLS` | 8000 | Diagnostics warning threshold (24h) |
| `JUKEBOX_DEFAULT_RATE_LIMITS` | code defaults | JSON override for new-party guest limits |
| `SYNC_*` | adaptive | Sync polling tuning |
| `DEBUG` | off | `spotify`, `sync`, or `1` for verbose logs |

Guest default limits (before admin overrides):

| Action | Default | Window |
|---|---|---|
| Add | 3 | 20 min |
| Upvote | 10 | 60 min |
| Veto | 3 | 30 min |
| Boost | 1 | 10 min |
| Search (guest) | 6 | 60 sec |
| Search (party) | 24 | 30 sec |

---

## Project docs

| Doc | Purpose |
|---|---|
| [docs/SPEC.md](docs/SPEC.md) | Full specification |
| [docs/SECURITY.md](docs/SECURITY.md) | Secrets and production hardening |
| [docs/TEST_PLAN.md](docs/TEST_PLAN.md) | Manual QA scenarios |
