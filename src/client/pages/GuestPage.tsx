import * as React from "react";
import { useParams } from "react-router-dom";
import type { GuestMe, QueueItemView, QueueResponse, SearchResult, TrackInfo } from "@/shared/types";
import { getSearchTrackQueueState } from "@/shared/queue-match";
import {
  formatApiError,
  BoostButton,
  NowPlayingBanner,
  SearchFilterChips,
  SearchNav,
  SearchTrackRow,
  ThumbsUpIcon,
  TrackTitle,
  UpNextLockedSection,
  UpvoteCount,
  DownvoteCount,
  ThumbsDownIcon,
} from "../components/QueueUi";
import { GuestNav } from "../components/GuestNav";
import { GuestNamePrompt } from "../components/GuestNamePrompt";
import { GuestTutorial } from "../components/GuestTutorial";
import { usePopup } from "../hooks/usePopup";
import {
  boostApiMessage,
  boostBlockedMessage,
  downvoteApiMessage,
  downvoteBlockedMessage,
  upvoteApiMessage,
  upvoteBlockedMessage,
} from "../utils/queue-action-messages";
import { api, guestFetchHeaders, joinParty } from "../http";
import { SpotifyAttribution } from "../components/SpotifyAttribution";

export function GuestPage() {
  const { slug = "" } = useParams<{ slug: string }>();
  return <GuestApp slug={slug} />;
}

type SearchView = "idle" | "results" | "artist";
type ArtistFilter = "songs" | "top-tracks";

