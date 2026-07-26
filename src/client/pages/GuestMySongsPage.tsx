import * as React from "react";
import { Link, useParams } from "react-router-dom";
import type { GuestMySongsResponse, PartyView } from "@/shared/types";
import { GuestNav } from "../components/GuestNav";
import { GuestNamePrompt } from "../components/GuestNamePrompt";
import { BoostBadge, formatApiError, TrackTitle, UpvoteCount, DownvoteCount } from "../components/QueueUi";
import { usePopup } from "../hooks/usePopup";
import { boostApiMessage } from "../utils/queue-action-messages";
import { api, joinParty } from "../http";

function statusLabel(status: string): string {
  switch (status) {
    case "played":
      return "Played";
    case "skipped":
      return "Removed";
    case "vetoed":
      return "Downvoted";
    default:
      return status;
  }
}

export function GuestMySongsPage() {
  const { slug = "" } = useParams<{ slug: string }>();
  const [joined, setJoined] = React.useState(false);
  const [me, setMe] = React.useState<{ displayName: string | null } | null>(
    null,
  );
  const [party, setParty] = React.useState<PartyView | null>(null);
  const [songs, setSongs] = React.useState<GuestMySongsResponse | null>(null);
  const [joinError, setJoinError] = React.useState<string | null>(null);
  const { showPopup, PopupHost } = usePopup();

  const load = React.useCallback(async () => {
    if (!slug) return;
    try {
      const data = await api<GuestMySongsResponse>(`/parties/${slug}/me/songs`);
      setSongs(data);
      const partyInfo = await api<PartyView>(`/parties/${slug}`);
      setParty(partyInfo);
    } catch (e) {
      showPopup(formatApiError(e), "error");
    }
  }, [slug, showPopup]);

  React.useEffect(() => {
    void (async () => {
      try {
        await joinParty(slug);
        setJoined(true);
        const profile = await api<{ displayName: string | null }>(
          `/parties/${slug}/me`,
        );
        setMe(profile);
        await load();
      } catch {
        setJoinError("Could not join party");
      }
    })();
  }, [slug, load]);

  React.useEffect(() => {
    if (!joined) return;
    const pollIntervalMs =
      party != null && party.status !== "on" ? 15_000 : 5_000;
    const id = setInterval(() => void load(), pollIntervalMs);
    return () => clearInterval(id);
  }, [joined, load, party?.status]);

  async function boost(itemId: string) {
    try {
      await api(`/parties/${slug}/queue/${itemId}/boost`, {
        method: "POST",
        body: "{}",
      });
      showPopup("Song boosted", "success");
      await load();
    } catch (e) {
      const message = boostApiMessage(e);
      showPopup(message ?? formatApiError(e), message ? "info" : "error");
    }
  }

  async function unboost(itemId: string) {
    try {
      await api(`/parties/${slug}/me/songs/${itemId}/unboost`, {
        method: "POST",
        body: "{}",
      });
      showPopup("Boost removed", "success");
      await load();
    } catch (e) {
      showPopup(formatApiError(e), "error");
    }
  }

  async function removeSong(itemId: string, trackName: string) {
    if (!confirm(`Remove “${trackName}” from the queue?`)) return;
    try {
      await api(`/parties/${slug}/me/songs/${itemId}`, { method: "DELETE" });
      showPopup(`Removed “${trackName}”`, "success");
      await load();
    } catch (e) {
      showPopup(formatApiError(e), "error");
    }
  }

  const partyOff = party?.status !== "on";
  const canMutate = Boolean(songs && !partyOff);
  const removedHistory =
    songs?.history.filter((song) => song.status === "skipped") ?? [];
  const playedHistory =
    songs?.history.filter((song) => song.status === "played") ?? [];
  const vetoedHistory =
    songs?.history.filter((song) => song.status === "vetoed") ?? [];

  function renderHistorySection(
    title: string,
    items: NonNullable<typeof songs>["history"],
  ) {
    if (items.length === 0) return null;
    return (
      <section className="guest-my-songs-history">
        <h3>{title}</h3>
        {items.map((song) => (
          <div
            key={song.id}
            className="track card guest-my-song guest-my-song--history"
          >
            {song.albumArtUrl && <img src={song.albumArtUrl} alt="" />}
            <div className="track-meta">
              <h3 className="track-title">
                <span className="track-title-name">{song.trackName}</span>
                {song.isBoosted ? <BoostBadge /> : null}
              </h3>
              <p>
                {song.artistName}
                {title === "Played" || title === "Downvoted"
                  ? ` · ${statusLabel(song.status)}`
                  : null}
              </p>
            </div>
          </div>
        ))}
      </section>
    );
  }

  if (!joined) {
    return (
      <div className="app">
        <p>Joining party…</p>
        {joinError && <p className="error">{joinError}</p>}
      </div>
    );
  }

  if (!me?.displayName) {
    return (
      <GuestNamePrompt
        slug={slug}
        onSaved={(profile) => {
          setMe(profile);
          void load();
        }}
      />
    );
  }

  return (
    <div className="app guest-my-songs-page">
      <h1>{party?.name ?? "Jukebox"}</h1>

      <GuestNav
        slug={slug}
        activeSongCount={songs?.active.length ?? 0}
      />

      {partyOff && (
        <div className="banner off">Party is paused — view only.</div>
      )}

      <div className="card">
        <h2>My Songs</h2>
        <p className="small guest-my-songs-intro">
          Songs you added to the party queue.
          {songs?.boostUsed ? " Your boost is in use." : " You can boost one song."}
        </p>

        {songs?.active.length === 0 &&
        removedHistory.length === 0 &&
        playedHistory.length === 0 &&
        vetoedHistory.length === 0 ? (
          <p className="guest-my-songs-empty">
            You haven&apos;t added any songs yet.{" "}
            <Link to={`/p/${slug}`}>Search the queue</Link>
          </p>
        ) : null}

        {songs?.active.map((song) => (
          <div
            key={song.id}
            className={`track card guest-my-song${song.isBoosted ? " track--boosted" : ""}`}
          >
            {song.albumArtUrl && <img src={song.albumArtUrl} alt="" />}
            <div className="track-meta">
              <TrackTitle name={song.trackName} boosted={song.isBoosted} />
              <p>
                {song.artistName} · <UpvoteCount count={song.upvoteCount} /> ·{" "}
                <DownvoteCount count={song.vetoCount} />
              </p>
              {song.queuePosition && (
                <p className="guest-my-song-position">{song.queuePosition}</p>
              )}
            </div>
            <div className="actions">
              {song.canBoost && (
                <button
                  disabled={!canMutate}
                  onClick={() => void boost(song.id)}
                >
                  Boost
                </button>
              )}
              {song.canUnboost && (
                <button
                  className="secondary"
                  disabled={!canMutate}
                  onClick={() => void unboost(song.id)}
                >
                  Remove boost
                </button>
              )}
              {song.canRemove && (
                <button
                  className="secondary"
                  disabled={!canMutate}
                  onClick={() => void removeSong(song.id, song.trackName)}
                >
                  Remove
                </button>
              )}
            </div>
          </div>
        ))}

        {renderHistorySection("Removed", removedHistory)}
        {renderHistorySection("Played", playedHistory)}
        {renderHistorySection("Downvoted", vetoedHistory)}
      </div>
      <PopupHost />
    </div>
  );
}
