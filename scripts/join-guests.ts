#!/usr/bin/env bun
/**
 * Join guests to a party and save their session tokens.
 * Run this once before the endurance test.
 */
const slug = process.argv[process.argv.indexOf("--slug") + 1];
const count = parseInt(process.argv[process.argv.indexOf("--count") + 1] ?? "30");
if (!slug) { console.error("Usage: bun run scripts/join-guests.ts --slug <slug> [--count 30]"); process.exit(1); }

const NAMES = [
  "Alice","Bob","Charlie","Diana","Eve","Frank","Grace","Hank",
  "Iris","Jack","Karen","Leo","Mona","Nick","Olive","Paul",
  "Quinn","Rita","Sam","Tina","Uma","Vince","Wendy","Xander",
  "Yolanda","Zach","Amy","Ben","Clara","Dan",
].slice(0, count);

const cookieName = "guest_session_" + slug;
const BASE = "https://jukebox.currannet.net";
const guests: { name: string; guestId: string; cookie: string }[] = [];

for (const name of NAMES) {
  const res = await fetch(BASE + "/api/v1/parties/" + slug + "/join", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ displayName: name }),
  });
  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = setCookie.match(new RegExp(cookieName + "=([^;]+)"));
  const body = await res.json();
  
  if (res.status === 200 && match) {
    guests.push({ name, guestId: body.id, cookie: cookieName + "=" + match[1] });
    console.log("✓ " + name + " → " + body.id.slice(0, 8));
  } else {
    console.log("✗ " + name + " → " + res.status + " " + JSON.stringify(body));
  }
  await Bun.sleep(200);
}

const { writeFileSync } = await import("fs");
writeFileSync("./data/guests-" + slug + ".json", JSON.stringify(guests, null, 2));
console.log("\nSaved " + guests.length + " guests to ./data/guests-" + slug + ".json");
