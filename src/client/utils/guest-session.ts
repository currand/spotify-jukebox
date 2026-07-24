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

export function clearStoredGuestSession(slug: string): void {
  try {
    localStorage.removeItem(storageKey(slug));
  } catch {
    /* ignore */
  }
}

/** iOS Camera / in-app browsers discard cookies when closed — nudge toward Safari. */
export function shouldShowSafariHint(): boolean {
  if (typeof window === "undefined") return false;
  const ua = navigator.userAgent;
  if (!/iPhone|iPad|iPod/.test(ua)) return false;
  if (/CriOS|FxiOS|EdgiOS/.test(ua)) return false;
  try {
    if (sessionStorage.getItem("jukebox_safari_hint_dismissed") === "1") {
      return false;
    }
  } catch {
    return false;
  }
  return true;
}

export function dismissSafariHint(): void {
  try {
    sessionStorage.setItem("jukebox_safari_hint_dismissed", "1");
  } catch {
    /* ignore */
  }
}

export function partySlugFromPath(): string | null {
  const match = window.location.pathname.match(/\/p\/([^/]+)/);
  return match?.[1]?.replace(/\/$/, "") ?? null;
}
