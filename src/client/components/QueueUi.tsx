import * as React from "react";
import type { QueueItemView, TrackInfo } from "@/shared/types";

export function BoostBadge() {
  return <span className="boost-badge">Boost</span>;
}

export function TrackTitle({
  name,
  boosted,
}: {
  name: string;
  boosted?: boolean;
}) {
  return (
    <h3 className="track-title">
      <span className="track-title-name">{name}</span>
      {boosted ? <BoostBadge /> : null}
    </h3>
  );
}

export function NowPlayingBanner({ item }: { item: QueueItemView }) {
  return (
    <div className="banner playing now-playing">
      <div className="now-playing-inner">
        {item.albumArtUrl ? (
          <img src={item.albumArtUrl} alt="" className="now-playing-art" />
        ) : (
          <div className="now-playing-art now-playing-art--placeholder" />
        )}
        <div className="now-playing-meta">
          <strong>Now playing</strong>
          <div className="now-playing-title">
            <span className="track-title-name">{item.trackName}</span>
            {item.isBoosted ? <BoostBadge /> : null}
          </div>
          <div className="now-playing-sub">
            {item.artistName} · {item.addedBy}
          </div>
        </div>
      </div>
    </div>
  );
}

export function UpNextLockedSection({ item }: { item: QueueItemView }) {
  const buffered = item.status === "queued";
  return (
    <section
      className={`up-next-locked${buffered ? " up-next-locked--buffered" : ""}${item.isBoosted ? " up-next-locked--boosted" : ""}`}
    >
      <h2 className="up-next-locked-heading">Up next</h2>
      <p className="small up-next-locked-note">
        {buffered ? "Locked in Spotify" : "Sending to Spotify…"}
      </p>
      <div className="track up-next-locked-track">
        {item.albumArtUrl && <img src={item.albumArtUrl} alt="" />}
        <div className="track-meta">
          <TrackTitle name={item.trackName} boosted={item.isBoosted} />
          <p>
            {item.artistName} · {item.addedBy} · ↑{item.upvoteCount} · ✕
            {item.vetoCount}
          </p>
        </div>
      </div>
    </section>
  );
}

export function SearchTrackRow({
  track,
  inQueue,
  addDisabled,
  onAdd,
}: {
  track: TrackInfo;
  inQueue: boolean;
  addDisabled?: boolean;
  onAdd: () => void;
}) {
  return (
    <div
      className={`track card search-track${inQueue ? " search-track--in-queue" : ""}`}
    >
      {track.albumArtUrl && <img src={track.albumArtUrl} alt="" />}
      <div className="track-meta">
        <h3>{track.name}</h3>
        <p>{track.artistName}</p>
      </div>
      {inQueue ? (
        <span className="search-in-queue">In queue</span>
      ) : (
        <button type="button" disabled={addDisabled} onClick={onAdd}>
          Add
        </button>
      )}
    </div>
  );
}

export function SearchNav({
  label,
  onBack,
}: {
  label: string;
  onBack: () => void;
}) {
  return (
    <nav className="search-nav">
      <button type="button" className="secondary search-nav-back" onClick={onBack}>
        ← {label}
      </button>
    </nav>
  );
}

export function SearchFilterChips({
  filters,
}: {
  filters: {
    id: string;
    label: string;
    active?: boolean;
    onClick: () => void;
  }[];
}) {
  return (
    <div className="search-filters">
      {filters.map((f) => (
        <button
          key={f.id}
          type="button"
          className={`chip${f.active ? " chip--active" : ""}`}
          aria-pressed={f.active ?? false}
          onClick={() => f.onClick()}
        >
          {f.label}
        </button>
      ))}
    </div>
  );
}

export function formatApiError(error: unknown): string {
  if (!(error instanceof Error)) return "Something went wrong";
  const msg = error.message;
  if (
    msg === "This song is already in the queue" ||
    msg === "Duplicate song" ||
    msg.includes("DUPLICATE")
  ) {
    return "That song is already in the queue.";
  }
  if (msg.includes("Party is off") || msg.includes("PARTY_OFF")) {
    return "Party is paused — turn it on to add songs.";
  }
  if (msg.includes("Display name required")) {
    return "Enter your name before adding songs.";
  }
  if (msg.includes("Rate limited")) {
    return "Slow down — you've hit the add limit for now.";
  }
  if (msg.includes("already queued in Spotify") || msg.includes("NEXT_LOCKED")) {
    return "That song is already queued in Spotify.";
  }
  if (msg.includes("Not your song") || msg.includes("NOT_OWNER")) {
    return "You can only change your own songs.";
  }
  if (msg.includes("Cannot remove now playing") || msg.includes("NOW_PLAYING")) {
    return "That song is playing right now.";
  }
  return msg;
}
