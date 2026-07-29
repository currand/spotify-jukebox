# Security

Jukebox is designed for a **private party** exposed briefly via Cloudflare Tunnel — not a public multi-tenant service. These notes help you push to GitHub safely and run production with reasonable protection.

## Before pushing to GitHub

Run this checklist locally:

```bash
git status
git check-ignore -v .env.production .env.development .env.cloudflared .env.tailscale data/
git log --all --oneline -- '.env.production' '.env.development' '.env.cloudflared' '.env.tailscale'
```

**Safe to commit:** source code, `.env*.example`, docs, Dockerfile, `docker-compose.yml`.

**Never commit:**

| File / path | Contains |
|---|---|
| `.env.production` | Spotify client secret, encryption key, host setup token |
| `.env.development` | Dev Spotify credentials |
| `.env.cloudflared` | Cloudflare tunnel token |
| `.env.tailscale` | Tailscale auth key |
| `.env.local` | Optional overrides |
| `data/` | SQLite DB with encrypted Spotify refresh tokens |
| `.cursor/*.log` | Local agent debug traces — can contain real party/queue data from your own testing |

If any secret file was ever committed, **rotate all credentials** before making the repo public. If any file with real personal data (hostnames, playlists, etc.) was committed, remove it from the working tree and history (`git filter-repo` or BFG) before making the repo public — deleting the file in a new commit is not enough, since it stays in git history.

## Secret handling

- Spotify tokens are **encrypted at rest** (AES-256-GCM) in SQLite using `ENCRYPTION_KEY`.
- The client bundle has **no secrets** — it calls `/api/v1` with relative paths.
- Docker builds use `.dockerignore` so local env files are not copied into image layers.
- Split env files in production:
  - `.env.production` → jukebox container (all profiles)
  - `.env.cloudflared` → `cloudflare` profile only
  - `.env.tailscale` → `tailscale` profile only
- `local` profile publishes a host port; `cloudflare` and `tailscale` profiles do not

Generate strong values:

```bash
openssl rand -hex 32   # ENCRYPTION_KEY (required in production, ≥ 32 characters)
openssl rand -hex 16   # HOST_SETUP_TOKEN (optional — set a real value or remove the line)
```

## HOST_SETUP_TOKEN

Optional gate on **host Spotify OAuth** so visitors who find your URL cannot connect their Spotify account and take over admin.

**Rule:** if `HOST_SETUP_TOKEN` is **unset or empty**, the token is off. If it is **set**, Connect Spotify requires the same value in admin (query param `?token=…` or `X-Host-Setup-Token` header on `/host/spotify/login`).

The example `.env.production` ships with a placeholder value. For localhost-only use, **delete the line**. For exposed deployments, replace it with `openssl rand -hex 16`.

When enabled:

1. Set in `.env.production`: `HOST_SETUP_TOKEN=<secret>`
2. Restart the container
3. Open `/admin` → paste the same value in **Host setup token**
4. Click **Connect Spotify**

Guests never need this token.

### Spotify OAuth scopes

Jukebox requests: `user-modify-playback-state`, `user-read-playback-state`, `playlist-read-private`, `playlist-modify-private`.

The host account may contain **private ephemeral playlists** named after parties — Jukebox creates them on Turn ON and removes them when you end (or replace) the party. Re-connect Spotify after upgrading from older builds that lacked `playlist-modify-private`.

If the token leaks, generate a new one, update `.env.production`, restart, and use the new value in admin.

## Production protections (built in)

| Control | What it does |
|---|---|
| `HOST_SETUP_TOKEN` | When set in env, required for Connect Spotify. Remove the line to disable. |
| Host session cookie | `httpOnly`, `secure`, `SameSite=Lax`. Admin API requires valid session. |
| Guest session cookie | Same cookie flags; per-party cookie name. |
| CORS | Production API only accepts credentialed requests from `BASE_URL`. |
| Security headers | CSP, frame denial, nosniff via Hono `secureHeaders`. |
| Probe guard | Blocks common scanner paths; rate-limits host/admin API probing (not guest party traffic). |
| Guest action limits | Per-guest add/upvote/downvote quotas (party-configurable). |
| OAuth state TTL | 10-minute expiry on Spotify OAuth state tokens. |
| SQL | Parameterized queries throughout. |

