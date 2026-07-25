# Jukebox

Self-hosted party queue control for Spotify Premium.

## Environments

Jukebox uses **separate env files** with **separate Spotify apps** for dev and prod:

| | Development | Production (Docker) |
|---|---|---|
| **Env files** | `.env.development` | `.env.production` (+ `.env.cloudflared` if using tunnel overlay) |
| **Spotify app** | Dev app (127.0.0.1 redirect) | Prod app (your public URL) |
| **Cloudflare** | Not used | Optional — `docker-compose.cloudflare.yml` |
| **Run** | `bun run dev` | `bun run docker:up` |
| **Admin UI** | http://127.0.0.1:5173/admin | `{BASE_URL}/admin` |

Spotify rejects `http://localhost`. Always use **`127.0.0.1`** in dev.

---

## Development setup

### 1. Spotify dev app

Create a **development** app in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard):

- Redirect URI: `http://127.0.0.1:3000/api/v1/host/spotify/callback`
- Development mode, allowlist your account

### 2. Env file

```bash
bun run setup:dev
# Or: cp .env.development.example .env.development
# Fill in SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET from the dev app
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

Use **`127.0.0.1`**, not `localhost`, in the browser.

No Cloudflare tunnel needed for local dev.

---

## Production setup (Docker)

Docker runs the built app on port **3000** by default. Put your own reverse proxy (nginx, Caddy, Traefik) in front, or use the optional Cloudflare Tunnel overlay.

### 1. Spotify app

Create a **production** app in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard):

- Redirect URI: `https://your-public-hostname/api/v1/host/spotify/callback`
- Must match `BASE_URL` and `SPOTIFY_REDIRECT_URI` in `.env.production`
- Use prod client ID/secret (not the dev app credentials)

### 2. Env file

```bash
bun run setup:prod
# Or: cp .env.production.example .env.production
```

**`.env.production`** (required):

```env
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
SPOTIFY_REDIRECT_URI=https://jukebox.example.com/api/v1/host/spotify/callback
SPOTIFY_MARKET=US
BASE_URL=https://jukebox.example.com
ENCRYPTION_KEY=...      # openssl rand -hex 32  (≥ 32 characters)
HOST_SETUP_TOKEN=...    # openssl rand -hex 16
```

Set `BASE_URL` and `SPOTIFY_REDIRECT_URI` to however guests reach the app — your proxy hostname, LAN IP, or Cloudflare tunnel URL. Prefer **https://**; for http:// LAN-only setups set `ALLOW_INSECURE_HTTP=1`.

### 3. Deploy

**Self-hosted** (port exposed — use your own proxy or LAN):

```bash
bun run docker:up
# Or: docker compose up --build -d
```

Jukebox listens on **`http://localhost:3000`** (override host port with `JUKEBOX_PORT=8080 bun run docker:up`).

**Private registry** (optional — for build/push or pulling on a server):

```bash
cp .env.docker.example .env.docker
# Set JUKEBOX_IMAGE=your-registry/jukebox:latest
# Optional: JUKEBOX_PLATFORM=linux/arm64 (default linux/amd64)

docker login your-registry:5555

# Single platform: build locally, then push
bun run docker:build:registry
bun run docker:push

# Or multi-arch build + push in one step (requires buildx)
bun run docker:publish

# Run the published image
bun run docker:up:registry
```

**Important:** `docker-compose.publish-multi.yml` is multi-arch and must use `build --push` — a plain `build` will fail because Docker cannot load multi-platform images locally. Use `docker-compose.publish.yml` for single-platform `build`.

**With Cloudflare Tunnel** (optional overlay — tunnel only, no host port):

```bash
cp .env.cloudflared.example .env.cloudflared
# Add TUNNEL_TOKEN from Cloudflare Zero Trust → Tunnels

bun run docker:up:cloudflare
# Or: docker compose --env-file .env.docker -f docker-compose.yml -f docker-compose.cloudflare.yml up -d
```

Configure the tunnel public hostname → `http://jukebox:3000` (Docker service name).

### 4. Connect Spotify (first time)

1. Open `{BASE_URL}/admin`
2. Enter your `HOST_SETUP_TOKEN` in **Host setup token**
3. Click **Connect Spotify**

### 5. Logs

```bash
docker compose logs -f jukebox
# With Cloudflare overlay:
docker compose -f docker-compose.yml -f docker-compose.cloudflare.yml logs -f
```

---

## How env loading works

| Command | Env files loaded |
|---|---|
| `bun run dev` | `.env.development`, then `.env.local` |
| `bun run start` | `.env.production`, then `.env.local` |
| `bun run docker:up` | `jukebox` container ← `.env.production`; local image `jukebox:local` |
| `bun run docker:up:registry` | compose ← `.env.docker`; container ← `.env.production` |
| `bun run docker:up:cloudflare` | above + `cloudflared` ← `.env.cloudflared` |

All secret env files are gitignored. Templates: `.env.development.example`, `.env.production.example`, `.env.cloudflared.example`, `.env.docker.example`. Overview: `.env.example`.

### Variable reference

| Variable | Dev | Prod | Notes |
|---|---|---|---|
| `SPOTIFY_CLIENT_ID` | required | required | Separate Spotify app per environment |
| `SPOTIFY_CLIENT_SECRET` | required | required | |
| `SPOTIFY_REDIRECT_URI` | required | required | Must match `BASE_URL` hostname |
| `BASE_URL` | optional | required | Dev default `http://127.0.0.1:5173` |
| `ALLOW_INSECURE_HTTP` | — | optional | Set `1` for http:// production URLs (LAN) |
| `ENCRYPTION_KEY` | required | required | Prod: ≥ 32 chars (`openssl rand -hex 32`) |
| `HOST_SETUP_TOKEN` | optional | required | Prod: enter in Admin before Connect Spotify |
| `SPOTIFY_MARKET` | optional | optional | Default `US` |
| `TUNNEL_TOKEN` | — | `.env.cloudflared` only | Only with `docker-compose.cloudflare.yml` |
| `JUKEBOX_IMAGE` | — | `.env.docker` only | Compose interpolation; default `jukebox:local` |
| `JUKEBOX_PORT` | — | `.env.docker` or shell | Host port for default Docker compose (default `3000`) |
| `DATABASE_PATH` | optional | optional | Defaults shown in examples |
| `PORT` | optional | optional | Default `3000` |

Config validation enforces:

- **Dev:** `http://127.0.0.1` URLs only
- **Prod:** `BASE_URL` and `SPOTIFY_REDIRECT_URI` must share the same hostname; **https://** unless `ALLOW_INSECURE_HTTP=1`
- **Prod:** `ENCRYPTION_KEY` length ≥ 32, `HOST_SETUP_TOKEN` must be set

---

## Tests

```bash
bun test
```

See [docs/SPEC.md](docs/SPEC.md) for the full specification.

## Security

See [docs/SECURITY.md](docs/SECURITY.md) for the pre-GitHub checklist, secret handling, and production hardening notes.
