const storageKey = (slug: string) => `jukebox_guest_session_${slug}`;

export function getStoredGuestSession(slug: string): string | null {
  try {
    return localStorage.getItem(storageKey(slug));
  } catch {
    return null;
  }
}

export function setStoredGuestSession(slug: string, token: string): void {
  try {
    localStorage.setItem(storageKey(slug), token);
  } catch {
    /* private mode / blocked storage */
  }
}

export function partySlugFromPath(): string | null {
  const match = window.location.pathname.match(/\/p\/([^/]+)/);
  return match?.[1]?.replace(/\/$/, "") ?? null;
}
