# Jukebox

Self-hosted party queue control for Spotify Premium.

## Environments

Jukebox uses **separate env files** with **separate Spotify apps** for dev and prod:

| | Development | Production |
|---|---|---|
| **Env files** | `.env.development` | `.env.production` + `.env.cloudflared` |
| **Spotify app** | Dev app (127.0.0.1 redirect) | Prod app (HTTPS redirect) |
| **Cloudflare** | Not used | Required |
| **Run** | `bun run dev` | `docker compose up -d` |
| **Admin UI** | http://127.0.0.1:5173/admin | https://jukebox.yourdomain.com/admin |
| **API (dev only)** | http://127.0.0.1:3000/api/v1 | (same as UI in prod) |

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

## Production setup

### 1. Cloudflare Tunnel

1. [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) → **Networks** → **Tunnels** → create tunnel
2. Public hostname → `http://jukebox:3000` (Docker service name; jukebox is not published to the host)
3. Note your URL, e.g. `https://jukebox.yourdomain.com`
4. Copy the tunnel token

### 2. Spotify prod app

Create a **separate production** app in the Spotify Dashboard:

- Redirect URI: `https://jukebox.yourdomain.com/api/v1/host/spotify/callback`
- Use prod client ID/secret in `.env.production` (not the dev app credentials)

### 3. Env files

```bash
bun run setup:prod
# Or:
#   cp .env.production.example .env.production
#   cp .env.cloudflared.example .env.cloudflared
```

**`.env.production`** (jukebox app):

```env
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
SPOTIFY_REDIRECT_URI=https://jukebox.yourdomain.com/api/v1/host/spotify/callback
SPOTIFY_MARKET=US
BASE_URL=https://jukebox.yourdomain.com
ENCRYPTION_KEY=...      # openssl rand -hex 32  (≥ 32 characters)
HOST_SETUP_TOKEN=...    # openssl rand -hex 16
```

**`.env.cloudflared`** (tunnel only — do not put this in `.env.production`):

```env
TUNNEL_TOKEN=...        # from Cloudflare Zero Trust → Tunnels
```

### 4. Connect Spotify (first time)

1. Deploy (step 5), then open `https://jukebox.yourdomain.com/admin`
2. Enter your `HOST_SETUP_TOKEN` in **Host setup token**
3. Click **Connect Spotify**

The setup token gates host OAuth so random visitors cannot take over admin. Guests never need it.

### 5. Deploy

```bash
docker compose up --build -d
```

Open https://jukebox.yourdomain.com/admin

```bash
docker compose logs -f jukebox
docker compose logs -f cloudflared
```

---

## How env loading works

| Command | Env files loaded |
|---|---|
| `bun run dev` | `.env.development`, then `.env.local` |
| `bun run start` | `.env.production`, then `.env.local` |
| `docker compose up` | `jukebox` → `.env.production`; `cloudflared` → `.env.cloudflared` |

All secret env files are gitignored. Templates: `.env.development.example`, `.env.production.example`, `.env.cloudflared.example`. Overview: `.env.example`.

### Variable reference

| Variable | Dev | Prod | Notes |
|---|---|---|---|
| `SPOTIFY_CLIENT_ID` | required | required | Separate Spotify app per environment |
| `SPOTIFY_CLIENT_SECRET` | required | required | |
| `SPOTIFY_REDIRECT_URI` | required | required | Must use `127.0.0.1` (dev) or `https://` (prod) |
| `BASE_URL` | optional | required | Dev default `http://127.0.0.1:5173` |
| `ENCRYPTION_KEY` | required | required | Prod: ≥ 32 chars (`openssl rand -hex 32`) |
| `HOST_SETUP_TOKEN` | optional | required | Prod: enter in Admin before Connect Spotify |
| `SPOTIFY_MARKET` | optional | optional | Default `US` |
| `TUNNEL_TOKEN` | — | `.env.cloudflared` only | Never in `.env.production` |
| `DATABASE_PATH` | optional | optional | Defaults shown in examples |
| `PORT` | optional | optional | Default `3000` |

Config validation enforces:

- **Dev:** `http://127.0.0.1` URLs only
- **Prod:** `https://` URLs, same hostname for `BASE_URL` and `SPOTIFY_REDIRECT_URI`
- **Prod:** `ENCRYPTION_KEY` length ≥ 32, `HOST_SETUP_TOKEN` must be set

---

## Tests

```bash
bun test
```

See [docs/SPEC.md](docs/SPEC.md) for the full specification.

## Security

See [docs/SECURITY.md](docs/SECURITY.md) for the pre-GitHub checklist, secret handling, and production hardening notes.
