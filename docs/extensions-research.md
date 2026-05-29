# Twitch Browser Extensions Research

Research into how popular Twitch browser extensions (BTTV, FFZ, 7TV) implement features, focused on chat width resizing.

## Chat Width Resizing

### BTTV (BetterTTV) — Removed Feature

BTTV **had** a chat resize feature but removed it. From [Discussion #5823](https://github.com/night/betterttv/discussions/5823):

> "Due to complexities around Twitch's channel page resize handling. It's basically unfeasible to resize the chat and have the page render/resize properly due to computed dimensions that Twitch plumbs into the DOM."

BTTV's remaining layout features:
- **Split Chat** (`src/modules/split_chat/`) — alternates background colors on messages, no width manipulation
- **Chat Left Side** (`src/modules/chat_left_side/style.css`) — swaps chat to the left via CSS `order` properties, does not change width

### FrankerFaceZ (FFZ) — Working Implementation

FFZ is the only major extension with a fully working chat width resizer. Source files:
- `src/sites/twitch-twilight/modules/css_tweaks/styles/chat-width.scss`
- `src/sites/twitch-twilight/modules/css_tweaks/styles/chat-fix.scss`
- `src/sites/twitch-twilight/modules/css_tweaks/styles/chat-no-animate.scss`
- `src/sites/twitch-twilight/modules/css_tweaks/styles/player-size.scss`
- `src/sites/twitch-twilight/modules/chat/index.js`
- `src/sites/twitch-twilight/modules/css_tweaks/index.js`

#### Strategy

1. CSS custom property (`--ffz-chat-width`) set on `body` via JS, value in rem (`width / 10`)
2. Remove Twitch's hardcoded constraints
3. Apply new width via CSS variable on both outer and inner column elements
4. Fix player width to account for new chat size
5. Disable transitions and animations that fight the resize

#### JS — Settings and Variable Application

```javascript
// User-facing width setting (pixels, null = default)
this.settings.add('chat.width', {
    default: null,
    ui: {
        path: 'Chat > Appearance >> General',
        title: 'Width',
        description: "How wide chat should be, in pixels.",
        component: 'setting-text-box',
        process(val) {
            val = parseInt(val, 10);
            if (isNaN(val) || !isFinite(val) || val <= 0) return null;
            return val;
        }
    }
});

// Effective width: user value or Twitch default (340px)
this.settings.add('chat.effective-width', {
    requires: ['chat.width', 'context.ui.rightColumnWidth'],
    process(ctx) {
        const val = ctx.get('chat.width');
        return val == null ? (ctx.get('context.ui.rightColumnWidth') || 340) : val;
    }
});

// Boolean: should custom width be applied?
this.settings.add('chat.use-width', {
    requires: ['chat.width', 'context.ui.rightColumnExpanded', 'context.isWatchParty'],
    process(ctx) {
        if (!ctx.get('context.ui.rightColumnExpanded') || ctx.get('context.isWatchParty'))
            return false;
        return ctx.get('chat.width') != null;
    }
});
```

Applying the variable:
```javascript
const width = this.chat.context.get('chat.effective-width');
this.css_tweaks.setVariable('chat-width', `${width / 10}rem`);
this.css_tweaks.setVariable('negative-chat-width', `${-width / 10}rem`);
this.css_tweaks.toggle('chat-width', this.settings.get('chat.use-width'));
```

#### CSS — Core Width Override (`chat-width.scss`)

```scss
/* Remove min-width constraint that locks chat to ~340px */
.chat-shell__expanded {
    min-width: unset !important;
}

/* Fix reward center width */
.reward-center__content {
    width: calc(var(--ffz-chat-width) - 2rem) !important;
}

/* Unset Twitch's computed width on channel root */
.channel-root {
    width: unset !important;
}

/* Fix whisper panel position in theatre mode */
body .whispers--theatre-mode.whispers--right-column-expanded-beside {
    right: var(--ffz-chat-width);
}

/* Fix theatre-mode player */
body .persistent-player--theatre:not([style*="width: 100%"]):not([style*="width: 100vw"]),
body .channel-page__video-player--theatre-mode {
    width: calc(100% - var(--ffz-chat-width)) !important;
}

/* THE CORE: Override width on ALL right-column variants */
body .video-watch-page__right-column,
body .clips-watch-page__right-column,
body .channel-page__right-column,
body .right-column:not(.right-column--collapsed):not(.right-column--below),
body .channel-videos__right-column,
body .channel-clips__sidebar,
body .channel-events__sidebar,
body .channel-follow-listing__right-column,
body .right-column:not(.right-column--collapsed):not(.right-column--below) .channel-root__right-column {
    width: var(--ffz-chat-width) !important;
}

/* VOD chat uses flex-basis instead of width */
.video-chat {
    flex-basis: var(--ffz-chat-width);
}

body .video-chat__sync-button {
    width: calc(var(--ffz-chat-width) - 4rem);
}

body .video-chat {
    -ms-flex-preferred-size: var(--ffz-chat-width);
    flex-basis: var(--ffz-chat-width);
}
```

#### CSS — Chat Fix (`chat-fix.scss`)

Applied when custom width, portrait mode, or sidebar swap is active:

```scss
/* Set explicit width on right column containers */
body .video-watch-page__right-column,
body .clips-watch-page__right-column,
body .channel-page__right-column,
body .right-column:not(.right-column--collapsed):not(.right-column--below),
body .channel-videos__right-column,
body .channel-clips__sidebar,
body .channel-events__sidebar,
body .channel-follow-listing__right-column {
    width: 34rem;
}

/* Fix expanded column positioning — removes transform-based animations */
.channel-root__right-column--expanded {
    position: initial;
    transform: none !important;
}

.toggle-visibility__right-column--expanded {
    transform: none !important;
}

/* Force player and info to 100% width */
.channel-root--hold-chat + .persistent-player,
.channel-root--watch-chat + .persistent-player,
.channel-root__info--with-chat .channel-info-content,
.channel-root__player--with-chat {
    width: 100% !important;
}
```

#### CSS — Disable Transitions (`chat-no-animate.scss`)

```scss
.toggle-visibility__right-column--expanded,
.channel-root__right-column {
    transition: none !important;
}
```

#### CSS — Player Size Fix (`player-size.scss`)

```scss
.channel-root__info--with-chat .channel-info-content,
.channel-root__player--with-chat,
.persistent-player:has(+.channel-root--hold-chat),
.persistent-player:has(+.channel-root--watch-chat) {
    width: 100% !important;
}
```

### BTTV — Chat Left Side CSS (Reference)

Moves chat to the left without resizing. Useful as reference for handling transforms:

```css
.bttv-swap-chat .right-column { order: 1; }
.bttv-swap-chat .twilight-main { order: 2; }
.bttv-swap-chat .side-nav { order: 3; }
.bttv-swap-chat .channel-root__right-column--expanded {
    position: relative !important;
    transform: none !important;
}
.bttv-swap-chat .channel-root__player--with-chat,
.bttv-swap-chat .channel-info-content {
    width: 100% !important;
}
```

## Key Takeaways for Purple Crow

1. **The bottleneck is `.channel-root__right-column`** — Twitch gives it `flex: 0 1 auto` which locks it to 340px. Must be explicitly overridden.
2. **`.chat-shell__expanded` has a `min-width`** that prevents shrinking below 340px. Must be unset.
3. **`.channel-root` has a computed `width`** that constrains everything. Must be unset.
4. **Transitions and transforms fight the resize** — disable them on `.channel-root__right-column` and `.channel-root__right-column--expanded`.
5. **Inner elements (`.chat-shell`, `.stream-chat`, `.chat-room`) inherit the 340px constraint** — they need `width: 100%` to fill the expanded parent.
6. **Theatre mode player** needs `calc(100% - var(--tp-chat-width))` to account for the new width.
7. **Normal mode player** needs `width: 100% !important` on `.channel-root__player--with-chat` — the flex container handles the split.

## Sources

- [BTTV Discussion #5823 — Resizable chat box (removed)](https://github.com/night/betterttv/discussions/5823)
- [FFZ chat-width.scss](https://github.com/FrankerFaceZ/FrankerFaceZ/blob/master/src/sites/twitch-twilight/modules/css_tweaks/styles/chat-width.scss)
- [FFZ chat-fix.scss](https://github.com/FrankerFaceZ/FrankerFaceZ/blob/master/src/sites/twitch-twilight/modules/css_tweaks/styles/chat-fix.scss)
- [FFZ chat/index.js](https://github.com/FrankerFaceZ/FrankerFaceZ/blob/master/src/sites/twitch-twilight/modules/chat/index.js)
- [FFZ css_tweaks/index.js](https://github.com/FrankerFaceZ/FrankerFaceZ/blob/master/src/sites/twitch-twilight/modules/css_tweaks/index.js)
- [FFZ layout.js](https://github.com/FrankerFaceZ/FrankerFaceZ/blob/master/src/sites/twitch-twilight/modules/layout.js)
- [FFZ v4.77.4 commit (player-size fix)](https://github.com/FrankerFaceZ/FrankerFaceZ/commit/b250075813ef4902b5a303fc7290d6429703feef)
- [FFZ Issue #819 — Chat resizing bug (min-width: 34rem)](https://github.com/FrankerFaceZ/FrankerFaceZ/issues/819)
- [BTTV chat_left_side/style.css](https://github.com/night/betterttv/blob/master/src/modules/chat_left_side/style.css)

---

## Favorite User Highlighting

### BTTV — Highlight Implementation

**Detection:** MutationObserver on `.chat-line__message` DOM nodes. Extracts message data from React fiber via `getChatMessageObject()`.

**File:** `src/modules/chat_highlight_blacklist_keywords/index.js`

#### Visual Style

```js
markHighlighted(message, color = undefined) {
    message.classList.add('bttv-highlighted');
    if (color == null) color = '#ff0000';
    const {r, g, b} = colors.getRgb(color);
    message.style.backgroundColor = `rgba(${r}, ${g}, ${b}, 0.3)`;
}
```

```css
.chat-line__message.bttv-highlighted,
.user-notice-line.bttv-highlighted,
.vod-message.bttv-highlighted {
    background-color: rgba(255, 0, 0, 0.3);
}
```

Just a colored background wash at 30% opacity. No border, glow, or badge.

#### Settings / Management

Settings panel table with columns: Color picker, Target dropdown ("Message"/"Username"/"Badge"), Keyword text, Channels (scoped), Delete button.

Stored as `{id, keyword, type, color, channels}` in `browser.storage` under `highlightKeywords`.

```js
KeywordTypes = {
    MESSAGE: 0,
    WILDCARD: 1,
    EXACT: 2,
    USER: 3,
    BADGE: 4,
}
```

No right-click or user-card integration — purely settings-based.

#### Per-User Colors

Yes, each entry has its own color picker. Default is `#ff0000` (red) at 30% opacity.

#### Matching Logic

Supports regex (`~/pattern/flags`), wildcards (`*`), exact match (`<term>`), and word-boundary matching. Case-insensitive. Can be channel-scoped.

#### Pinned Highlights

BTTV has a sticky `#bttv-pin-container` at top of chat showing recent highlighted messages with `background-color: rgba(255, 0, 0, 0.5)` and white text.

---

### FFZ — Highlight Implementation

**Detection:** Monkey-patches Twitch's React component `render()` method. Full access to message data during render.

**Files:**
- `src/sites/twitch-twilight/modules/chat/line.js`
- `src/modules/chat/index.js`
- `src/modules/chat/tokenizers.jsx`

#### Visual Style

```js
// In render():
return e('div', {
    className: `${klass}${msg.mentioned ? ' ffz-mentioned' : ''}${bg_css ? ' ffz-custom-color' : ''}`,
    style: {backgroundColor: bg_css},
    'data-user-id': user?.userID,
    'data-user': user?.lowerLogin,
    ...
}, out);
```

```scss
// Dark theme default (no custom color):
&.ffz-mentioned:not(.ffz-custom-color) {
    background-color: rgba(255,0,0,.2) !important;
}
// Light theme:
&.ffz-mentioned:not(.ffz-custom-color) {
    background-color: rgba(255,127,127,.2) !important;
}
```

Additional visual features:
- **Highlight reason tags** (`ffz-highlight-tags`): pill-shaped labels showing "User", "Badge", "Term", "Mention"
- **Bold matched text**: `<strong class="ffz--highlight">`
- **Viewer card highlighting**: open user card highlights all their messages with `rgba(0,80,255,0.2)` via `[data-user="login"]` CSS

#### Settings / Management

Settings at Chat > Filtering > Highlight >> Users. Each term has:
- `v`: username/pattern
- `t`: type (text, glob, raw regex)
- `c`: optional per-user color
- `p`: numeric priority (higher wins)
- `s`: case sensitivity
- `w`: word boundaries

No user-card "add to highlights" button in base FFZ.

#### Priority System

```js
applyHighlight(msg, priority, color, reason, use_null_color = false) {
    const matched = msg.mention_priority == null || priority >= msg.mention_priority;
    if (matched) {
        msg.mention_priority = priority;
        if (color === false) { // false = remove highlight
            msg.mentioned = false;
            msg.mention_color = msg.highlights = null;
            return;
        }
        msg.mentioned = true;
        if (!msg.highlights) msg.highlights = new Set;
    }
    if (msg.mentioned) {
        msg.highlights.add(reason);
        if (color && (priority > msg.mention_priority || !msg.mention_color))
            msg.mention_color = color;
    }
}
```

Can suppress highlights with zero-alpha color (`#00000000`).

### Comparison

| Feature | BTTV | FFZ |
|---|---|---|
| Hook method | MutationObserver on DOM | Monkey-patches React render() |
| Visual style | `bttv-highlighted` + inline rgba bg | `ffz-mentioned` + `ffz-custom-color` + inline bg |
| Default color | `rgba(255,0,0,0.3)` | `rgba(255,0,0,0.2)` |
| Per-user color | Yes | Yes + priority system |
| Pinned highlights | Yes (sticky banner) | No |
| Highlight reason | No | Yes (pill tags) |
| Matched text bold | No | Yes |
| User card integration | None | Temp highlight via `[data-user]` CSS |
| Channel scoping | Yes | Yes (via profile system) |

### Key Takeaways for Purple Crow

1. **Background color at 20-30% opacity** is the standard approach — both extensions use it
2. **Per-user colors** are expected by power users
3. **MutationObserver on `.chat-line__message`** is the right approach for a Safari extension (can't patch React internals)
4. **`data-user` attributes** on message elements enable powerful CSS-based highlighting without JS per-message
5. **Pinned highlights** (BTTV-style sticky banner) are a nice-to-have but not essential
6. **Highlight reason tags** (FFZ-style pills) add clarity when multiple highlight rules exist

---

## Pinned Mentions

Only BTTV implements pinned highlights. FFZ does not have this feature.

### BTTV — Pinned Highlights Implementation

**Files:**
- `src/modules/chat_highlight_blacklist_keywords/index.js`
- `src/modules/chat_highlight_blacklist_keywords/style.css`

#### Visual Appearance

Red semi-transparent banners stacked at the top of the chat scroll area.

```css
#bttv-pin-container {
  position: sticky;
  top: 0px;
  right: 0px;
  width: 100%;
  box-shadow: 0px 8px 8px -5px #000;
  z-index: 99998;
}

#bttv-pinned-highlight {
  padding: 2px 10px;
  font-weight: bold;
  font-size: 0.8572em;
  color: #fff;
  background-color: rgba(255, 0, 0, 0.5);
}
```

#### DOM Structure

```html
<div id="bttv-pin-container">
  <div id="bttv-pinned-highlight">
    <span class="close"><svg ...x icon.../></span>
    <span class="time">02:15</span>
    <span class="display-name">username</span>
    <span class="message">the full message text</span>
  </div>
  <!-- more pins stack here -->
</div>
```

Container appended as child of `.chat-list .chat-scrollable-area__message-container`.

#### Trigger Logic

Any message matching the highlight system gets pinned:
- @mentions of your username (auto-added as highlight keyword)
- Custom highlight keywords, users, badges
- Reply chains containing highlighted content

Skips: replies, duplicates, messages older than page load time.

#### Dismissal

- **X button**: `container.remove()` on click
- **Auto-timeout**: 60 seconds (configurable via `timeoutHighlights` setting, default: on)

#### Stacking

- Stack vertically inside container
- Max: 10 (configurable 1-25)
- Oldest removed when max exceeded (FIFO)
- Container adjusts `top` offset when Twitch native highlights (hype trains) are present

#### Content

Shows: timestamp (hh:mm) + username + full message text (word-break: break-word). No truncation.

#### No Scroll-to-Message

Clicking a pin does nothing — no scroll to original message feature.

#### Duplicate Prevention

Tracks last 30 highlights as `"timestamp,from,message"` strings. Duplicates skipped. Buffer rolls over (FIFO).

#### Settings Defaults

| Setting | Default |
|---|---|
| `pinnedHighlights` | `false` (disabled) |
| `maxPinnedHighlights` | `10` |
| `timeoutHighlights` | `true` (60s auto-expire) |
| `highlightFeedback` | `false` (sound off) |

### Key Takeaways for Purple Crow

1. **`position: sticky; top: 0`** inside the chat scroll container is the correct positioning
2. **Auto-timeout (60s)** is expected behavior — pins shouldn't persist forever
3. **Max pin limit** prevents UI clutter in busy chats
4. **Duplicate prevention** is important for spammy chats
5. **X button dismissal** is essential UX
6. **Disabled by default** in BTTV — it's an opt-in power feature

## Reply Context / Thread Enhancement

### BTTV — No Enhancement

BTTV does **not** enhance the reply/thread experience. It only provides an option to **hide replies** entirely from chat. No inline expansion, no tooltip, no additional context display.

Relevant issues:
- [#4088](https://github.com/night/betterttv/issues/4088): Request to allow disabling click-to-reply
- [#4485](https://github.com/night/betterttv/issues/4485): Bug — clicking "reply" re-triggers highlight notification and re-pins the message
- [#7720](https://github.com/night/betterttv/issues/7720): Bug — replies to a highlighted user's message get highlighted too

### FFZ — Multiple Reply Styles (React-Level Interception)

FFZ offers two built-in reply display styles via `chat.replies.style` setting:

1. **Style 0 (Disabled)**: No reply UI at all
2. **Style 1 "Twitch" (default)**: Calls Twitch's own `renderReplyLine()` method wrapped in `<div class="ffz--fix-reply-line">`
3. **Style 2 "FFZ"**: Renders an inline `@mention` token before message text with hover tooltip

**How FFZ accesses reply data**: FFZ does NOT use DOM selectors. It hooks into Twitch's React component tree using a custom `fine` library:

```javascript
// Identifies Twitch's ChatLine React component
this.ChatLine = this.fine.define(
    'chat-line',
    n => n.renderMessageBody && n.props && !n.onExtensionNameClick,
    Twilight.CHAT_ROUTES
);

// Replaces the render method entirely
cls.prototype.render = cls.prototype.ffzNewRender;
```

Reply data is read directly from React props (`this.props.reply`), never from the DOM. The FFZ reply token is rendered as:
```jsx
<strong class="chat-line__message-mention ffz--reply-mention ffz-i-threads"
    data-tooltip-type="reply"
    data-login={token.recipient}>
    {token.text}
</strong>
```

FFZ CSS for reply mentions:
```scss
.ffz--reply-mention {
    padding: 0.25rem 0.5rem;
    border-radius: 1rem;
    white-space: nowrap;
    background-color: rgba(255,255,255,0.15); // dark theme
}
```

Feature request [#1632](https://github.com/FrankerFaceZ/FrankerFaceZ/issues/1632) (March 2025): User requested a **third hybrid option** — Twitch display style but with hover tooltip (like 7TV). The tooltip had a white background which clashed with dark theme.

### 7TV — Hover Tooltip (React-Level Interception)

7TV **completely replaces Twitch's chat renderer** with its own Vue-based system. It does NOT detect the reply bar via DOM selectors.

**Interception chain**:
1. Hooks into Twitch's internal React `ChatListComponent` props via `definePropertyHook` to intercept `messageHandlerAPI`
2. Hooks `handleMessage` to intercept every message before rendering — returns empty string to skip Twitch's native render
3. Renders its own Vue component (`0.NormalMessage.vue`) for each message

**Reply data extraction** from Twitch's internal message objects (`msgData.reply`):
```typescript
msg.parent = {
    id: msgData.reply.parentMsgId ?? "",
    uid: msgData.reply.parentUid ?? "",
    deleted: msgData.reply.parentDeleted ?? false,
    body: msgData.reply.parentMessageBody ?? "",
    author: {
        username: msgData.reply.parentUserLogin,
        displayName: msgData.reply.parentDisplayName,
    },
    thread: {
        deleted: msgData.reply.threadParentDeleted,
        id: msgData.reply.threadParentMsgId,
        login: msgData.reply.threadParentUserLogin,
    },
};
```

**Reply bar rendering** in `src/app/chat/msg/0.NormalMessage.vue`:
```html
<div v-if="msgData.reply" class="seventv-reply-part">
    <div class="seventv-chat-reply-icon"><TwChatReply /></div>
    <div v-tooltip="`Replying to @${msgData.reply.parentDisplayName}: ${msgData.reply.parentMessageBody}`"
         class="seventv-reply-message-part">
        {{ `Replying to @${msgData.reply.parentDisplayName}: ${msgData.reply.parentMessageBody}` }}
    </div>
</div>
```

The tooltip (added in PR #457, v3.0.7) is a Vue directive using Floating UI's `computePosition()` — shows on `mouseenter`, hides on `mouseleave`.

7TV CSS classes:
- `.seventv-reply-part` — flex container, `font-size: 1.2rem`, `color: --color-text-alt-2`
- `.seventv-reply-message-part` — truncated with `text-overflow: ellipsis`

### Twitch Internal Reply Data Structure

Both 7TV and FFZ read reply data from Twitch's React internals, not the DOM. The `reply` object on message props contains:

| Field | Description |
|-------|-------------|
| `parentDisplayName` | Display name of the parent message author |
| `parentUserLogin` | Login username of the parent message author |
| `parentMessageBody` | Full text content of the parent message |
| `parentMsgId` | ID of the parent message |
| `parentUid` | User ID of the parent message author |
| `parentDeleted` | Whether the parent message was deleted |
| `threadParentMsgId` | ID of the thread root message |
| `threadParentUserLogin` | Login of the thread root author |
| `threadParentDeleted` | Whether the thread root was deleted |

### Twitch Native DOM Selectors (Reference)

Twitch class names known to FFZ (used for component discovery, not reply detection):

- `.chat-line__message` — individual chat message line
- `.chat-line__message-container` — message container
- `.chat-line__reply-icon` — reply button that appears on hover
- `.chat-scrollable-area__message-container` — scrollable message area
- `section[data-test-selector='chat-room-component-layout']` — chat room layout

**Important**: No major extension detects reply messages via DOM CSS selectors. They all intercept at the React level because Twitch uses CSS modules (dynamic class names) and doesn't expose reply metadata as `data-*` attributes in the DOM.

### Purple Crow Implementation — React Fiber Bridge

Since Purple Crow is a Safari Web Extension (content script), it cannot replace Twitch's React renderer. Instead, we use a **two-layer approach**:

1. **Page-world script** (`injected.js`): Runs in page context with access to React internals. Uses `getReactFiber()` + `findReactProp()` to read `reply` from each chat message's React fiber props. Stamps reply data as `data-tp-reply-*` attributes on DOM elements via MutationObserver.
2. **Content script** (`content.js`): Reads the stamped `data-tp-reply-*` attributes and creates a hover tooltip on the reply bar.

Data attributes stamped by injected.js:
- `data-tp-reply-user` — parent display name
- `data-tp-reply-login` — parent login
- `data-tp-reply-body` — parent message text
- `data-tp-reply-id` — parent message ID
- `data-tp-reply-deleted` — "1" if parent was deleted

### Key Takeaways for Purple Crow

1. **No extension uses DOM selectors for reply detection** — all read React internals
2. **React fiber bridge is the correct pattern** — page-world script reads props, stamps data attributes for content script
3. **7TV hover tooltip is the gold standard UX** — keep Twitch native bar, add tooltip on hover
4. **Tooltip should match dark theme** — white background on dark Twitch was a complaint in FFZ
5. **Three modes are sufficient**: default (Twitch native), tooltip (7TV-style hover), hidden

## Badge Hiding

### Twitch Native Badge DOM Structure

Twitch renders badges as `<button>` elements with `data-a-target="chat-badge"` inside a wrapper `<span class="chat-line__message--badges">`. Each badge button contains an `<img class="chat-badge">` with an `alt` attribute describing the badge (e.g., `alt="Moderator"`, `alt="Subscriber"`).

Badge data in Twitch's React state uses `msg.badges` as key-value pairs:
```javascript
{ "moderator": "1", "subscriber": "3012" }
// keys = badge set IDs, values = version strings
```

Twitch's internal badge type (from 7TV's GQL type definitions):
```typescript
interface TwTypeBadge {
    id: string;
    setID: string;
    title: string;
    version: string;
    image1x: string;
    image2x: string;
    image4x: string;
}
```

### BTTV — All-or-Nothing CSS Toggle

**Source**: `src/modules/disable_badges/index.js`, `style.css`

BTTV provides a single toggle that hides ALL chat badges simultaneously. No per-badge selection. The setting is a flag in a `USERNAMES` bitmask (`BADGES = 1 << 3`).

**Technique**: Toggles a CSS class on `document.body`:
```javascript
document.body.classList.add('bttv-disable-badges');
```

**CSS rule**:
```css
.bttv-disable-badges .chat-scrollable-area__message-container {
    button[data-a-target='chat-badge'] {
        display: none;
    }
}
```

Key selectors BTTV uses for badges:
- `button[data-a-target='chat-badge']` — for hiding
- `.chat-badge` — for finding badge images
- `img.chat-badge[alt="Moderator"]` — targeting specific badge types by alt text

### FFZ — Per-Badge & Per-Category (React-Level Filtering)

**Source**: `src/modules/chat/badges.jsx`, `src/main_menu/components/badge-visibility.vue`

FFZ has the most sophisticated badge hiding. Users can hide individual badges by ID or entire categories.

**Categories**: `m-twitch` (core), `m-social`, `m-tcon` (TwitchCon), `m-game`, `m-other`, `m-ffz`, `m-addon`

**Settings storage**: Object map `{ badge_id: true }` — keys present with truthy values are hidden:
```javascript
this.settings.add('chat.badges.hidden', {
    default: {},
    type: 'object_merge',
    ui: {
        path: 'Chat > Badges >> tabs ~> Visibility',
        component: 'badge-visibility',
    }
});
```

**Technique**: React-level pre-render filtering. FFZ intercepts Twitch's `ChatLine` React component and replaces the render method. Badges are filtered BEFORE any DOM is created:
```javascript
const hidden_badges = this.parent.context.get('chat.badges.hidden') || {};
for (const badge_id in twitch_badges) {
    const is_hidden = hidden_badges[badge_id];
    const cat = bdata && bdata.__cat || 'm-twitch';
    if (!badge_id || is_hidden || (is_hidden == null && hidden_badges[cat]))
        continue;
    // ... render badge
}
```

FFZ renders badges with data attributes for later targeting:
```html
<span class="ffz-tooltip ffz-badge"
    data-tooltip-type="badge"
    data-provider="twitch"
    data-badge="subscriber"
    data-version="3012">
```

Additional badge settings: style (square/rounded/circular), clickable behavior, custom mod/VIP badges per channel, bot badge unification.

### 7TV — Own Badges Only

**Source**: `src/app/chat/Badge.vue`, `src/site/global/GlobalSettings.ts`

7TV only provides a toggle for its own cosmetic badges. There is NO mechanism to hide individual Twitch badges:
```typescript
declareConfig<boolean>("vanity.7tv_Badges", "TOGGLE", {
    path: ["Appearance", "Vanity"],
    label: "7TV Badges",
    hint: "Whether or not to display 7TV Badges",
    defaultValue: true,
});
```

Badge rendering in `UserTag.vue` separates three groups:
```html
<span class="seventv-chat-user-badge-list">
    <Badge type="picture" />   <!-- shared chat profile images -->
    <Badge type="twitch" />    <!-- Twitch native badges (no hiding) -->
    <Badge type="app" />       <!-- 7TV cosmetic badges (toggleable) -->
</span>
```

### Comparison

| Feature | BTTV | FFZ | 7TV |
|---------|------|-----|-----|
| **Granularity** | All-or-nothing | Per-badge + per-category | 7TV badges only |
| **Twitch badge hiding** | Yes (all) | Yes (individual) | No |
| **Technique** | CSS `display: none` | React-level filtering | Conditional Vue render |
| **Key selector** | `button[data-a-target='chat-badge']` | `msg.badges` keys | N/A |
| **Settings storage** | Bitmask flag | Object map `{ id: true }` | Single boolean |

### Purple Crow Implementation — DOM-Level Per-Badge Hiding

Purple Crow uses a hybrid approach: per-badge granularity (like FFZ) but at the DOM level (like BTTV). This avoids React interception complexity while providing individual badge control.

**Selector**: `button[data-a-target='chat-badge']` (same as BTTV) + `img.chat-badge[alt]` for type detection.

**Settings storage**: Object map `{ badge_type: boolean }` — same pattern as FFZ:
```javascript
settings.hiddenBadges = { subscriber: true, turbo: true, predictions: false }
```

**Detection**: Matches badge `alt` text (case-insensitive) against configured hidden types. 10 badge types supported: subscriber, premium (Prime), moderator, vip, bits, sub-gifter, turbo, founder, predictions, hype-train.

**Technique**: `style.display = "none"` on the `<button>` wrapper per message in `processMessage()`.

### Key Takeaways

1. **`button[data-a-target='chat-badge']` is the standard selector** — used by both BTTV and referenced by FFZ
2. **`img.chat-badge[alt]` is the reliable way to identify badge types** — BTTV uses this, and `alt` text is stable across Twitch updates
3. **Per-badge control is more useful than all-or-nothing** — FFZ's granularity is what users expect
4. **CSS hiding (display:none) is simpler and works fine** — React-level filtering is unnecessary when you just want to hide badges

## Emote Favorites & Frequently Used

### BTTV — Frecency Algorithm (Most Sophisticated)

**Source**: `src/modules/emote_menu/stores/emote-menu-store.js`, `src/common/stores/emote-menu-view-store.js`

BTTV uses a **frecency** algorithm (frequency + recency) — not just usage count. Each emote tracks `{ totalUses, recentUses: [timestamps], score }`.

**Scoring algorithm** — timestamps are scored by age buckets:
```javascript
function timestampToScore(timestamp) {
    const diff = Date.now() - timestamp;
    if (diff < 4 * HOUR) return 100;   // used in last 4 hours
    if (diff < DAY) return 80;          // used today
    if (diff < 3 * DAY) return 60;      // used in last 3 days
    if (diff < 7 * DAY) return 40;      // used this week
    if (diff < 30 * DAY) return 20;     // used this month
    if (diff < 90 * DAY) return 10;     // used in last 3 months
    return 0;                            // older than 3 months
}
// Final score: (totalUses × sum_of_timestamp_scores) / num_recent_uses
```

**Limits**: 100 timestamps per emote, 250 total frecent entries. Scores recomputed on load (time decay changes between sessions).

**Two separate sections**: "Favorites" (manually starred, ordered by add order) and "Frequently Used" (auto-tracked, sorted by frecency score).

**Favorites storage**: Array of canonical emote IDs. Toggle via `setFavorite(id, enabled)`.

**Twitch history import**: On first load, reads Twitch's own `localStorage['twilight.emote_picker_history']` to seed frecents with existing usage data.

### FFZ — Favorites Per Provider

**Source**: `src/sites/twitch-twilight/modules/chat/emote_menu.jsx`, `src/modules/chat/emotes.js`

FFZ maintains separate favorite lists per provider type (Twitch, emoji, third-party). Favorites tab with star icon. Ctrl+click to toggle favorite from emote menu.

### 7TV — Simple Favorites Set

**Source**: `src/app/emote-menu/EmoteMenuSet.vue`, `src/app/emote-menu/EmoteMenu.vue`

Favorites stored as `Set<string>` via config `ui.emote_menu.favorites`. Dedicated "FAVORITE" provider tab in emote menu. Click to toggle.

### Comparison

| Feature | BTTV | FFZ | 7TV |
|---------|------|-----|-----|
| **Favorites** | Array of IDs | Per-provider arrays | Set of IDs |
| **Frequently Used** | Frecency (time-decay) | No | No |
| **Scoring** | timestamp buckets × total uses | N/A | N/A |
| **Max entries** | 250 frecents, 100 timestamps/emote | Unlimited | Unlimited |
| **Twitch import** | Yes (localStorage) | No | No |
| **Toggle method** | Right-click | Ctrl+click | Click |

### Purple Crow Implementation — BTTV-Style Frecency

Purple Crow implements BTTV's frecency algorithm with the same time-decay buckets and scoring formula.

**Storage format**: `{ emoteName: { totalUses, recentUses: [timestamps], score } }`

**Limits**: 100 timestamps per emote, 250 total entries (matching BTTV).

**Migration**: Auto-detects old count-based format (`{ name: count }`) and migrates to frecency format on load.

**Scores recomputed on session load** so time decay is applied between sessions — emotes used months ago naturally fall off.

**Two tabs**: Heart (♥) for manual favorites, Star (★) for auto-tracked frecents.
