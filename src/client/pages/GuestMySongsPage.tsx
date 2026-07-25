import * as React from "react";
import { Link, useParams } from "react-router-dom";
import type { GuestMySongsResponse, PartyView } from "@/shared/types";
import { GuestNav } from "../components/GuestNav";
import { BoostBadge, formatApiError, TrackTitle } from "../components/QueueUi";
import { OpenInSafariHint } from "../components/OpenInSafariHint";
import { api, joinParty } from "../http";

function statusLabel(status: string): string {
  switch (status) {
    case "played":
      return "Played";
    case "skipped":
      return "Removed";
    case "vetoed":
      return "Vetoed";
    default:
      return status;
  }
}

export function GuestMySongsPage() {
  const { slug = "" } = useParams<{ slug: string }>();
  const [joined, setJoined] = React.useState(false);
  const [party, setParty] = React.useState<PartyView | null>(null);
  const [songs, setSongs] = React.useState<GuestMySongsResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    if (!slug) return;
    try {
      setError(null);
      const data = await api<GuestMySongsResponse>(`/parties/${slug}/me/songs`);
      setSongs(data);
      const partyInfo = await api<PartyView>(`/parties/${slug}`);
      setParty(partyInfo);
    } catch (e) {
      setError(formatApiError(e));
    }
  }, [slug]);

  React.useEffect(() => {
    void (async () => {
      try {
        await joinParty(slug);
        setJoined(true);
        await load();
      } catch {
        setError("Could not join party");
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
      setError(null);
      setNotice(null);
      await api(`/parties/${slug}/queue/${itemId}/boost`, {
        method: "POST",
        body: "{}",
      });
      setNotice("Song boosted");
      await load();
    } catch (e) {
      setError(formatApiError(e));
    }
  }

  async function unboost(itemId: string) {
    try {
      setError(null);
      setNotice(null);
      await api(`/parties/${slug}/me/songs/${itemId}/unboost`, {
        method: "POST",
        body: "{}",
      });
      setNotice("Boost removed");
      await load();
    } catch (e) {
      setError(formatApiError(e));
    }
  }

  async function removeSong(itemId: string, trackName: string) {
    if (!confirm(`Remove “${trackName}” from the queue?`)) return;
    try {
      setError(null);
      setNotice(null);
      await api(`/parties/${slug}/me/songs/${itemId}`, { method: "DELETE" });
      setNotice(`Removed “${trackName}”`);
      await load();
    } catch (e) {
      setError(formatApiError(e));
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
                {title === "Played" || title === "Vetoed"
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
        {error && <p className="error">{error}</p>}
      </div>
    );
  }

  return (
    <div className="app guest-my-songs-page">
      <h1>{party?.name ?? "Jukebox"}</h1>

      <OpenInSafariHint joinUrl={window.location.href} />

      <GuestNav
        slug={slug}
        activeSongCount={songs?.active.length ?? 0}
      />

      {partyOff && (
        <div className="banner off">Party is paused — view only.</div>
      )}

      {error && <p className="error">{error}</p>}
      {notice && <p className="toast-ok">{notice}</p>}

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
                {song.artistName} · ↑{song.upvoteCount} · ✕{song.vetoCount}
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
        {renderHistorySection("Vetoed", vetoedHistory)}
      </div>
    </div>
  );
}
