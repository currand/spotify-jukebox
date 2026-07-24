import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

export type AppEnv = "development" | "production";

function parseEnvFile(path: string): void {
  if (!existsSync(path)) return;
  const content = readFileSync(path, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

/** Load `.env.development` or `.env.production` before reading config. */
export function bootstrapEnv(cwd = process.cwd()): AppEnv {
  const env: AppEnv =
    process.env.JUKEBOX_ENV === "production" ||
    process.env.NODE_ENV === "production"
      ? "production"
      : "development";

  parseEnvFile(resolve(cwd, `.env.${env}`));
  parseEnvFile(resolve(cwd, `.env.local`));

  process.env.NODE_ENV = env;
  process.env.JUKEBOX_ENV = env;
  return env;
}
