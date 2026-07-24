# Security

Jukebox is designed for a **private party** exposed briefly via Cloudflare Tunnel — not a public multi-tenant service. These notes help you push to GitHub safely and run production with reasonable protection.

## Before pushing to GitHub

Run this checklist locally:

```bash
git status
git check-ignore -v .env.production .env.development .env.cloudflared data/
git log --all --oneline -- '.env.production' '.env.development' '.env.cloudflared'
```

**Safe to commit:** source code, `.env*.example`, docs, Dockerfile, `docker-compose.yml`.

**Never commit:**

| File / path | Contains |
|---|---|
| `.env.production` | Spotify client secret, encryption key, host setup token |
| `.env.development` | Dev Spotify credentials |
| `.env.cloudflared` | Cloudflare tunnel token |
| `.env.local` | Optional overrides |
| `data/` | SQLite DB with encrypted Spotify refresh tokens |

If any secret file was ever committed, **rotate all credentials** before making the repo public.

## Secret handling

- Spotify tokens are **encrypted at rest** (AES-256-GCM) in SQLite using `ENCRYPTION_KEY`.
- The client bundle has **no secrets** — it calls `/api/v1` with relative paths.
- Docker builds use `.dockerignore` so local env files are not copied into image layers.
- Split env files in production:
  - `.env.production` → `jukebox` container
  - `.env.cloudflared` → optional cloudflared overlay only
- Default Docker exposes port 3000; Cloudflare overlay removes the host port

Generate strong values:

```bash
openssl rand -hex 32   # ENCRYPTION_KEY (required in production, ≥ 32 characters)
openssl rand -hex 16   # HOST_SETUP_TOKEN (required in production)
```

## HOST_SETUP_TOKEN

Gates **host Spotify OAuth** in production so visitors who find your tunnel URL cannot connect their Spotify account and take over admin.

1. Add to `.env.production`: `HOST_SETUP_TOKEN=<value from openssl rand -hex 16>`
2. Restart: `docker compose up -d`
3. Open `/admin` → paste the same value in **Host setup token**
4. Click **Connect Spotify**

Guests never need this token. Optional in development (`bun run dev`).

If the token leaks, generate a new one, update `.env.production`, restart, and use the new value in admin.

## Production protections (built in)

| Control | What it does |
|---|---|
| `HOST_SETUP_TOKEN` | Required in production. Spotify OAuth login URL must include `?token=…` or `X-Host-Setup-Token` header. |
| Host session cookie | `httpOnly`, `secure`, `SameSite=Lax`. Admin API requires valid session. |
| Guest session cookie | Same cookie flags; per-party cookie name. |
| CORS | Production API only accepts credentialed requests from `BASE_URL`. |
| Security headers | CSP, frame denial, nosniff via Hono `secureHeaders`. |
| Probe guard | Blocks common scanner paths; rate-limits host/admin API probing (not guest party traffic). |
| Guest action limits | Per-guest add/upvote/veto quotas (party-configurable). |
| OAuth state TTL | 10-minute expiry on Spotify OAuth state tokens. |
| SQL | Parameterized queries throughout. |

## Recommended Cloudflare setup

When the tunnel is **up**:

1. **Turn the tunnel off** when not hosting a party (your plan) — best defense.
2. Optional **Cloudflare Access** on `/admin` and `/api/v1/host/*` for an extra login layer.
3. Optional **rate limiting rules** on `/api/v1/host/*` at the edge (guest party APIs intentionally have no IP cap — party Wi‑Fi shares one address).
4. Use a **non-guessable hostname** (tunnel subdomain is fine; avoid advertising the URL).

## Known trade-offs

- **Guest sessions in production** no longer return `sessionToken` in JSON (cookie-only). Safari/in-app browser users should use “Open in Safari” so the httpOnly cookie persists.
- **Host OAuth** is protected by `HOST_SETUP_TOKEN`, not a full user account system — sufficient for a single-host home deployment.
- **No IP limits on guest party APIs** — 50+ guests on the same Wi‑Fi share one public IP; per-guest action quotas still apply.
- **IP rate limits** on probe guard are in-memory per container; they reset on restart.

## If the tunnel URL leaks during a party

1. Pause or end the party from admin.
2. Stop the tunnel (`docker compose stop cloudflared` or disable in Cloudflare).
3. Rotate `HOST_SETUP_TOKEN` and restart.
4. If you suspect host takeover, rotate Spotify app secret and `ENCRYPTION_KEY` (requires re-auth and clears encrypted tokens).

## Reporting

This is a personal/self-hosted project. If you find a security issue in your deployment, rotate affected secrets and review Cloudflare access logs.
