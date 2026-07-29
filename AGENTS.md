# Agent guide

Brief orientation for AI agents and contributors working in this repo. End-user deployment docs: [README.md](README.md). Full dev workflow: [CONTRIBUTING.md](CONTRIBUTING.md).

## Stack

| Layer | Tool |
|---|---|
| Runtime | [Bun](https://bun.sh) — install deps, run server, run tests |
| API | [Hono](https://hono.dev) on Bun |
| DB | SQLite via `bun:sqlite` (file in prod, in-memory in tests) |
| UI | React 19 + Vite (dev proxy on **5173**, API on **3000**) |
| Deploy | Docker Compose (users); `bun run dev` (local dev) |

## Project layout

```
src/
  server/           API entry (index.ts), config, routes, services, db, middleware
  client/           React SPA (pages/, components/, hooks/, utils/)
  shared/           Types and logic shared by server + client (@/shared/*)
tests/unit/         Bun test suite (unit + in-memory SQLite integration)
services/spotify-mock/   Optional fake Spotify API for mock Docker profile
scripts/            Endurance/load scripts (not unit tests)
docs/               SPEC, SECURITY, etc.
```

**Import alias:** `@/` → `src/` (see `tsconfig.json`).

**Route modules:** `src/server/routes/guest.ts` (party/guest API), `src/server/routes/host.ts` (admin/host API). Business logic lives in `src/server/services/`, not in route handlers.

**Shared contracts:** `src/shared/types.ts` for API shapes and defaults; keep server responses aligned with these types.

## Commands

```bash
bun install              # once
bun run dev              # API :3000 + Vite UI :5173 (needs .env.development)
bun run build            # dist/client + dist/server
bun run typecheck        # TypeScript — required before finishing work
bun test                 # full unit/integration test suite — required before finishing
```

`bun run lint` is an alias for `bun run typecheck`. There is **no ESLint or Prettier** — match surrounding style (2-space indent, existing naming).

## Testing

- **Runner:** Bun built-in test (`import { describe, expect, test } from "bun:test"`).
- **Location:** `tests/unit/*.test.ts` only.
- **No live Spotify or Docker** needed for `bun test` — tests use in-memory SQLite and mocked Spotify clients.
- **Integration-style tests:** `tests/unit/api-integration.test.ts` exercises HTTP routes against an in-memory app instance.
- Prefer testing real behavior (queue order, rate limits, dedup) over trivial assertions.
- Do not add tests unless they add meaningful coverage or the task explicitly requests them.

## Before you start (must-read)

1. **Virtual queue model** — Spotify’s API cannot reorder or remove queued tracks. Jukebox keeps a virtual queue and syncs one buffer slot to Spotify. Read `docs/SPEC.md` § Spotify sync / virtual queue before changing queue or sync code.

2. **Spotify Web API** — Dev redirect URIs use `http://127.0.0.1`, never `localhost`. See `docs/SPEC.md` for auth, endpoints, 429/backoff, and redirect URIs.

3. **Secrets** — Never commit `.env.production`, `.env.development`, `.env.cloudflared`, `.env.tailscale`, or `data/`. Use `*.example` templates only.

4. **Shared types first** — API or UI shape changes start in `src/shared/types.ts` (and often `src/shared/` helpers), then server routes/services, then client.

5. **Verify** — Run `bun run typecheck` and `bun test` after substantive changes. Both must pass.

6. **Scope** — Minimize diffs; do not refactor unrelated code. Match existing patterns in the file you edit.

## Key docs

| Doc | Use when |
|---|---|
| [docs/SPEC.md](docs/SPEC.md) | Behavior, queue rules, rate limits, API surface |
| [docs/SECURITY.md](docs/SECURITY.md) | Auth, tokens, production constraints |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Local setup, mock stack, endurance tests |
| [README.md](README.md) | User-facing Docker deployment (not for dev setup) |
