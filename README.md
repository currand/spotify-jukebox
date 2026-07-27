# Jukebox

Self-hosted party queue control for Spotify Premium.

## Environments

| Mode | Command | Env files |
|---|---|---|
| **Dev (local)** | `bun run dev` | `.env.development` |
| **Prod (Docker)** | `bun run docker:up` | `.env.production` |
| **Prod + tunnel** | `bun run docker:up:tunnel` | `.env.production`, `.env.cloudflared` |
| **Mock scale test** | `bun run docker:up:mock` | `.env.development` (+ compose overrides) |

Use **separate Spotify apps** for dev and prod when running live Spotify (`SPOTIFY_MODE=live`).

Spotify rejects `http://localhost`. Always use **`127.0.0.1`** in dev.

---

## Development setup

### 1. Spotify dev app (live mode only)

Skip this when using `bun run docker:up:mock` — mock mode needs no real Spotify app.

Create a **development** app in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard):

- Redirect URI: `http://127.0.0.1:3000/api/v1/host/spotify/callback`
- Development mode, allowlist your account

### 2. Env file

```bash
bun run setup:dev
# Fill in SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET for live mode
```

`HOST_SETUP_TOKEN` is optional in development.

### 3. Run

```bash
bun install
bun run dev
```

Open **http://127.0.0.1:5173/admin** for the UI.

| | URL |
|---|---|
| **UI (use this)** | http://127.0.0.1:5173/admin |
| **API** | http://127.0.0.1:3000/api/v1 |

Port 3000 is API-only in dev. Visiting it in a browser redirects to 5173.

---

## Mock Spotify scale testing (Docker)

Run a full container stack with a fake Spotify sidecar — no OAuth, no rate limits:

```bash
bun run setup:dev   # creates .env.development (values overridden by compose for mock)
bun run docker:up:mock
```

| | URL |
|---|---|
| **Jukebox** | http://127.0.0.1:3000/admin |
| **Mock Spotify (inspect)** | http://127.0.0.1:8080/health |

Connect Spotify from Admin — mock mode auto-connects without leaving the app.

The mock starts idle (device present, nothing playing). Tracks only play when Jukebox queues them, advance after ~3 minutes by default (`MOCK_TRACK_DURATION_MS`), and report `progress_ms` like a real player.

Endurance script targets the mock stack with:

```bash
JUKEBOX_BASE_URL=http://127.0.0.1:3000 bun run endurance --slug my-party --admin-token <host_session>
# or: --base-url http://127.0.0.1:3000
```

Optional mock controls: `POST http://127.0.0.1:8080/mock/advance`, `/mock/reset`, `/mock/rate-limit`.
For faster song cycling in long tests: `MOCK_TRACK_DURATION_MS=60000` on the `spotify-mock` service.

Run mock sidecar alone (e.g. alongside `bun run dev` with `SPOTIFY_MODE=mock` in `.env.development`):

```bash
bun run mock:spotify
```

---

## Production setup (Docker)

Docker runs the built app on port **3000** by default. Put your own reverse proxy in front, or use the Cloudflare Tunnel profile.

### 1. Spotify app

Create a **production** app in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard):

- Redirect URI: `https://your-public-hostname/api/v1/host/spotify/callback`
- Must match `BASE_URL` and `SPOTIFY_REDIRECT_URI` in `.env.production`

### 2. Env file

```bash
bun run setup:prod
```

**`.env.production`** (required):

```env
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
SPOTIFY_REDIRECT_URI=https://jukebox.example.com/api/v1/host/spotify/callback
BASE_URL=https://jukebox.example.com
ENCRYPTION_KEY=...      # openssl rand -hex 32  (≥ 32 characters)
HOST_SETUP_TOKEN=...    # openssl rand -hex 16
```

Prefer **https://**; for http:// LAN-only setups set `ALLOW_INSECURE_HTTP=1`.

### 3. Deploy

**Self-hosted** (port exposed):

```bash
bun run docker:up
```

**Private registry** (optional):

```bash
cp .env.example .env
# Set JUKEBOX_IMAGE=your-registry/jukebox:latest

docker login your-registry:5555
bun run docker:publish          # multi-arch build + push
bun run docker:up:registry      # run published image
```

