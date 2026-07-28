import * as React from "react";
import { queueItemAnchorId } from "@/shared/queue-match";
import type { SearchQueueBlockReason } from "@/shared/queue-match";
import type { QueueItemView, TrackInfo } from "@/shared/types";

export function ThumbsUpIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      className="thumbs-up-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z" />
    </svg>
  );
}

export function UpvoteCount({ count }: { count: number }) {
  return (
    <span className="upvote-count">
      <ThumbsUpIcon />
      <span>{count}</span>
    </span>
  );
}

export function ThumbsDownIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      className="thumbs-down-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M15 3H6c-.83 0-1.54.5-1.84 1.22l-3.02 7.05c-.09.23-.14.47-.14.73v2c0 .55.45 1 1 1h5.31l-.95 4.57-.03.32c0 .41.17.79.44 1.06L9.83 23 16 16.83V3zM17 1v12h4V1h-4z" />
    </svg>
  );
}

export function DownvoteCount({ count }: { count: number }) {
  return (
    <span className="downvote-count">
      <ThumbsDownIcon />
      <span>{count}</span>
    </span>
  );
}

export function BoostBadge({ boostedBy }: { boostedBy?: string | null }) {
  return (
    <span className="boost-indicator">
      <span className="boost-badge">Boosted</span>
      {boostedBy ? <span className="boost-by">by {boostedBy}</span> : null}
    </span>
  );
}

export function BoostButton({
  disabled,
  onClick,
  className,
}: {
  disabled?: boolean;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`boost-badge${disabled ? " boost-badge--disabled" : ""}${className ? ` ${className}` : ""}`}
      aria-disabled={disabled}
      disabled={disabled}
      onClick={onClick}
    >
      Boost
    </button>
  );
}

export function TrackTitle({
  name,
  boosted,
  boostedBy,
}: {
  name: string;
  boosted?: boolean;
  boostedBy?: string | null;
}) {
  return (
    <h3 className="track-title">
      <span className="track-title-name">{name}</span>
      {boosted ? <BoostBadge boostedBy={boostedBy} /> : null}
    </h3>
  );
}

function queueItemHighlightClass(
  itemId: string,
  highlightedItemId?: string | null,
): string {
  return highlightedItemId === itemId ? " queue-item--highlight" : "";
}

export function NowPlayingBanner({
  item,
  highlightedItemId,
}: {
  item: QueueItemView;
  highlightedItemId?: string | null;
}) {
  return (
    <div
      id={queueItemAnchorId(item.id)}
      className={`banner playing now-playing${queueItemHighlightClass(item.id, highlightedItemId)}`}
    >
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
            {item.isBoosted ? <BoostBadge boostedBy={item.boostedBy} /> : null}
          </div>
          <div className="now-playing-sub">{item.artistName} · {item.addedBy}</div>
        </div>
      </div>
    </div>
  );
}

export function UpNextLockedSection({
  item,
  highlightedItemId,
}: {
  item: QueueItemView;
  highlightedItemId?: string | null;
}) {
  const buffered = item.status === "queued";
  return (
    <section
      id={queueItemAnchorId(item.id)}
      className={`up-next-locked${buffered ? " up-next-locked--buffered" : ""}${item.isBoosted ? " up-next-locked--boosted" : ""}${queueItemHighlightClass(item.id, highlightedItemId)}`}
    >
      <h2 className="up-next-locked-heading">Up next</h2>
      <p className="small up-next-locked-note">
        {buffered ? "Locked in Spotify" : "Sending to Spotify…"}
      </p>
      <div className="track up-next-locked-track">
        {item.albumArtUrl && <img src={item.albumArtUrl} alt="" />}
        <div className="track-meta">
          <TrackTitle
            name={item.trackName}
            boosted={item.isBoosted}
            boostedBy={item.boostedBy}
          />
          <p>
            {item.artistName} · {item.addedBy} · <UpvoteCount count={item.upvoteCount} /> ·{" "}
            <DownvoteCount count={item.vetoCount} />
          </p>
        </div>
      </div>
    </section>
  );
}

