import * as React from "react";
import { Link, useParams } from "react-router-dom";
import type { GuestInfoResponse, PartyView } from "@/shared/types";
import { GuestNav } from "../components/GuestNav";
import { GuestNamePrompt } from "../components/GuestNamePrompt";
import {
  GuestActivityPanel,
  GuestQuotaPanel,
} from "../components/StatPanels";
import {
  BoostBadge,
  BoostButton,
  formatApiError,
  TrackTitle,
  UpvoteCount,
  DownvoteCount,
} from "../components/QueueUi";
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
    case "unblocked":
      return "Unblocked";
    default:
      return status;
  }
}

export function GuestMyInfoPage() {
  const { slug = "" } = useParams<{ slug: string }>();
  const [joined, setJoined] = React.useState(false);
  const [me, setMe] = React.useState<{ displayName: string | null } | null>(
    null,
  );
  const [party, setParty] = React.useState<PartyView | null>(null);
  const [info, setInfo] = React.useState<GuestInfoResponse | null>(null);
  const [joinError, setJoinError] = React.useState<string | null>(null);
  const { showPopup, PopupHost } = usePopup();

  const load = React.useCallback(async () => {
    if (!slug) return;
    try {
      const data = await api<GuestInfoResponse>(`/parties/${slug}/me/info`);
      setInfo(data);
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

  const partyOff = party != null && party.status !== "on";
  const canMutate = Boolean(info && !partyOff);
  const removedHistory =
    info?.history.filter((song) => song.status === "skipped") ?? [];
  const playedHistory =
    info?.history.filter((song) => song.status === "played") ?? [];
  const vetoedHistory =
    info?.history.filter((song) => song.status === "vetoed") ?? [];

  function renderHistorySection(
    title: string,
    items: NonNullable<typeof info>["history"],
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
                {song.isBoosted ? <BoostBadge boostedBy={song.boostedBy} /> : null}
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
    <div className="app guest-my-info-page">
      <h1>{party?.name ?? "Jukebox"}</h1>
      <p className="guest-info-display-name">{info?.displayName ?? me.displayName}</p>

      <GuestNav slug={slug} activeSongCount={info?.active.length ?? 0} />

      {partyOff && (
        <div className="banner off">Party is paused — view only.</div>
      )}

      {info && (
        <>
          <GuestQuotaPanel quota={info.quota} rateLimits={info.rateLimits} />
          <GuestActivityPanel stats={info.stats} />
        </>
      )}

      <div className="card">
        <h2>My songs</h2>
        <p className="small guest-my-songs-intro">
          Songs you added to the party queue.
          {info?.boostUsed
            ? " No boosts left in your current window."
            : ` You have ${info?.boostsLeft ?? 0} boost${info?.boostsLeft === 1 ? "" : "s"} left.`}
        </p>

        {info?.active.length === 0 &&
        removedHistory.length === 0 &&
        playedHistory.length === 0 &&
        vetoedHistory.length === 0 ? (
          <p className="guest-my-songs-empty">
            You haven&apos;t added any songs yet.{" "}
            <Link to={`/p/${slug}`}>Search the queue</Link>
          </p>
        ) : null}

        {info?.active.map((song) => (
          <div
            key={song.id}
            className={`track card guest-my-song${song.isBoosted ? " track--boosted" : ""}`}
          >
            {song.albumArtUrl && <img src={song.albumArtUrl} alt="" />}
            <div className="track-meta">
              <TrackTitle
                name={song.trackName}
                boosted={song.isBoosted}
                boostedBy={song.boostedBy}
              />
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
                <BoostButton
                  disabled={!canMutate}
                  onClick={() => void boost(song.id)}
                />
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
