/** Shared base URL for endurance/load scripts. */
export function resolveJukeboxBaseUrl(override?: string): string {
  const raw =
    override?.trim() ||
    process.env.JUKEBOX_BASE_URL?.trim() ||
    "https://jukebox.REDACTED.example.com";
  return raw.replace(/\/$/, "");
}