export function SearchTrackRow({
  track,
  blockedReason,
  queueItemId,
  addDisabled,
  onAdd,
  onGoToQueue,
}: {
  track: TrackInfo;
  blockedReason?: SearchQueueBlockReason;
  queueItemId?: string | null;
  addDisabled?: boolean;
  onAdd: () => void;
  onGoToQueue?: (itemId: string) => void;
}) {
  const inQueue = blockedReason != null;

  return (
    <div
      className={`track card search-track${inQueue ? " search-track--in-queue" : ""}`}
    >
      {track.albumArtUrl && <img src={track.albumArtUrl} alt="" />}
      <div className="track-meta">
        <h3>{track.name}</h3>
        <p>{track.artistName}</p>
      </div>
      {blockedReason === "active" && queueItemId && onGoToQueue ? (
        <button
          type="button"
          className="search-in-queue search-in-queue--link"
          onClick={() => onGoToQueue(queueItemId)}
        >
          In queue
        </button>
      ) : blockedReason === "history" ? (
        <span className="search-in-queue search-in-queue--history">Already played</span>
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

export function ReadOnlyQueueRow({ item }: { item: QueueItemView }) {
  return (
    <div
      className={`track card${item.isBoosted ? " track--boosted" : ""}${item.spotifyLocked ? " track--spotify-locked" : ""}`}
    >
      {item.albumArtUrl && <img src={item.albumArtUrl} alt="" />}
      <div className="track-meta">
        <TrackTitle
          name={item.trackName}
          boosted={item.isBoosted}
          boostedBy={item.boostedBy}
        />
        <p>
          {item.artistName} · {item.addedBy}
          {item.spotifyLocked ? " · Locked in Spotify" : ""}
          {!item.spotifyLocked && (
            <>
              {" "}
              · <UpvoteCount count={item.upvoteCount} /> · <DownvoteCount count={item.vetoCount} />
            </>
          )}
        </p>
      </div>
    </div>
  );
}

export function AdminQueueRow({
  item,
  onAction,
  partyId,
  canMoveUp = true,
  canMoveDown = true,
  highlightedItemId,
}: {
  item: QueueItemView;
  partyId: string;
  onAction: (path: string, method?: string, body?: unknown) => Promise<void>;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  highlightedItemId?: string | null;
}) {
  const locked = item.spotifyLocked || item.status === "queued";

  return (
    <div
      id={queueItemAnchorId(item.id)}
      className={`track card${item.isBoosted ? " track--boosted" : ""}${locked ? " track--spotify-locked" : ""}${queueItemHighlightClass(item.id, highlightedItemId)}`}
    >
      {item.albumArtUrl && <img src={item.albumArtUrl} alt="" />}
      <div className="track-meta">
        <TrackTitle
          name={item.trackName}
          boosted={item.isBoosted}
          boostedBy={item.boostedBy}
        />
        <p>
          {item.artistName} · {item.addedBy} · <UpvoteCount count={item.upvoteCount} />
          {locked ? " · Locked in Spotify" : ""}
        </p>
      </div>
      {!locked && (
        <div className="actions">
          <button
            className="secondary"
            onClick={() =>
              void onAction(
                `/host/parties/${partyId}/queue/${item.id}`,
                "PATCH",
                { action: "force_next" },
              )
            }
          >
            Force next
          </button>
          <button
            className="secondary"
            disabled={!canMoveUp}
            title={!canMoveUp ? "Already at top of reorderable queue" : undefined}
            onClick={() =>
              void onAction(
                `/host/parties/${partyId}/queue/${item.id}`,
                "PATCH",
                { action: "move_up" },
              )
            }
          >
            ↑
          </button>
          <button
            className="secondary"
            disabled={!canMoveDown}
            title={!canMoveDown ? "Already at bottom of reorderable queue" : undefined}
            onClick={() =>
              void onAction(
                `/host/parties/${partyId}/queue/${item.id}`,
                "PATCH",
                { action: "move_down" },
              )
            }
          >
            ↓
          </button>
          <button
            className="secondary"
            onClick={() =>
              void onAction(
                `/host/parties/${partyId}/queue/start-from/${item.id}`,
              )
            }
          >
            Start here
          </button>
          <button
            className="secondary"
            onClick={() =>
              void onAction(
                `/host/parties/${partyId}/queue/${item.id}`,
                "DELETE",
              )
            }
          >
            Remove
          </button>
        </div>
      )}
    </div>
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
  if (msg.includes("Could not verify that name")) {
    return "We couldn't verify that name — pick a different one.";
  }
  if (msg.includes("Rate limited") || msg.includes("Search rate limited")) {
    return "Slow down — try again in a moment.";
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
