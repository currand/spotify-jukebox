import * as React from "react";
import { useParams } from "react-router-dom";
import type { QueueItemView, QueueResponse, SearchResult, TrackInfo } from "@/shared/types";
import { isTrackInPartyQueue } from "@/shared/queue-match";
import {
  formatApiError,
  NowPlayingBanner,
  SearchFilterChips,
  SearchNav,
  SearchTrackRow,
  TrackTitle,
  UpNextLockedSection,
} from "../components/QueueUi";
import { GuestNav } from "../components/GuestNav";
import { api, guestFetchHeaders, joinParty } from "../http";
import { OpenInSafariHint } from "../components/OpenInSafariHint";
import { SpotifyAttribution } from "../components/SpotifyAttribution";

export function GuestPage() {
  const { slug = "" } = useParams<{ slug: string }>();
  return <GuestApp slug={slug} />;
}

type SearchView = "idle" | "results" | "artist";
type ArtistFilter = "songs" | "top-tracks";

function GuestApp({ slug }: { slug: string }) {
  const [name, setName] = React.useState("");
  const [joined, setJoined] = React.useState(false);
  const [me, setMe] = React.useState<{
    id: string;
    displayName: string | null;
    boostUsed: boolean;
    activeSongCount?: number;
    quota?: { add: number; upvote: number; veto: number };
  } | null>(null);
  const [queue, setQueue] = React.useState<QueueResponse | null>(null);
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<SearchResult | null>(null);
  const [searchView, setSearchView] = React.useState<SearchView>("idle");
  const [selectedArtist, setSelectedArtist] = React.useState<{
    id: string;
    name: string;
  } | null>(null);
  const [artistFilter, setArtistFilter] = React.useState<ArtistFilter | null>(
    null,
  );
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [searching, setSearching] = React.useState(false);
  const etagRef = React.useRef<string | null>(null);
  const artistLoadRef = React.useRef(0);

  React.useEffect(() => {
    void (async () => {
      try {
        await joinParty(slug);
        setJoined(true);
        const profile = await api<typeof me>(`/parties/${slug}/me`);
        setMe(profile);
        if (profile?.displayName) setName(profile.displayName);
      } catch {
        setError("Could not join party");
      }
    })();
  }, [slug]);

  React.useEffect(() => {
    if (!joined) return;
    const pollIntervalMs =
      queue != null && queue.party.status !== "on" ? 15_000 : 3_000;
    const poll = async () => {
      try {
        const res = await fetch(`/api/v1/parties/${slug}/queue`, {
          credentials: "include",
          headers: guestFetchHeaders(
            etagRef.current ? { "If-None-Match": etagRef.current } : {},
          ),
        });
        if (res.status !== 304) {
          const data = (await res.json()) as QueueResponse;
          etagRef.current = data.etag;
          setQueue(data);
        }
        if (queue?.party.status === "on") {
          const profile = await api<typeof me>(`/parties/${slug}/me`);
          setMe(profile);
        }
      } catch {
        /* ignore transient */
      }
    };
    void poll();
    const id = setInterval(poll, pollIntervalMs);
    return () => clearInterval(id);
  }, [joined, slug, queue?.party.status]);

  async function saveName() {
    await api(`/parties/${slug}/me`, {
      method: "PATCH",
      body: JSON.stringify({ displayName: name.trim() }),
    });
    const profile = await api<typeof me>(`/parties/${slug}/me`);
    setMe(profile);
  }

  function clearSearch() {
    setResults(null);
    setSearchView("idle");
    setSelectedArtist(null);
    setArtistFilter(null);
    setQuery("");
    setNotice(null);
  }

  async function search(searchQuery?: string) {
    const trimmed = (searchQuery ?? query).trim();
    if (trimmed.length < 3) {
      setError("Enter at least 3 characters to search.");
      return;
    }
    if (searchQuery) setQuery(searchQuery);
    if (searching) return;
    setSearching(true);
    setError(null);
    setNotice(null);
    try {
      const data = await api<SearchResult>(
        `/parties/${slug}/search?q=${encodeURIComponent(trimmed)}`,
      );
      setResults(data);
      setSearchView("results");
      setSelectedArtist(null);
      setArtistFilter(null);
    } catch (e) {
      setError(formatApiError(e));
    } finally {
      setSearching(false);
    }
  }

  async function loadArtistFilter(
    id: string,
    name: string,
    filter: ArtistFilter,
  ) {
    const loadId = ++artistLoadRef.current;
    setError(null);
    setNotice(null);
    setSelectedArtist({ id, name });
    setArtistFilter(filter);
    setSearchView("artist");

    try {
      const trackFilter = filter === "top-tracks" ? "credited" : "all";
      const data = await api<{ tracks: TrackInfo[] }>(
        `/parties/${slug}/artists/${id}/tracks?name=${encodeURIComponent(name)}&filter=${trackFilter}`,
        { cache: "no-store" },
      );
      const tracks = data?.tracks;

      if (loadId !== artistLoadRef.current) return;
      if (!tracks) throw new Error("Could not load tracks");

      setResults({
        tracks,
        artists: [{ id, name, imageUrl: null }],
      });
    } catch (e) {
      if (loadId !== artistLoadRef.current) return;
      setError(formatApiError(e));
    }
  }

  async function addTrack(track: TrackInfo) {
    try {
      setError(null);
      setNotice(null);
      await api(`/parties/${slug}/queue`, {
        method: "POST",
        body: JSON.stringify({
          uri: track.uri,
          name: track.name,
          artistName: track.artistName,
          albumArtUrl: track.albumArtUrl,
        }),
      });
      etagRef.current = null;
      const profile = await api<typeof me>(`/parties/${slug}/me`);
      setMe(profile);
      setNotice(`Added “${track.name}”`);
    } catch (e) {
      setError(formatApiError(e));
    }
  }

  async function act(path: string) {
    try {
      setError(null);
      await api(path, { method: "POST", body: "{}" });
      etagRef.current = null;
      const profile = await api<typeof me>(`/parties/${slug}/me`);
      setMe(profile);
    } catch (e) {
      setError(formatApiError(e));
    }
  }

  const canMutate = Boolean(me?.displayName);
  const partyOff = queue?.party.status !== "on";
  const showingSearch = searchView !== "idle" && results;

  const upcomingOrdered = queue?.upcomingOrder ?? [
    ...(queue?.boostLane ?? []),
    ...(queue?.upcoming ?? []),
  ];
  const upNext =
    queue?.nextItemId != null
      ? upcomingOrdered.find((item) => item.id === queue.nextItemId)
      : upcomingOrdered[0];
  const later = upcomingOrdered.filter((item) => item.id !== upNext?.id);
  const hasLater = later.length > 0;

  if (!joined) {
    return (
      <div className="app">
        <p>Joining party…</p>
        {error && <p className="error">{error}</p>}
      </div>
    );
  }

  return (
    <div className="app">
      <h1>{queue?.party.name ?? "Jukebox"}</h1>

      <OpenInSafariHint joinUrl={window.location.href} />

      <GuestNav
        slug={slug}
        activeSongCount={me?.activeSongCount ?? 0}
      />

      {!me?.displayName && (
        <div className="card">
          <h2>Enter your name</h2>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Display name"
          />
          <div style={{ marginTop: "0.75rem" }}>
            <button onClick={() => void saveName()} disabled={!name.trim()}>
              Continue
            </button>
          </div>
        </div>
      )}

      {partyOff && (
        <div className="banner off">Party is paused — queue is view only.</div>
      )}

      {error && <p className="error">{error}</p>}

      {queue?.nowPlaying && <NowPlayingBanner item={queue.nowPlaying} />}

      {upNext && !showingSearch && <UpNextLockedSection item={upNext} />}

      {!queue?.nowPlaying && !upNext && (
          <div className="banner warn">Add something!</div>
        )}

      {me?.quota && (
        <p className="small">
          Adds left: {me.quota.add} · Upvotes: {me.quota.upvote} · Vetoes:{" "}
          {me.quota.veto}
        </p>
      )}

      {showingSearch && (
        <SearchNav
          label={searchView === "artist" ? "Back to search" : "Back to queue"}
          onBack={() => {
            if (searchView === "artist") {
              void search();
            } else {
              clearSearch();
            }
          }}
        />
      )}

      <div className="card">
        <div className="row">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search songs or artists"
            onKeyDown={(e) => e.key === "Enter" && void search()}
          />
          <button
            onClick={() => void search()}
            disabled={!canMutate || partyOff || searching || query.trim().length < 3}
          >
            {searching ? "Searching…" : "Search"}
          </button>
        </div>
        {notice && <p className="toast-ok">{notice}</p>}
        {showingSearch && (
          <div style={{ marginTop: "1rem" }}>
            {searchView === "results" && results.artists.length > 0 && (
              <div style={{ marginBottom: "1rem" }}>
                <strong>Artists</strong>
                {results.artists.map((a) => (
                  <div key={a.id} className="artist-row">
                    <button
                      type="button"
                      className="linkish artist-row-name"
                      onClick={() => void search(a.name)}
                    >
                      {a.name}
                    </button>
                    <SearchFilterChips
                      filters={[
                        {
                          id: "songs",
                          label: "Songs",
                          onClick: () => void loadArtistFilter(a.id, a.name, "songs"),
                        },
                        {
                          id: "top-tracks",
                          label: "Top tracks",
                          onClick: () =>
                            void loadArtistFilter(a.id, a.name, "top-tracks"),
                        },
                      ]}
                    />
                  </div>
                ))}
              </div>
            )}
            {searchView === "artist" && selectedArtist && (
              <div style={{ marginBottom: "0.75rem" }}>
                <p className="small" style={{ margin: "0 0 0.5rem" }}>
                  {selectedArtist.name}
                </p>
                <SearchFilterChips
                  filters={[
                    {
                      id: "songs",
                      label: "Songs",
                      active: artistFilter === "songs",
                      onClick: () =>
                        void loadArtistFilter(
                          selectedArtist.id,
                          selectedArtist.name,
                          "songs",
                        ),
                    },
                    {
                      id: "top-tracks",
                      label: "Top tracks",
                      active: artistFilter === "top-tracks",
                      onClick: () =>
                        void loadArtistFilter(
                          selectedArtist.id,
                          selectedArtist.name,
                          "top-tracks",
                        ),
                    },
                  ]}
                />
              </div>
            )}
            {results.tracks.map((t) => (
              <SearchTrackRow
                key={`${artistFilter ?? "none"}-${t.uri}`}
                track={t}
                inQueue={queue ? isTrackInPartyQueue(t, queue) : false}
                addDisabled={!canMutate || partyOff}
                onAdd={() => void addTrack(t)}
              />
            ))}
          </div>
        )}
      </div>

      {!showingSearch && hasLater && (
        <section>
          <h2>Later</h2>
          {later.map((item) => (
            <QueueRow
              key={item.id}
              item={item}
              guestId={me?.id}
              canMutate={canMutate && !partyOff}
              boostUsed={me?.boostUsed ?? true}
              onAction={act}
              slug={slug}
            />
          ))}
        </section>
      )}
      <SpotifyAttribution />
    </div>
  );
}

