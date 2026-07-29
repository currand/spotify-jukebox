import type { Db } from "../db/schema";
import { getQueueItems, getUpcomingPlayOrder } from "./queue";
import type { SpotifyClient } from "./spotify";
import { formatSpotifyErrorForUser } from "./spotify-errors";

export type BootstrapResult =
  | { ok: true; playlistId: string }
  | { ok: false; message: string; code: string }
  | { skipped: true };

function partyBootstrapRow(db: Db, partyId: string) {
  return db
    .query(
      `SELECT id, name, bootstrap_playlist_id, target_spotify_device_id
       FROM parties WHERE id = ?`,
    )
    .get(partyId) as
    | {
        id: string;
        name: string;
        bootstrap_playlist_id: string | null;
        target_spotify_device_id: string | null;
      }
    | null;
}

function shouldSkipBootstrap(db: Db, partyId: string): boolean {
  const party = partyBootstrapRow(db, partyId);
  if (!party) return true;
  if (party.bootstrap_playlist_id) {
    const active = db
      .query(
        `SELECT COUNT(*) as count FROM queue_items
         WHERE party_id = ? AND status IN ('playing', 'queued')`,
      )
      .get(partyId) as { count: number };
    if (active.count > 0) return true;
  }
  return false;
}

/** Create ephemeral playlist and start playback on first Turn ON. */
export async function bootstrapSpotifyPlayback(
  db: Db,
  spotify: SpotifyClient,
  partyId: string,
): Promise<BootstrapResult> {
  const party = partyBootstrapRow(db, partyId);
  if (!party) {
    return { ok: false, message: "Party not found", code: "NOT_FOUND" };
  }
  if (shouldSkipBootstrap(db, partyId)) {
    return { skipped: true };
  }
  if (!party.target_spotify_device_id) {
    return {
      ok: false,
      message: "Select a target Spotify player before turning the party on",
      code: "DEVICE_REQUIRED",
    };
  }

  const items = getQueueItems(db, partyId);
  const hasActivePlayback = items.some(
    (item) => item.status === "playing" || item.status === "queued",
  );
  if (hasActivePlayback) {
    return { skipped: true };
  }

  const upcoming = getUpcomingPlayOrder(items);
  if (upcoming.length === 0) {
    return {
      ok: false,
      message: "Add at least one track to the queue before turning the party on",
      code: "EMPTY_QUEUE",
    };
  }

  const uris = upcoming.slice(0, 2).map((item) => item.spotify_uri);
  let createdPlaylistId: string | null = null;

  try {
    const created = await spotify.createPrivatePlaylist(party.name);
    createdPlaylistId = created.id;
    await spotify.addTracksToPlaylist(created.id, uris);
    await spotify.startPlaylistPlayback(
      created.id,
      party.target_spotify_device_id,
      0,
    );
    db.run(`UPDATE parties SET bootstrap_playlist_id = ? WHERE id = ?`, [
      created.id,
      partyId,
    ]);
    return { ok: true, playlistId: created.id };
  } catch (e) {
    if (createdPlaylistId) {
      try {
        await spotify.deletePlaylist(createdPlaylistId);
      } catch {
        /* best-effort rollback */
      }
    }
    return {
      ok: false,
      message:
        formatSpotifyErrorForUser(e) ??
        "Could not start playback on the selected device — refresh devices and try again",
      code: "BOOTSTRAP_FAILED",
    };
  }
}

/** Remove ephemeral bootstrap playlist when a party is archived. Best-effort on Spotify. */
export async function cleanupBootstrapPlaylist(
  db: Db,
  spotify: SpotifyClient,
  partyId: string,
): Promise<void> {
  const row = db
    .query(`SELECT bootstrap_playlist_id FROM parties WHERE id = ?`)
    .get(partyId) as { bootstrap_playlist_id: string | null } | null;
  const bootstrapId = row?.bootstrap_playlist_id;
  if (!bootstrapId) return;

  try {
    await spotify.deletePlaylist(bootstrapId);
  } catch (e) {
    console.error(
      `Failed to delete bootstrap playlist for party ${partyId}:`,
      e,
    );
  }
  db.run(`UPDATE parties SET bootstrap_playlist_id = NULL WHERE id = ?`, [
    partyId,
  ]);
}

/** Clean up bootstrap playlists for all active parties before archiving them. */
export async function cleanupBootstrapForActiveParties(
  db: Db,
  spotify: SpotifyClient,
): Promise<void> {
  const parties = db
    .query(`SELECT id FROM parties WHERE status IN ('on', 'off')`)
    .all() as { id: string }[];
  for (const { id } of parties) {
    await cleanupBootstrapPlaylist(db, spotify, id);
  }
}
