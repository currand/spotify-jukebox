# Jukebox

Self-hosted party queue control for Spotify Premium.

## Environments

Jukebox uses **separate env files** with **separate Spotify apps** for dev and prod:

| | Development | Production |
|---|---|---|
| **Env file** | `.env.development` | `.env.production` |
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
cp .env.development.example .env.development
# Fill in SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET from the dev app
```

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

### 3. Env file

```bash
cp .env.production.example .env.production
```

Set at minimum:

```env
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
SPOTIFY_REDIRECT_URI=https://jukebox.yourdomain.com/api/v1/host/spotify/callback
BASE_URL=https://jukebox.yourdomain.com
ENCRYPTION_KEY=...   # openssl rand -hex 32
TUNNEL_TOKEN=...
```

### 4. Deploy

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

| Command | Env file loaded |
|---|---|
| `bun run dev` | `.env.development` |
| `bun run start` | `.env.production` |
| `docker compose up` | `.env.production` (via `env_file`) |

Both files are gitignored. Examples live in `.env.development.example` and `.env.production.example`.

Optional overrides: `.env.local` (gitignored, loaded after the env file).

Config validation enforces:

- **Dev:** `http://127.0.0.1` URLs only
- **Prod:** `https://` URLs, same hostname for `BASE_URL` and `SPOTIFY_REDIRECT_URI`

---

## Tests

```bash
bun test
```

See [docs/SPEC.md](docs/SPEC.md) for the full specification.