**Cloudflare Tunnel** (no host port):

```bash
cp .env.cloudflared.example .env.cloudflared
# Add TUNNEL_TOKEN from Cloudflare Zero Trust → Tunnels

bun run docker:up:tunnel
```

Configure the tunnel public hostname → `http://jukebox:3000`.

### 4. Connect Spotify (first time)

1. Open `{BASE_URL}/admin`
2. Enter your `HOST_SETUP_TOKEN` in **Host setup token**
3. Click **Connect Spotify**

### 5. Logs

```bash
docker compose --profile default logs -f jukebox
docker compose --profile tunnel logs -f cloudflared
```

---

## How env loading works

| Command | Env files loaded |
|---|---|
| `bun run dev` | `.env.development`, then `.env.local` |
| `bun run start` | `.env.production`, then `.env.local` |
| `bun run docker:up` | container ← `.env.production`; compose ← `.env` (optional) |
| `bun run docker:up:tunnel` | above + `.env.cloudflared` |
| `bun run docker:up:mock` | `jukebox-mock` ← `.env.development` + compose mock overrides |
| `bun run docker:up:registry` | compose ← `.env` (`JUKEBOX_IMAGE`) |

Templates: `.env.development.example`, `.env.production.example`, `.env.cloudflared.example`, `.env.example`.

### Variable reference

| Variable | Dev | Prod | Notes |
|---|---|---|---|
| `SPOTIFY_MODE` | optional | — | `mock` (dev only) or `live` (default) |
| `SPOTIFY_API_BASE_URL` | optional | — | Default `https://api.spotify.com/v1` |
| `SPOTIFY_ACCOUNTS_BASE_URL` | optional | — | Default `https://accounts.spotify.com` |
| `SPOTIFY_CLIENT_ID` | required* | required | *Optional in mock mode |
| `SPOTIFY_CLIENT_SECRET` | required* | required | |
| `SPOTIFY_REDIRECT_URI` | required* | required | Must match `BASE_URL` hostname |
| `BASE_URL` | optional | required | Dev default `http://127.0.0.1:5173` |
| `ALLOW_INSECURE_HTTP` | — | optional | Set `1` for http:// production URLs (LAN) |
| `ENCRYPTION_KEY` | required | required | Prod: ≥ 32 chars |
| `HOST_SETUP_TOKEN` | optional | required | Prod: enter in Admin before Connect Spotify |
| `TUNNEL_TOKEN` | — | `.env.cloudflared` only | Tunnel profile only |
| `JUKEBOX_IMAGE` | — | `.env` only | Compose interpolation; default `jukebox:local` |
| `JUKEBOX_PORT` | — | `.env` or shell | Host port (default `3000`) |

---

## Tests

```bash
bun test
```

### Load / endurance testing

Prefer the **mock stack** for load tests (`bun run docker:up:mock`) to avoid Spotify rate limits. Use production + real Spotify for occasional integration checks.

```bash
# Optional: pre-join guests and save session cookies
JUKEBOX_BASE_URL=http://127.0.0.1:3000 bun run scripts/join-guests.ts --slug my-party --count 30

# Full 3h phased party sim (joins spread over 60 min by default)
JUKEBOX_BASE_URL=http://127.0.0.1:3000 bun run endurance --slug my-party --guests 30 --admin-token <token>

# Short dev smoke (5 min join window)
bun run endurance --slug my-party --guests 5 --join-window-min 5 --admin-token <token> --base-url http://127.0.0.1:3000
```

Flags: `--slug`, `--guests` (max 50), `--join-window-min`, `--admin-token`, `--base-url`, `--guests-file`, `--cache-stress`.

Report written to `./data/endurance-{timestamp}.json` with diagnostics time series and **`firstBlock`** (outbound Spotify call index at first 429).

Between runs: clear guests or reuse session cookies — see [docs/ENDURANCE_TEST_ISSUES.md](docs/ENDURANCE_TEST_ISSUES.md).

See [docs/SPEC.md](docs/SPEC.md) for the full specification.

## Security

See [docs/SECURITY.md](docs/SECURITY.md) for the pre-GitHub checklist, secret handling, and production hardening notes.
