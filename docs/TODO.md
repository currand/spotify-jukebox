# Bugs

- [x] Change "BOOST" to "BOOSTED" on songs currently playing or next that have been boosted.
- [x] Boosting or upvoting places a song ahead of the next up song in the virtual queue but cannot actually replace that song in the spotify queue. A boosted song should go to next in line after "next up" and have the boost/upvote and other buttons disabled unless another song is boosted ahead. In short, the buffer song is immutable, only the penultimate and lower songs can change order.
- [x] Unlabeled number on the create-party form — was veto threshold (`3` default). Now labeled "Vetoes to skip a song" with helper text.
- [ ] If party mode is off, there should be no API calls.

# Features

## Guest Search

- [ ] In search, make the artist name clickable and if clicked launches a search for that artist

## Admin — guest limits

- [x] Admin portal settings for per-guest rate limits: add, upvote, veto, search (per guest + party-wide), and veto threshold. Editable on the active party page; defaults apply at create time.
- [ ] Allow setting guest limits at party create time (optional advanced section), not only after the party exists.

## Spotify / cache

- [x] Batch catalog search (`type=track,artist`), seed artist caches from track hits, LRU eviction, smarter prefetch (see `62b747e`).

## Metrics history

- [x] Persist diagnostics snapshots per app session (5s interval + immediate on 429) for later review on the Diagnostics page.
