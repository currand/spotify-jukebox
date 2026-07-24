import { existsSync } from "fs";
import { join } from "path";
import { bootstrapEnv } from "./load-env";
import { loadConfig } from "./config";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { serveStatic } from "hono/bun";
import { initDb } from "./db/schema";
import { createGuestRoutes } from "./routes/guest";
import { createHostRoutes } from "./routes/host";
import { probeGuardMiddleware } from "./middleware/probe-guard";
import { createSpotifyClient } from "./services/spotify";
import { startSyncWorker } from "./services/sync";

const env = bootstrapEnv();
const config = loadConfig(env);
const db = initDb(config);
const spotify = createSpotifyClient(db, config);

const app = new Hono();

app.use("*", probeGuardMiddleware());

app.use(
  "*",
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "https:", "data:"],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
    },
  }),
);

app.use(
  "/api/*",
  cors({
    origin: config.isProduction ? config.baseUrl : "*",
    credentials: true,
  }),
);

const api = new Hono();
api.route("/", createGuestRoutes(db, config));
api.route("/", createHostRoutes(db, config));
app.route("/api/v1", api);

app.get("/health", (c) => c.json({ ok: true }));

const clientDir = join(import.meta.dir, "../../dist/client");

if (config.env === "development") {
  // API only on :3000 — UI runs on Vite :5173 (HMR breaks through a proxy)
  app.get("*", (c) => {
    const url = new URL(c.req.url);
    if (url.pathname.startsWith("/api/") || url.pathname === "/health") {
      return c.notFound();
    }
    return c.redirect(`${config.baseUrl}${url.pathname}${url.search}`);
  });
} else if (existsSync(clientDir)) {
  app.use(
    "*",
    serveStatic({
      root: clientDir,
      rewriteRequestPath: (path) =>
        path.startsWith("/assets/") ? path : "/index.html",
    }),
  );
}

startSyncWorker(db, spotify);

const bindHost = config.isProduction ? "0.0.0.0" : "127.0.0.1";
console.log(`Jukebox [${config.env}] listening on http://${bindHost}:${config.port}`);
export default {
  port: config.port,
  hostname: bindHost,
  fetch: app.fetch,
};
