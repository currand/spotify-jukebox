import * as React from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { PartyView, QueueSnapshot } from "@/shared/types";
import { api, apiOptional } from "../http";
import { AdminNav } from "../components/AdminNav";
import { SpotifyAttribution } from "../components/SpotifyAttribution";
import { useAutoFullscreen } from "../hooks/useAutoFullscreen";
import {
  NowPlayingBanner,
  ReadOnlyQueueRow,
  UpNextLockedSection,
} from "../components/QueueUi";

interface PartyFull extends PartyView {
  id: string;
  slug: string;
  guestCount?: number;
}

export function AdminDisplayPage() {
  const [searchParams] = useSearchParams();
  const kiosk = searchParams.get("fullscreen") === "1";
  useAutoFullscreen(kiosk);

  const [party, setParty] = React.useState<PartyFull | null>(null);
  const [queue, setQueue] = React.useState<QueueSnapshot | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      setError(null);
      const p = await apiOptional<PartyFull>("/host/parties/current");
      setParty(p);
      if (p) {
        const q = await api<QueueSnapshot>(`/host/parties/${p.id}/queue`);
        setQueue(q);
      } else {
        setQueue(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }, []);

  React.useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 5000);
    return () => clearInterval(id);
  }, [load]);

  const upcomingOrdered = queue?.upcomingOrder ?? [
    ...(queue?.boostLane ?? []),
    ...(queue?.upcoming ?? []),
  ];
  const upNext = upcomingOrdered[0] ?? null;
  const laterQueue = upcomingOrdered.slice(1);

  if (!party) {
    return (
      <div className={`app admin-display-page${kiosk ? " admin-display-page--kiosk" : ""}`}>
        {!kiosk && (
          <Link to="/admin" className="admin-back-link">
            ← Back to admin
          </Link>
        )}
        <p>{error ?? "No active party — create one in admin first."}</p>
      </div>
    );
  }

  return (
    <div className={`app admin-display-page${kiosk ? " admin-display-page--kiosk" : ""}`}>
      {!kiosk && (
        <Link to="/admin" className="admin-back-link">
          ← Back to admin
        </Link>
      )}
      {!kiosk && (
        <AdminNav
          guestCount={party.guestCount ?? 0}
          partyActive
        />
      )}

      <div className="admin-display-layout">
        <aside className="admin-display-qr-panel" aria-label="Join QR code">
          <h2 className="admin-display-qr-heading">Join the party</h2>
          <p className="small admin-display-qr-hint">Scan with your phone camera</p>
          <div className="admin-display-qr-wrap">
            <img
              src={`/api/v1/host/parties/${party.id}/qr`}
              alt="QR code to join party"
              className="admin-display-qr"
            />
          </div>
        </aside>

        <div className="admin-display-queue">
          <h1>{party.name}</h1>
          <p className="small">/{party.slug}</p>

          {error && <p className="error">{error}</p>}

          {queue?.nowPlaying && <NowPlayingBanner item={queue.nowPlaying} />}

          {upNext && <UpNextLockedSection item={upNext} />}

          {laterQueue.length > 0 && (
            <section>
              <h2>Upcoming</h2>
              {laterQueue.map((item) => (
                <ReadOnlyQueueRow key={item.id} item={item} />
              ))}
            </section>
          )}

          {!queue?.nowPlaying && !upNext && laterQueue.length === 0 && (
            <div className="banner warn">Add something!</div>
          )}
        </div>
      </div>

      <SpotifyAttribution />
    </div>
  );
}
