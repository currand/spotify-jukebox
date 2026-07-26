import type { GuestAdminView } from "@/shared/types";
import { formatLastSeen } from "../utils/formatLastSeen";

export function GuestAdminList({
  guests,
  onBanToggle,
  onResetLimits,
  onClearAll,
}: {
  guests: GuestAdminView[];
  onBanToggle: (guest: GuestAdminView) => void;
  onResetLimits: (guest: GuestAdminView) => void;
  onClearAll: () => void;
}) {
  return (
    <>
      <div className="guest-admin-header">
        <h2>Guests</h2>
        {guests.length > 0 ? (
          <button className="secondary" onClick={onClearAll}>
            Clear all guests
          </button>
        ) : null}
      </div>
      {guests.length > 0 ? (
        <p className="small guest-admin-hint">
          Load tests create new sessions each run — use Clear all guests before
          re-running simulations to avoid duplicate entries.
        </p>
      ) : null}
      {guests.length === 0 ? (
        <p className="small">No guests yet. Share the join link to get started.</p>
      ) : (
        guests.map((guest) => (
          <div key={guest.id} className="guest-admin-row">
            <div className="guest-admin-main">
              <div className="guest-admin-name">
                {guest.displayName ?? "Anonymous"}
                {guest.disabled ? (
                  <span className="guest-admin-badge guest-admin-badge--banned">
                    Banned
                  </span>
                ) : null}
              </div>
              <div className="small guest-admin-meta">
                Last seen {formatLastSeen(guest.lastSeenAt)} · Joined{" "}
                {new Date(guest.createdAt).toLocaleDateString()}
                {guest.lastIp ? (
                  <>
                    {" "}
                    · IP{" "}
                    <span className="guest-admin-ip">{guest.lastIp}</span>
                  </>
                ) : null}
              </div>
              <div className="guest-admin-stats">
                <span>{guest.songsAdded.length} added</span>
                <span>{guest.upvoteCount} upvotes</span>
                <span>{guest.vetoCount} downvotes</span>
                <span>
                  {guest.boostCount} boost{guest.boostCount === 1 ? "" : "s"}
                </span>
              </div>
              {guest.songsAdded.length > 0 ? (
                <ul className="guest-songs-list">
                  {guest.songsAdded.map((song) => (
                    <li key={`${song.addedAt}-${song.trackName}`}>
                      {song.trackName} — {song.artistName}
                      <span className="guest-song-status">{song.status}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="small guest-admin-no-songs">No songs added</p>
              )}
            </div>
            <div className="guest-admin-actions">
              <button
                className="secondary"
                onClick={() => onResetLimits(guest)}
              >
                Reset limits
              </button>
              <button
                className="secondary"
                onClick={() => onBanToggle(guest)}
              >
                {guest.disabled ? "Unban" : "Ban"}
              </button>
            </div>
          </div>
        ))
      )}
    </>
  );
}