## Container hardening

Defense-in-depth against a container-escape bug (e.g. a runc/kernel CVE) reaching the host:

| Control | Where |
|---|---|
| Non-root runtime user (`bun`, uid 1000) | [Dockerfile](../Dockerfile) — no `USER` was set previously, so the app ran as root |
| No `node_modules`/`package.json` in the final image | [Dockerfile](../Dockerfile) — `bun build --target bun` inlines every dependency into `dist/server/index.js`; nothing from `node_modules` is needed at runtime, so the whole npm dependency tree (and its CVEs) is absent from the image |
| `cap_drop: [ALL]` | `jukebox`/`jukebox-internal`/`jukebox-tailscale` and `cloudflared` in every compose file — none of these need any Linux capability (no privileged ports, no raw sockets) |
| `security_opt: [no-new-privileges:true]` | Every service, including `tailscale` — blocks privilege escalation via setuid binaries even where capabilities are granted |
| `read_only: true` + `tmpfs: [/tmp]` | `jukebox*` and `cloudflared` — the app only writes to the `/data` volume; rootfs is otherwise immutable |
| `cap_drop: [ALL]` + explicit `cap_add: [NET_ADMIN, SYS_MODULE]` | `tailscale` sidecar — required to configure the `tun` interface and give `jukebox-tailscale` (`network_mode: service:tailscale`) a routable Tailscale IP. These two capabilities are kept (not dropped) because Tailscale needs real kernel-level network configuration to work as a sidecar; there's no way to serve the admin/guest UI directly on the tailnet without it. This is the most privileged container in the stack — treat the Tailscale auth key accordingly. |

**Upgrade note — existing deployments:** volumes created before this hardening shipped have `/data` contents owned by `root` (the old default user). After upgrading, run this once per profile so the new non-root `bun` user can read/write the existing database:

```bash
docker compose --profile local run --rm --user root --cap-add CHOWN --cap-add FOWNER jukebox chown -R bun:bun /data
```

(swap `jukebox` for `jukebox-internal` or `jukebox-tailscale` if you use the `cloudflare`/`tailscale` profile). The extra `--cap-add` flags are required because the service's `cap_drop: [ALL]` also applies to this one-off `run` — even as root, `chown` needs `CAP_CHOWN`/`CAP_FOWNER` explicitly.

## Recommended Cloudflare setup

When the tunnel is **up**:

1. **Turn the tunnel off** when not hosting a party (your plan) — best defense.
2. Optional **Cloudflare Access** on `/admin` and `/api/v1/host/*` for an extra login layer.
3. Optional **rate limiting rules** on `/api/v1/host/*` at the edge (guest party APIs intentionally have no IP cap — party Wi‑Fi shares one address).
4. Use a **non-guessable hostname** (tunnel subdomain is fine; avoid advertising the URL).

## Known trade-offs

- **Guest sessions in production** no longer return `sessionToken` in JSON (cookie-only). Safari/in-app browser users should use “Open in Safari” so the httpOnly cookie persists.
- **Host OAuth** is protected by `HOST_SETUP_TOKEN` when that env var is set. Remove it to disable the gate (e.g. localhost-only or when Cloudflare Access / tailnet ACLs cover admin).
- **No IP limits on guest party APIs** — 50+ guests on the same Wi‑Fi share one public IP; per-guest action quotas still apply.
- **IP rate limits** on probe guard are in-memory per container; they reset on restart.

## If the tunnel URL leaks during a party

1. Pause or end the party from admin.
2. Stop the tunnel (`docker compose stop cloudflared` or disable in Cloudflare).
3. Rotate `HOST_SETUP_TOKEN` and restart (if you use one).
4. If you suspect host takeover, rotate Spotify app secret and `ENCRYPTION_KEY` (requires re-auth and clears encrypted tokens).

## Reporting

This is a personal/self-hosted project. If you find a security issue in your deployment, rotate affected secrets and review Cloudflare access logs.
