# Changelog

## v3.1.3 — New Logo, Bug Fixes & Emote Improvements

### New Logo
- Updated app icon to purple geometric low-poly raven across all targets (AppIcon, LargeIcon, extension icons, in-app icon, toolbar SVG, settings button SVG, popup)

### Bug Fixes
- Fixed split chat colors race condition — old messages no longer get multicolored backgrounds on stream load
- Fixed watch time tracker disappearing on page reload — added broader fallback selectors and proper retry logic
- Fixed emote menu click-to-insert — rewrote for Twitch's Slate.js contenteditable editor (was silently failing on textarea that no longer exists)
- Improved emote rendering fallback — now processes direct text nodes and child spans when `.text-fragment` wrapper is absent (matches BTTV's approach)

### Improvements
- Updated version display in popup and settings panel to v3.1.2
- Added per-provider emote count logging for easier debugging

---

## v3.1.2 — Performance Optimizations

- Debounced and scoped `clipLabelObserver` — no longer fires `querySelectorAll` on every DOM mutation
- Fixed `enhancedUserCards` observer stacking — now disconnects on channel change, scoped to chat container
- Throttled autoplay prevention observer callback
- Replaced `emoteMap` plain object with `Map` — O(1) `.size` check instead of `Object.keys().length` per message
- Cached theme detection via `MutationObserver` on `<html>` class — no more DOM queries per chat message
- Pre-compiled hot-path regex literals as module-level constants (`isYoutubeUrl`, `isImageUrl`, `escapeHtml`, clip labels)
- Added cache size limits (LRU eviction) to `pronounsCache`, `youtubeCache`, and `cosmeticsCache` in background.js
- Replaced `Array.shift()` loop in spam buffer with `splice()` for O(1) pruning
- Replaced 3-second player button polling with scoped `MutationObserver` on the video player
- Auto-claim interval slows from 5s to 30s once observer is attached to the points summary
- Debounced settings button removal observer
- Built pre-sorted lowercase emote name index with binary search for autocomplete — eliminates `O(n)` scan per keystroke
- Cached `<video>` element reference for watch time and VOD clock intervals
- Extracted `EXCLUDED_PATHS` Set as module-level constant (content.js + injected.js)
- Replaced DOM-based `escapeHtml` with pure string replacement
- Replaced polling-based `fetchPronounMap` deduplication with Promise-based dedup

---

## v3.1.1 — Bug Fixes & Cleanup

- Fixed Move Chat to Left — rewrote using pure CSS `order` approach (matching BTTV/FFZ)
- Fixed Watch Time Tracker — updated stale DOM selectors for display insertion
- Removed Chatter Count feature (dead TMI endpoint, low value)
- Cleaned up dead TMI handler in background.js

---

## v3.1.0 — 8 More Features + Bug Fixes

### New Features
- Clip download button — one-click download on clip pages
- Chat image previews — inline image preview for image URLs posted in chat (imgur, etc.)
- Pin/favorite channels — hover any sidebar channel to pin it to the top
- Watch time tracker — shows how long you've watched the current channel this session
- Unwanted content filter — hide specific games/channels from directory/browse pages
- Move chat to left — option to position chat on the left side of the player
- VOD real-time clock — shows the original broadcast wall-clock time when watching VODs
- Chatter count display — shows exact number of chatters next to viewer count (via TMI API)

### Bug Fixes
- Fixed audio compressor not triggering — added retry logic for video element and AudioContext
- Fixed compressor button disappearing on click — separated audio toggle from button injection
- Fixed screenshot button disappearing — added MutationObserver to re-inject player buttons when Twitch re-renders
- Fixed channel preview tooltip staying on screen — now cleans up on click and SPA navigation
- Changed compressor icon to equalizer bars (was identical to Twitch's volume icon)
- Fixed spam detection not working — broadened message text selector to catch emote-only messages

### Improvements
- Spam filter now shows an emote/message combo counter widget (top 5 active combos with ×count)
- Removed channel profiles — settings now apply globally by default (simplifies UX)
- Added `host_permissions` for `tmi.twitch.tv` (chatter count API)
- Player controls observer re-injects buttons (compressor, PiP, screenshot) when Twitch re-renders

---

## v3.0.0 — 14 New Features

### Emote Tools
- Emote menu/picker — floating panel with search, provider tabs, and scrollable grid next to chat input
- Animated emotes toggle — option to force static frames for BTTV GIF / 7TV WebP emotes

### Chat — User Info
- Pronouns in chat — shows user pronouns next to display names (via pronouns.alejo.io API)
- Enhanced user cards — account creation date and follow date injected into Twitch's user card popup (via GQL API)

### Chat — Tools
- Slow mode countdown timer — visual countdown overlay on the send button during slow mode
- Chat search — Ctrl+F overlay to search and highlight chat messages in real time
- YouTube link preview on hover — thumbnail, title, and channel name tooltip for YouTube links in chat (via oEmbed)

### Chat — Spam Filtering
- Spam filter — hide repeated messages with configurable repeat threshold and time window
- Hide known bot messages — filter messages from Nightbot, StreamElements, Moobot, Fossabot, and 20+ known bots (hardcoded + TwitchInsights API)

### Player
- Picture-in-Picture button — added to player controls bar, toggles native Safari PiP
- Screenshot capture button — captures current video frame to PNG and downloads it

### Sidebar & UI
- Channel preview on hover — shows live 320×180 thumbnail tooltip when hovering sidebar channels
- Auto-expand followed channels — automatically clicks "Show More" in the followed channels sidebar

### Settings Panel
- Redesigned settings panel with sidebar navigation (5 categories: Emotes, Chat, Player, Auto, More)
- Master toggle moved to header — always visible, never scrolls with content
- Added settings controls for all 14 new features across their respective categories
- New sub-sections: User Info, Chat Tools, Spam Filtering, Player Controls, Sidebar

### Infrastructure
- Added `host_permissions` for pronouns.alejo.io, gql.twitch.tv, youtube.com, twitchinsights.net
- background.js: pronouns cache (30min TTL), known bots cache (1h TTL), YouTube oEmbed cache (1h TTL)
- injected.js: GQL user card data fetcher (runs in page world for auth token access)
- Version synced to 3.0.0 across manifest.json and panel footer

---

## v2.0.0 — Feature-Complete Release

### Emote Providers
- BTTV, FFZ, and 7TV emote integration with per-channel + global emotes
- 7TV EventAPI (WebSocket) for live emote set updates without page reload
- 7TV cosmetics: username paints (gradients) and custom badges
- Emote tooltip on hover showing emote name and provider

### Chat Enhancements
- Chat timestamps on every message
- Split chat (alternating row backgrounds)
- Alternating user-color backgrounds per username
- Readable color enforcement (adjusts low-contrast username colors)
- First-time chatter highlight (glow on new chatters)
- Mention highlighting (glow when your username is mentioned)
- Show deleted messages (struck-through instead of hidden)
- Keyword highlighting and keyword filtering (hide matching messages)
- Custom nicknames (replace display names per user)
- Spoiler tag support (`||spoiler||` syntax, click to reveal)
- Emote tab-completion (type `:` prefix, pick from dropdown)
- Lurk mode (grey out chat input, show lurk indicator)
- Chat font family and size customization

### Player
- Audio compressor (DynamicsCompressorNode for consistent volume)
- Auto theater mode on channel pages (locale-agnostic selector)
- Theater OLED black background
- Theater transparent chat overlay
- Auto video quality selection
- Disable autoplay on non-channel pages

### Automation
- Auto-claim channel points
- Auto-claim Drops
- Auto-claim Moments

### Moderation
- Quick timeout buttons (1m / 10m / 1h) on hover next to usernames

### Interface
- Hide UI clutter (bits, hype chat, prime promos, streaks, leaderboards)
- Per-channel settings profiles (save/load/delete per channel)
- In-page settings panel with tabbed UI (Emotes, Chat, Player, Auto, Mod, Interface)
- Popup with quick toggles for all features

### Bug Fixes
- Fixed `fetchSevenTvCosmetics` crashing due to calling `.ok`/`.json()` on already-parsed `safeFetch` response
- Fixed settings panel tab bar cropping Mod/Interface tabs (switched from hidden-scrollbar overflow to flex-wrap)
- Used `100dvh` for settings panel height to avoid Safari viewport clipping

### Infrastructure
- CLAUDE.md project guidelines
- safari-extension-reference.md with Live Settings Application and Locale-Agnostic DOM Selectors sections
- Version synced across manifest.json (2.0.0), Xcode MARKETING_VERSION (2.0.0), and panel footer
