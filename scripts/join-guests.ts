#!/usr/bin/env bun
/**
 * Join guests to a party and save their session tokens.
 * Optional pre-step before endurance — endurance.ts can join guests itself.
 */
import { writeFileSync, mkdirSync } from "fs";
import { resolveJukeboxBaseUrl } from "./lib/endurance-base-url.ts";
import { guestDisplayName, randomDelay } from "./lib/endurance-api.ts";

const args = process.argv.slice(2);
const slugIdx = args.indexOf("--slug");
const countIdx = args.indexOf("--count");
const baseUrlIdx = args.indexOf("--base-url");
const joinWindowIdx = args.indexOf("--join-window-min");

const slug = slugIdx !== -1 ? args[slugIdx + 1] : undefined;
const count = Math.min(50, Math.max(1, Number(countIdx !== -1 ? args[countIdx + 1] : 30)));
const joinWindowMin = Math.max(1, Number(joinWindowIdx !== -1 ? args[joinWindowIdx + 1] : 60));

if (!slug) {
  console.error(
    "Usage: bun run scripts/join-guests.ts --slug <slug> [--count 30] [--join-window-min 60] [--base-url http://127.0.0.1:3000]",
  );
  process.exit(1);
}

const BASE = resolveJukeboxBaseUrl(baseUrlIdx !== -1 ? args[baseUrlIdx + 1] : undefined);
const cookieName = `guest_session_${slug}`;
const joinWindowMs = joinWindowMin * 60_000;
const arrivalInterval = joinWindowMs / count;
const guests: { name: string; guestId: string; cookie: string }[] = [];

for (let i = 0; i < count; i++) {
  if (i > 0) {
    await Bun.sleep(randomDelay(arrivalInterval * 0.75, arrivalInterval * 1.25));
  }

  const name = guestDisplayName(i);
  const res = await fetch(`${BASE}/api/v1/parties/${slug}/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ displayName: name }),
  });
  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = setCookie.match(new RegExp(`${cookieName}=([^;]+)`));
  const body = await res.json();

  if (res.status === 200 && match) {
    guests.push({ name, guestId: body.id, cookie: `${cookieName}=${match[1]}` });
    console.log(`✓ ${name} → ${body.id.slice(0, 8)}`);
  } else {
    console.log(`✗ ${name} → ${res.status} ${JSON.stringify(body)}`);
  }
}

mkdirSync("./data", { recursive: true });
const outPath = `./data/guests-${slug}.json`;
writeFileSync(outPath, JSON.stringify(guests, null, 2));
console.log(`\nSaved ${guests.length} guests to ${outPath}`);
