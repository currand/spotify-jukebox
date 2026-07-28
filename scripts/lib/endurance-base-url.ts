/** Shared base URL for endurance/load scripts. */
export function resolveJukeboxBaseUrl(override?: string): string {
  const raw =
    override?.trim() ||
    process.env.JUKEBOX_BASE_URL?.trim() ||
    "http://127.0.0.1:3000";
  return raw.replace(/\/$/, "");
}
