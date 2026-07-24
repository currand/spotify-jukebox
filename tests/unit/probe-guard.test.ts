import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { probeGuardMiddleware } from "../../src/server/middleware/probe-guard";

describe("probeGuardMiddleware", () => {
  const app = new Hono();
  app.use("*", probeGuardMiddleware());
  app.get("/api/v1/parties/test/join", (c) => c.json({ ok: true }));
  app.get("/api/v1/host/spotify/status", (c) => c.json({ ok: true }));
  app.get("/api/v1/host/spotify/login", (c) => c.text("login"));

  test("allows guest party routes without IP throttling", async () => {
    for (let i = 0; i < 50; i++) {
      const res = await app.request("/api/v1/parties/test/join");
      expect(res.status).toBe(200);
    }
  });

  test("blocks common scanner paths", async () => {
    const res = await app.request("/.env");
    expect(res.status).toBe(404);
  });

  test("allows host status polling", async () => {
    const res = await app.request("/api/v1/host/spotify/status");
    expect(res.status).toBe(200);
  });
});
