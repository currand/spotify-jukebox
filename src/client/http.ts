import {
  getStoredGuestSession,
  partySlugFromPath,
  setStoredGuestSession,
} from "./utils/guest-session";

const API = "/api/v1";

function guestSessionHeaders(): Record<string, string> {
  const slug = partySlugFromPath();
  if (!slug) return {};
  const token = getStoredGuestSession(slug);
  return token ? { "X-Guest-Session": token } : {};
}

export async function api<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...guestSessionHeaders(),
      ...(init?.headers ?? {}),
    },
    ...init,
  });
  if (res.status === 304) return undefined as T;
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as {
      error?: string;
      code?: string;
    };
    throw new Error(err.error ?? res.statusText);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/** Like api(), but returns null on 401 instead of throwing. */
export async function apiOptional<T>(path: string): Promise<T | null> {
  const res = await fetch(`${API}${path}`, {
    credentials: "include",
    headers: guestSessionHeaders(),
  });
  if (res.status === 401) return null;
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

export function guestFetchHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  return { ...guestSessionHeaders(), ...extra };
}

export function joinParty(slug: string, displayName?: string) {
  const sessionToken = getStoredGuestSession(slug) ?? undefined;
  return api<{
    id: string;
    displayName: string | null;
    sessionToken?: string;
  }>(`/parties/${slug}/join`, {
    method: "POST",
    body: JSON.stringify({ displayName, sessionToken }),
  }).then((result) => {
    if (result.sessionToken) {
      setStoredGuestSession(slug, result.sessionToken);
    }
    return result;
  });
}
