export function parseSpotifyError(message: string): {
  status: number | null;
  spotifyMessage: string | null;
} {
  const match = message.match(/^SPOTIFY_(\d+):(.*)$/s);
  if (!match) return { status: null, spotifyMessage: null };
  try {
    const body = JSON.parse(match[2]) as {
      error?: { status?: number; message?: string };
    };
    return {
      status: Number(match[1]),
      spotifyMessage: body.error?.message ?? null,
    };
  } catch {
    return { status: Number(match[1]), spotifyMessage: null };
  }
}

export function isRestrictedDeviceError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const { status, spotifyMessage } = parseSpotifyError(message);
  return status === 403 && spotifyMessage === "Restricted device";
}

export function isNoActiveDeviceError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("SPOTIFY_404") ||
    message.includes("SPOTIFY_204") ||
    message.includes("NO_ACTIVE_DEVICE")
  );
}
