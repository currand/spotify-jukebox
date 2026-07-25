/** Comma-separated namespaces, or `1` / `true` / `*` for all. Example: DEBUG=spotify,sync */
export function isDebugEnabled(namespace: string): boolean {
  const raw = process.env.DEBUG?.trim();
  if (!raw) return false;
  if (raw === "1" || raw === "true" || raw === "*") return true;
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .includes(namespace);
}

export function debugLog(namespace: string, ...args: unknown[]): void {
  if (!isDebugEnabled(namespace)) return;
  console.log(`[${namespace}]`, ...args);
}
