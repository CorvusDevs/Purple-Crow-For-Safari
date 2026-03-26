# Changelog

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
