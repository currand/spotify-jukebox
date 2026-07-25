# Bugs

- [x] Change "BOOST" to "BOOSTED" on songs currently playing or next that have been boosted.
- [x] Boosting or upvoting places a song ahead of the next up song in the virtual queue but cannot actually replace that song in the spotify queue. A boosted song should go to next in line after "next up" and have the boost/upvote and other buttons disabled unless another song is boosted ahead. In short, the buffer song is immutable, only the penultimate and lower songs can change order.
- [x] Unlabeled number on the create-party form — was veto threshold (`3` default). Now labeled "Vetoes to skip a song" with helper text.
- [x] If party mode is off, there should be no API calls.
- [x] Admin display Display route has no back or navigation buttons. QR should scale to right half of screen with queue on left half.
- [x] Sync with Spotify button should work even when not playing. It can simply sync the buffer song.
- [x] Tracks in admin portal are not visible due to buttons. Move buttons below tracks in the same way they are in user pages.

# Features

## General UI

- [x] When displayed on a larger screen like laptop, the pages should be fully reactive. they're currently a bit squished.
- [x] Add a page that admin can display showing the queue and the QR code prominently

## Guest Search

- [x] In search, make the artist name clickable and if clicked launches a search for that artist

## Admin

- [x] Admin portal settings for per-guest rate limits: add, upvote, veto, search (per guest + party-wide), and veto threshold. Editable on the active party page; defaults apply at create time.
- [x] Allow setting guest limits at party create time (optional advanced section), not only after the party exists.
- [x] Provide a manual sync button where when pressed by the admin, the currently playing and buffer song are refreshed and displayed correctly. if there's any additional songs in the spotify queue, they'd be shown in their cirrect order and locked (so they cannot be superceded by veto, upvote, or boost). again, spotify queue is canonical.
- [x] The admin panel is oddly formatted. Everything seem sleft-justified and the settings seem very hap hazzardly formatted. not clean and minimal. Don't go overboard but clean this up.
- [x] The track listing in admin doesn't seem to follow formatting principles of the user pages. the buttons look a bit different and are grouped/laid out differntly.

## Spotify / cache

- [x] Batch catalog search (`type=track,artist`), seed artist caches from track hits, LRU eviction, smarter prefetch (see `62b747e`).

## Metrics history

- [x] Persist diagnostics snapshots per app session (5s interval + immediate on 429) for later review on the Diagnostics page.