function QueueRowActions({
  item,
  guestId,
  canMutate,
  boostUsed,
  onAction,
  slug,
}: {
  item: QueueItemView;
  guestId?: string;
  canMutate: boolean;
  boostUsed: boolean;
  onAction: (path: string) => Promise<void>;
  slug: string;
}) {
  const isOwn = guestId != null && item.addedByGuestId === guestId;
  const upNextPending =
    item.guestUpvoteBlocked &&
    item.status === "pending" &&
    !item.guestVetoBlocked;

  async function veto() {
    if (isOwn && !confirm("You're about to veto a song you added. Continue?")) {
      return;
    }
    await onAction(`/parties/${slug}/queue/${item.id}/veto`);
  }

  return (
    <>
      {!isOwn && (
        <button
          className="secondary"
          disabled={!canMutate || item.guestUpvoteBlocked}
          title={
            item.guestUpvoteBlocked
              ? upNextPending
                ? "Up next — upvotes are locked"
                : "Already queued in Spotify — upvotes are locked"
              : undefined
          }
          onClick={() =>
            void onAction(`/parties/${slug}/queue/${item.id}/upvote`)
          }
        >
          Upvote
        </button>
      )}
      <button
        className="secondary"
        disabled={!canMutate || item.guestVetoBlocked}
        title={
          item.guestVetoBlocked
            ? "Already queued in Spotify — vetoes are locked"
            : undefined
        }
        onClick={() => void veto()}
      >
        Veto
      </button>
      <button
        disabled={
          !canMutate || boostUsed || item.isBoosted || item.guestBoostBlocked
        }
        title={
          item.guestBoostBlocked
            ? upNextPending
              ? "Up next — boost is locked"
              : item.status === "queued"
                ? "Already queued in Spotify — boost is locked"
                : undefined
            : undefined
        }
        onClick={() => void onAction(`/parties/${slug}/queue/${item.id}/boost`)}
      >
        Boost
      </button>
    </>
  );
}

function QueueRow({
  item,
  guestId,
  canMutate,
  boostUsed,
  onAction,
  slug,
}: {
  item: QueueItemView;
  guestId?: string;
  canMutate: boolean;
  boostUsed: boolean;
  onAction: (path: string) => Promise<void>;
  slug: string;
}) {
  return (
    <div className={`track card${item.isBoosted ? " track--boosted" : ""}`}>
      {item.albumArtUrl && <img src={item.albumArtUrl} alt="" />}
      <div className="track-meta">
        <TrackTitle name={item.trackName} boosted={item.isBoosted} />
        <p>
          {item.artistName} · {item.addedBy} · ↑{item.upvoteCount} · ✕
          {item.vetoCount}
        </p>
      </div>
      <div className="actions">
        <QueueRowActions
          item={item}
          guestId={guestId}
          canMutate={canMutate}
          boostUsed={boostUsed}
          onAction={onAction}
          slug={slug}
        />
      </div>
    </div>
  );
}