function GuestApp({ slug }: { slug: string }) {
  const [me, setMe] = React.useState<GuestMe | null>(null);
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
  const [joinError, setJoinError] = React.useState<string | null>(null);
  const [searching, setSearching] = React.useState(false);
  const { showPopup, PopupHost } = usePopup();
  const [joined, setJoined] = React.useState(false);
  const [highlightedItemId, setHighlightedItemId] = React.useState<string | null>(
    null,
  );
  const etagRef = React.useRef<string | null>(null);
  const artistLoadRef = React.useRef(0);
  const scrollPendingRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    void (async () => {
      try {
        await joinParty(slug);
        setJoined(true);
        const profile = await api<typeof me>(`/parties/${slug}/me`);
        setMe(profile);
      } catch {
        setJoinError("Could not join party");
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

  function onNameSaved(profile: GuestMe) {
    setMe(profile);
  }

  const showTutorial =
    Boolean(me?.displayName) &&
    !me?.tutorialSeen &&
    queue?.party.status === "on";

  function clearSearch() {
    setResults(null);
    setSearchView("idle");
    setSelectedArtist(null);
    setArtistFilter(null);
    setQuery("");
  }

  function scrollToQueueItem(itemId: string) {
    clearSearch();
    scrollPendingRef.current = itemId;
  }

  async function search(searchQuery?: string) {
    const trimmed = (searchQuery ?? query).trim();
    if (trimmed.length < 3) {
      showPopup("Enter at least 3 characters to search.", "info");
      return;
    }
    if (searchQuery) setQuery(searchQuery);
    if (searching) return;
    setSearching(true);
    try {
      const data = await api<SearchResult>(
        `/parties/${slug}/search?q=${encodeURIComponent(trimmed)}`,
      );
      setResults(data);
      setSearchView("results");
      setSelectedArtist(null);
      setArtistFilter(null);
    } catch (e) {
      showPopup(formatApiError(e), "error");
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
      showPopup(formatApiError(e), "error");
    }
  }

  async function addTrack(track: TrackInfo) {
    try {
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
      showPopup(`Added “${track.name}” to the queue`, "success");
    } catch (e) {
      showPopup(formatApiError(e), "error");
    }
  }

  async function act(path: string) {
    try {
      await api(path, { method: "POST", body: "{}" });
      etagRef.current = null;
      const profile = await api<typeof me>(`/parties/${slug}/me`);
      setMe(profile);
    } catch (e) {
      if (path.endsWith("/upvote")) {
        const message = upvoteApiMessage(e);
        if (message) {
          showPopup(message, "info");
          return;
        }
      }
      if (path.endsWith("/veto")) {
        const message = downvoteApiMessage(e);
        if (message) {
          showPopup(message, "info");
          return;
        }
      }
      if (path.endsWith("/boost")) {
        const message = boostApiMessage(e);
        if (message) {
          showPopup(message, "info");
          return;
        }
      }
      showPopup(formatApiError(e), "error");
    }
  }

  const partyOff = queue != null && queue.party.status !== "on";
  const canMutate = !partyOff;
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

  React.useEffect(() => {
    if (showingSearch || !scrollPendingRef.current) return;
    const itemId = scrollPendingRef.current;
    scrollPendingRef.current = null;
    requestAnimationFrame(() => {
      document
        .getElementById(`queue-item-${itemId}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
      setHighlightedItemId(itemId);
      window.setTimeout(() => setHighlightedItemId(null), 2000);
    });
  }, [showingSearch]);

  if (!joined) {
    return (
      <div className="app">
        <p>Joining party…</p>
        {joinError && <p className="error">{joinError}</p>}
      </div>
    );
  }

  if (!me?.displayName) {
    return <GuestNamePrompt slug={slug} onSaved={onNameSaved} />;
  }

  return (
    <div className="app">
      <h1>{queue?.party.name ?? "Jukebox"}</h1>

      <GuestNav
        slug={slug}
        activeSongCount={me?.activeSongCount ?? 0}
      />

      {partyOff && (
        <div className="banner off">Party is paused — queue is view only.</div>
      )}

      <div className="card guest-search-hero">
        <h2 className="guest-search-heading">Search</h2>
        <div className="row guest-search-row">
          <input
            className="guest-search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search songs or artists"
            onKeyDown={(e) => e.key === "Enter" && void search()}
          />
          <button
            className="guest-search-button"
            onClick={() => void search()}
            disabled={partyOff || searching || query.trim().length < 3}
          >
            {searching ? "Searching…" : "Search"}
          </button>
        </div>
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
            {results.tracks.map((t) => {
              const queueState = queue
                ? getSearchTrackQueueState(t, queue)
                : { blockedReason: null, queueItemId: null };
              return (
                <SearchTrackRow
                  key={`${artistFilter ?? "none"}-${t.uri}`}
                  track={t}
                  blockedReason={queueState.blockedReason}
                  queueItemId={queueState.queueItemId}
                  addDisabled={partyOff}
                  onAdd={() => void addTrack(t)}
                  onGoToQueue={scrollToQueueItem}
                />
              );
            })}
          </div>
        )}
      </div>

      {queue?.nowPlaying && (
        <NowPlayingBanner
          item={queue.nowPlaying}
          highlightedItemId={highlightedItemId}
        />
      )}

      {upNext && !showingSearch && (
        <UpNextLockedSection
          item={upNext}
          highlightedItemId={highlightedItemId}
        />
      )}

      {queue == null && !showingSearch && (
        <p className="small guest-queue-loading">Loading queue…</p>
      )}

      {queue != null && !queue.nowPlaying && !upNext && (
        <div className="banner warn">Add something!</div>
      )}

      {me?.quota && (
        <p className="small">
          Adds left: {me.quota.add} · Upvotes: {me.quota.upvote} · Downvotes:{" "}
          {me.quota.veto} · Boosts: {me.quota.boost}
        </p>
      )}

      {!showingSearch && hasLater && (
        <section>
          <h2>Later</h2>
          {later.map((item) => (
            <QueueRow
              key={item.id}
              item={item}
              guestId={me?.id}
              canMutate={canMutate}
              boostsLeft={me?.quota?.boost ?? 0}
              partyBoostsRemaining={queue?.boostsRemaining}
              upvotesLeft={me?.quota?.upvote}
              downvotesLeft={me?.quota?.veto}
              showPopup={showPopup}
              onAction={act}
              slug={slug}
              highlightedItemId={highlightedItemId}
            />
          ))}
        </section>
      )}
      <SpotifyAttribution />
      {showTutorial && (
        <GuestTutorial
          slug={slug}
          onDismiss={() =>
            setMe((current) =>
              current ? { ...current, tutorialSeen: true } : current,
            )
          }
        />
      )}
      <PopupHost />
    </div>
  );
}

function QueueRowActions({
  item,
  guestId,
  canMutate,
  boostsLeft,
  partyBoostsRemaining,
  upvotesLeft,
  downvotesLeft,
  showPopup,
  onAction,
  slug,
}: {
  item: QueueItemView;
  guestId?: string;
  canMutate: boolean;
  boostsLeft: number;
  partyBoostsRemaining?: number | null;
  upvotesLeft?: number;
  downvotesLeft?: number;
  showPopup: (message: string, kind?: "success" | "error" | "info") => void;
  onAction: (path: string) => Promise<void>;
  slug: string;
}) {
  const isOwn = guestId != null && item.addedByGuestId === guestId;
  const upvoteDisabled =
    !canMutate ||
    item.guestUpvoteBlocked ||
    isOwn ||
    item.guestHasUpvoted === true ||
    upvotesLeft === 0;
  const downvoteDisabled =
    !canMutate ||
    item.guestVetoBlocked ||
    item.guestHasDownvoted === true ||
    downvotesLeft === 0;
  const boostDisabled =
    !canMutate ||
    boostsLeft === 0 ||
    partyBoostsRemaining === 0 ||
    item.isBoosted ||
    item.guestBoostBlocked;

  async function downvote() {
    if (downvoteDisabled) {
      showPopup(downvoteBlockedMessage(item, canMutate, downvotesLeft), "info");
      return;
    }
    if (isOwn && !confirm("You're about to downvote a song you added. Continue?")) {
      return;
    }
    await onAction(`/parties/${slug}/queue/${item.id}/veto`);
  }

  function handleUpvote() {
    if (upvoteDisabled) {
      showPopup(
        upvoteBlockedMessage(item, canMutate, isOwn, upvotesLeft),
        "info",
      );
      return;
    }
    void onAction(`/parties/${slug}/queue/${item.id}/upvote`);
  }

  function handleBoost() {
    if (boostDisabled) {
      showPopup(
        boostBlockedMessage(item, canMutate, boostsLeft, partyBoostsRemaining),
        "info",
      );
      return;
    }
    void onAction(`/parties/${slug}/queue/${item.id}/boost`);
  }

  return (
    <>
      <button
        type="button"
        className={`secondary upvote-action${upvoteDisabled ? " upvote-action--disabled" : ""}`}
        aria-label="Upvote"
        aria-disabled={upvoteDisabled}
        onClick={handleUpvote}
      >
        <ThumbsUpIcon />
      </button>
      <button
        type="button"
        className={`secondary downvote-action${downvoteDisabled ? " downvote-action--disabled" : ""}`}
        aria-label="Downvote"
        aria-disabled={downvoteDisabled}
        onClick={() => void downvote()}
      >
        <ThumbsDownIcon />
      </button>
      <BoostButton disabled={boostDisabled} onClick={handleBoost} />
    </>
  );
}

function QueueRow({
  item,
  guestId,
  canMutate,
  boostsLeft,
  partyBoostsRemaining,
  upvotesLeft,
  downvotesLeft,
  showPopup,
  onAction,
  slug,
  highlightedItemId,
}: {
  item: QueueItemView;
  guestId?: string;
  canMutate: boolean;
  boostsLeft: number;
  partyBoostsRemaining?: number | null;
  upvotesLeft?: number;
  downvotesLeft?: number;
  showPopup: (message: string, kind?: "success" | "error" | "info") => void;
  onAction: (path: string) => Promise<void>;
  slug: string;
  highlightedItemId?: string | null;
}) {
  return (
    <div
      id={`queue-item-${item.id}`}
      className={`track card${item.isBoosted ? " track--boosted" : ""}${highlightedItemId === item.id ? " queue-item--highlight" : ""}`}
    >
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
      <div className="actions">
        <QueueRowActions
          item={item}
          guestId={guestId}
          canMutate={canMutate}
          boostsLeft={boostsLeft}
          partyBoostsRemaining={partyBoostsRemaining}
          upvotesLeft={upvotesLeft}
          downvotesLeft={downvotesLeft}
          showPopup={showPopup}
          onAction={onAction}
          slug={slug}
        />
      </div>
    </div>
  );
}
