# Safari Web Extension Reference

A practical reference for building Safari Web Extensions on macOS/iOS, based on patterns learned from the **Auto Mute Tab For Safari** project.

---

## Table of Contents

1. [Project Structure](#project-structure)
2. [Manifest V3 Configuration](#manifest-v3-configuration)
3. [Architecture: Background + Content Scripts](#architecture-background--content-scripts)
4. [Safari-Specific Gotchas](#safari-specific-gotchas)
5. [DOM-Level Audio Muting](#dom-level-audio-muting)
6. [Page-World Script Injection](#page-world-script-injection)
7. [Cross-Origin Iframe Communication](#cross-origin-iframe-communication)
8. [State Management Patterns](#state-management-patterns)
9. [Picture-in-Picture Detection](#picture-in-picture-detection)
10. [Settings / Options Page](#settings--options-page)
11. [Live Settings Application](#live-settings-application)
12. [Keyboard Shortcuts](#keyboard-shortcuts)
13. [Localization (i18n)](#localization-i18n)
14. [Performance Patterns](#performance-patterns)
15. [Xcode Integration](#xcode-integration)
16. [Common Pitfalls](#common-pitfalls)
17. [Locale-Agnostic DOM Selectors](#locale-agnostic-dom-selectors)
18. [In-Page Settings Panel](#in-page-settings-panel)
19. [Safari WebKit Limitations](#safari-webkit-limitations)
20. [MutationObserver for Lazy-Rendered UI](#mutationobserver-for-lazy-rendered-ui)
21. [Multi-Language Text Matching](#multi-language-text-matching)
22. [Popup as Settings Panel Opener](#popup-as-settings-panel-opener)
23. [Welcome Screen with Platform-Specific Setup Instructions](#welcome-screen-with-platform-specific-setup-instructions)

---

## Project Structure

```
Auto Mute Tab For Safari/
├── Auto Mute Tab For Safari.xcodeproj
├── Shared (App)/
│   └── Resources/
│       ├── Main.html          # Welcome/onboarding page (shown when app launches)
│       ├── Style.css
│       └── Icon.png           # App icon (512px, transparent PNG)
├── Shared (Extension)/
│   └── Resources/
│       ├── manifest.json      # Web extension manifest (Manifest V3)
│       ├── background.js      # Background service worker
│       ├── content.js         # Content script (injected into every page)
│       ├── popup.html/js/css  # Toolbar popup UI
│       ├── settings.html/js/css  # Options/settings page
│       ├── images/            # Extension icons (48, 96, 128, 256, 512)
│       └── _locales/          # i18n strings (15 languages)
│           ├── en/messages.json
│           ├── es/messages.json
│           ├── fr/messages.json
│           └── ... (ar, de, it, ja, ko, nl, pt, ru, th, tr, zh_CN, zh_TW)
├── macOS (App)/               # macOS app target (thin wrapper)
├── macOS (Extension)/         # macOS extension target
├── iOS (App)/                 # iOS app target (thin wrapper)
└── iOS (Extension)/           # iOS extension target
```

The Xcode template creates separate targets for macOS and iOS, but the actual extension code lives entirely in `Shared (Extension)/Resources/`. The native app targets are thin wrappers that host the extension.

---

## Manifest V3 Configuration

Safari uses the standard WebExtensions manifest format. Key fields:

```json
{
    "manifest_version": 3,
    "default_locale": "en",
    "name": "__MSG_extension_name__",
    "description": "__MSG_extension_description__",
    "version": "1.5.0",

    "background": {
        "scripts": ["background.js"],
        "type": "module"
    },

    "content_scripts": [{
        "js": ["content.js"],
        "matches": ["<all_urls>"],
        "all_frames": true,
        "run_at": "document_start"
    }],

    "action": {
        "default_popup": "popup.html",
        "default_icon": { "16": "images/icon-48.png", ... }
    },

    "options_ui": {
        "page": "settings.html",
        "open_in_tab": true
    },

    "commands": {
        "toggle-muting": {
            "suggested_key": {
                "default": "Alt+Shift+M",
                "mac": "MacCtrl+Shift+M"
            },
            "description": "__MSG_shortcut_toggle__"
        }
    },

    "permissions": ["tabs", "storage"]
}
```

### Key notes:
- **`"all_frames": true`** — Required if you need the content script in iframes (e.g., to mute embedded videos).
- **`"run_at": "document_start"`** — Injects before any page JS runs. Critical for monkey-patching constructors.
- **`"type": "module"`** — Background script runs as ES module. Required in Manifest V3.
- **`MacCtrl`** — Maps to the Control key on Mac (not Cmd). Safari reserves Cmd+key combos.
- **`__MSG_key__`** — References `_locales/<lang>/messages.json` for i18n. Works in manifest fields.

---

## Architecture: Background + Content Scripts

### Background script (`background.js`)
- Runs persistently (Safari keeps MV3 backgrounds alive longer than Chrome).
- Manages global state: which tabs are muted, PiP tabs, settings.
- Listens for tab switches, window focus changes, tab updates.
- Sends `mute`/`unmute` messages to content scripts.

### Content script (`content.js`)
- Injected into every page and iframe.
- Directly manipulates DOM: sets `element.muted = true/false` on `<video>` and `<audio>`.
- Injects a page-world script for things the content script can't access (AudioContext, detached Audio elements).
- Reports media playback events back to background.

### Communication flow:
```
background.js  <->  content.js  <->  page-world script
     |                                    |
  popup.js                          DOM media elements
  settings.js                       AudioContext instances
```

Messages use `browser.runtime.sendMessage()` (content <-> background) and `CustomEvent` (content <-> page-world).

---

## Safari-Specific Gotchas

### 1. No `tabs.mutedInfo` API
Safari does not support `chrome.tabs.update(tabId, { muted: true })`. You must mute audio at the DOM level by setting `element.muted = true` on every `<video>` and `<audio>` element.

### 2. Use `browser.*` not `chrome.*`
Safari supports the `browser.*` namespace with Promise-based APIs. While `chrome.*` with callbacks also works, `browser.*` is cleaner and preferred.

### 3. Content scripts lose state on reload
When a tab reloads, the content script is re-injected fresh. Any mute state is lost. Solution: have the content script query the background on load:
```js
browser.runtime.sendMessage({ action: "getMuteState" }).then((response) => {
    if (response && response.mute !== undefined) {
        setMuteState(response.mute);
    }
}).catch(() => {});
```
And have the background track muted tabs in a `Set` and re-send state on `onUpdated` with `status === "complete"`.

### 4. `tabs.query()` is async
Every `tabs.query()` call is a Promise. In rapid tab-switching scenarios, multiple calls can be in flight simultaneously. Use a generation counter to discard stale results:
```js
let switchGeneration = 0;

async function handleTabSwitch() {
    const thisGeneration = ++switchGeneration;
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (thisGeneration !== switchGeneration) return; // stale
    // ... proceed
}
```

### 5. Message errors are normal
`browser.tabs.sendMessage()` throws if the content script isn't loaded yet (e.g., new tab, about: pages, extension pages). Always append `.catch(() => {})`.

### 6. `windows.onFocusChanged` fires `WINDOW_ID_NONE`
When no window has focus (e.g., user clicked on Dock), `windowId` is `browser.windows.WINDOW_ID_NONE`. Guard against this.

### 7. Extension pages don't get content scripts
Safari does not inject content scripts into `safari-web-extension://` pages (popup, settings). This is expected behavior.

### 8. `audible` property on tabs
Safari supports `changeInfo.audible` in `tabs.onUpdated`, but it can be unreliable for detecting exactly when audio starts. Supplement with content script detection (`play` events).

### 9. `browser.i18n.getMessage()` can be unavailable in popups
`browser.i18n.getMessage()` may return `undefined` or empty strings in popup and settings page contexts, even when `_locales/` files are correctly bundled. This appears to be a Safari-specific issue — the API works fine in background scripts and content scripts, but can silently fail in extension UI pages. **Always wrap i18n calls with a fallback**:
```js
const fallback = {
    popup_title: "Auto Mute",
    enabled: "Enabled",
    disabled: "Disabled",
    // ... all keys your UI needs
};

function i18n(key) {
    try {
        const msg = browser.i18n.getMessage(key);
        if (msg) return msg;
    } catch (e) {}
    return fallback[key] || key;
}
```

### 10. Don't use `type="module"` for popup/settings scripts
Using `<script type="module">` in popup or settings HTML can cause `browser.*` APIs to be unavailable or behave unexpectedly. Use `<script src="popup.js" defer></script>` instead. The `defer` attribute gives you the same deferred-loading behavior without the module context issues. Note: `"type": "module"` in `manifest.json` for the background script is fine — this issue is specific to HTML page scripts.

---

## DOM-Level Audio Muting

Since Safari lacks the `tabs.mutedInfo` API, muting is done at the DOM level:

```js
function setMuteState(mute) {
    // DOM media elements
    const mediaElements = document.querySelectorAll("video, audio");
    for (const el of mediaElements) {
        el.muted = mute;
    }

    // Set attribute for page-world script to read
    document.documentElement.setAttribute("data-automute-state", mute ? "muted" : "unmuted");

    // Notify page-world script for AudioContext + detached elements
    document.dispatchEvent(new CustomEvent("automute-set-state", {
        detail: { mute }
    }));
}
```

### Enforcement timer
Some sites (e.g., YouTube) re-set `muted = false` after you mute them. Use a periodic enforcement timer that only runs while muting is active:
```js
let enforceInterval = null;
function startEnforcement() {
    if (enforceInterval) return;
    enforceInterval = setInterval(() => {
        for (const el of document.querySelectorAll("video, audio")) {
            if (!el.muted) el.muted = true;
        }
    }, 2000);
}
function stopEnforcement() {
    if (enforceInterval) {
        clearInterval(enforceInterval);
        enforceInterval = null;
    }
}
```

### MutationObserver for dynamic elements
Websites add media elements dynamically (e.g., infinite-scroll feeds). Watch for them:
```js
const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            if (node.tagName === "VIDEO" || node.tagName === "AUDIO") {
                node.muted = shouldMute;
            }
            const nested = node.querySelectorAll?.("video, audio");
            if (nested) {
                for (const el of nested) el.muted = shouldMute;
            }
        }
    }
});
observer.observe(document.documentElement, { childList: true, subtree: true });
```

---

## Page-World Script Injection

Content scripts run in an isolated world and cannot access page-level JS objects like `AudioContext` or `new Audio()`. To intercept these, inject a script into the page world:

```js
const pageScript = `(function() {
    // Monkey-patch AudioContext
    const OrigAudioContext = window.AudioContext || window.webkitAudioContext;
    if (OrigAudioContext) {
        const PatchedAudioContext = function(...args) {
            const ctx = new OrigAudioContext(...args);
            trackedContexts.add(ctx);
            if (document.documentElement.getAttribute("data-automute-state") === "muted") {
                ctx.suspend().catch(() => {});
            }
            return ctx;
        };
        PatchedAudioContext.prototype = OrigAudioContext.prototype;
        Object.defineProperty(PatchedAudioContext, "name", { value: "AudioContext" });
        window.AudioContext = PatchedAudioContext;
    }

    // Monkey-patch Audio constructor
    const OrigAudio = window.Audio;
    const PatchedAudio = function(src) {
        const el = new OrigAudio(src);
        trackedDetached.add(el);
        if (document.documentElement.getAttribute("data-automute-state") === "muted") {
            el.muted = true;
        }
        return el;
    };
    PatchedAudio.prototype = OrigAudio.prototype;
    window.Audio = PatchedAudio;

    // Monkey-patch HTMLMediaElement.play
    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function() {
        if (document.documentElement.getAttribute("data-automute-state") === "muted") {
            this.muted = true;
        }
        return origPlay.call(this);
    };
})();`;

// Inject before any page JS runs (content script runs at document_start)
const scriptEl = document.createElement("script");
scriptEl.textContent = pageScript;
(document.documentElement || document).prepend(scriptEl);
scriptEl.remove();
```

### Communication between worlds
Content script (extension world) and page-world script communicate via DOM:
- **Data attribute**: `document.documentElement.getAttribute("data-automute-state")` — page-world reads initial state.
- **CustomEvent**: Content script dispatches `automute-set-state` event; page-world listens for it.

### Memory management
Track detached Audio/AudioContext instances in Sets. Prune periodically:
```js
setInterval(() => {
    for (const el of trackedDetached) {
        if (el.paused || el.ended) trackedDetached.delete(el);
    }
    for (const ctx of trackedContexts) {
        if (ctx.state === "closed") trackedContexts.delete(ctx);
    }
}, 30000);
```

---

## Cross-Origin Iframe Communication

Content scripts run in iframes when `"all_frames": true`, but cross-origin iframes can't communicate directly. Use `postMessage`:

```js
// Top frame: relay mute state to all child iframes
if (window === window.top) {
    const iframes = document.querySelectorAll("iframe");
    for (const iframe of iframes) {
        try {
            iframe.contentWindow.postMessage({
                type: "automute-relay",
                mute: mute
            }, "*");
        } catch (e) {}
    }
}

// Iframe: listen for relay messages
if (window !== window.top) {
    window.addEventListener("message", (e) => {
        if (e.data && e.data.type === "automute-relay") {
            setMuteState(e.data.mute);
        }
    });
}
```

Also relay to dynamically added iframes via the MutationObserver.

---

## State Management Patterns

### Background state
```js
let enabled = true;                    // Extension on/off
const pipTabs = new Set();             // Tabs with active PiP
const mutedTabs = new Set();           // Tabs we've sent "mute" to
let switchGeneration = 0;              // Race condition guard
let settings = { ...defaultSettings }; // User preferences
```

### Persistence
Use `browser.storage.local` for state that survives extension restart:
```js
// Save
browser.storage.local.set({ enabled, settings });

// Load on startup
browser.storage.local.get(["enabled", "settings"]).then((result) => {
    if (result.enabled !== undefined) enabled = result.enabled;
    if (result.settings) settings = { ...defaultSettings, ...result.settings };
});
```

### Clean up on tab close
```js
browser.tabs.onRemoved.addListener((tabId) => {
    pipTabs.delete(tabId);
    mutedTabs.delete(tabId);
});
```

### Settings communication
Settings page talks to background via messages:
```js
// settings.js -> background.js
browser.runtime.sendMessage({ action: "getSettings" });
browser.runtime.sendMessage({ action: "updateSettings", settings: { ... } });

// background.js handler
if (request.action === "updateSettings") {
    settings = { ...defaultSettings, ...request.settings };
    browser.storage.local.set({ settings });
    if (enabled) handleTabSwitch(); // Re-evaluate with new settings
    return Promise.resolve({ settings });
}
```

---

## Picture-in-Picture Detection

PiP is detected in the content script (top frame only) and reported to background:

```js
// content.js — only in top frame to avoid duplicates
if (window === window.top) {
    document.addEventListener("enterpictureinpicture", () => {
        browser.runtime.sendMessage({ action: "pipEntered" }).catch(() => {});
    }, true);

    document.addEventListener("leavepictureinpicture", () => {
        browser.runtime.sendMessage({ action: "pipExited" }).catch(() => {});
    }, true);
}
```

Background tracks PiP tabs and exempts them from muting when the setting is enabled:
```js
function isExempt(tab) {
    if (pipTabs.has(tab.id) && settings.pipExempt) return true;
    if (isWhitelisted(tab)) return true;
    return false;
}
```

---

## Settings / Options Page

### Manifest entry
```json
"options_ui": {
    "page": "settings.html",
    "open_in_tab": true
}
```

### Opening from popup
```js
browser.runtime.openOptionsPage();
```

### Settings page pattern
1. On load, fetch settings from background via `getSettings` message.
2. On toggle/input change, send `updateSettings` message.
3. Background saves to `browser.storage.local` and re-evaluates tab states.

### Domain whitelist with input sanitization
```js
function addDomain() {
    let domain = domainInput.value.trim().toLowerCase();
    if (!domain) return;

    // Handle full URL pasted by user
    try {
        if (domain.includes("://")) {
            domain = new URL(domain).hostname;
        }
    } catch (e) {}

    domain = domain.replace(/^www\./, "");

    if (domain && !currentSettings.whitelistedDomains.includes(domain)) {
        currentSettings.whitelistedDomains.push(domain);
        saveSettings();
        renderDomainList();
    }
}
```

### Whitelist matching with subdomain support
```js
function isWhitelisted(tab) {
    if (!tab || !tab.url || settings.whitelistedDomains.length === 0) return false;
    try {
        const hostname = new URL(tab.url).hostname.replace(/^www\./, "");
        return settings.whitelistedDomains.some((domain) =>
            hostname === domain || hostname.endsWith("." + domain)
        );
    } catch (e) {
        return false;
    }
}
```

---

## Live Settings Application

Users expect setting changes to take effect immediately — no page reload. This requires a coordinated flow between the popup/settings UI, background script, and content script.

### The pattern

```
User toggles setting
        │
        ▼
Popup / Settings Panel ──► background.js (save to storage)
        │                        │
        ▼                        ▼
  applySettingChange()      browser.tabs.sendMessage()
  (same-page, instant)      to all matching tabs
                                 │
                                 ▼
                            content.js receives message
                            ──► updates local settings cache
                            ──► calls applySettingChange()
```

### Step 1: Popup saves and notifies content scripts

When a toggle changes in the popup, save via background and then send the updated settings to every relevant tab:

```js
// popup.js
async function saveSettings() {
    try {
        await browser.runtime.sendMessage({
            action: "updateSettings",
            settings: currentSettings,
        });
        // Notify content scripts of the change
        const tabs = await browser.tabs.query({ url: "*://*.example.com/*" });
        for (const tab of tabs) {
            browser.tabs.sendMessage(tab.id, {
                action: "settingsUpdated",
                settings: currentSettings,
            }).catch(() => {});
        }
    } catch (e) {
        console.error("Failed to save settings:", e);
    }
}
```

### Step 2: Content script handles setting changes

The content script receives the message, diffs the old and new settings, and applies each change:

```js
// content.js
browser.runtime.onMessage.addListener((message) => {
    if (message.action === "settingsUpdated" && message.settings) {
        const oldSettings = { ...settings };
        settings = message.settings;
        // Apply each changed key
        for (const key of Object.keys(settings)) {
            if (settings[key] !== oldSettings[key]) {
                applySettingChange(key, settings[key]);
            }
        }
    }
});
```

### Step 3: `applySettingChange()` maps keys to DOM actions

A single switch statement maps every setting key to its corresponding imperative action:

```js
function applySettingChange(key, value) {
    switch (key) {
        // CSS-class toggles
        case "hideClutter":
            document.body.classList.toggle("my-ext-hide-clutter", !!value);
            break;

        // Start/stop timers
        case "autoClaimPoints":
            if (value) startAutoClaim(); else stopAutoClaim();
            break;

        // Dispatch to page-world script via CustomEvent
        case "audioCompressor":
            document.dispatchEvent(new CustomEvent(
                value ? "ext-enable-compressor" : "ext-disable-compressor"
            ));
            break;

        // Re-fetch data
        case "bttvEmotes":
        case "ffzEmotes":
            if (currentChannelId) loadEmotes(currentChannelId);
            break;
    }
}
```

### In-page settings panel (same-page apply)

If your extension has an in-page settings panel (not just the popup), the toggle handler can call `applySettingChange()` directly — no message round-trip needed:

```js
async function onSettingToggle(key, value) {
    settings[key] = value;

    // Persist via background
    await browser.runtime.sendMessage({
        action: "updateSettings",
        settings: { [key]: value },
    }).catch(() => {});

    // Apply immediately on this page
    applySettingChange(key, value);
}
```

### Categories of live-apply actions

| Action type | Example | How to apply |
|---|---|---|
| CSS body-class toggle | Hide UI clutter, dark mode | `document.body.classList.toggle("class", value)` |
| Start/stop a timer | Auto-claim, enforcement loop | Call init/teardown functions |
| Re-process existing DOM | Timestamps, split chat colors | Query existing elements and re-apply |
| Page-world feature | Audio compressor, quality | Dispatch `CustomEvent` to injected.js |
| Re-fetch data | Emote provider toggle | Call loader with current context |
| Font/style change | Chat font family/size | Inject or update a `<style>` element |

### Key principles

- **Never require a page reload.** Every setting must have a live-apply path.
- **Keep `applySettingChange()` idempotent.** Calling it twice with the same value should be safe.
- **Handle the "initial apply" case.** On page load or SPA navigation, call `applySettingChange()` for each active setting to set up the initial state. This reuses the same code path as live toggles.
- **Use body classes for CSS-only features.** Toggle a class on `document.body` and let CSS rules handle the rest — no JS DOM walking needed.
- **Dispatch `CustomEvent` for page-world features.** Content scripts can't directly call functions in injected.js, so use events as the bridge.

---

## Keyboard Shortcuts

### Manifest declaration
```json
"commands": {
    "toggle-muting": {
        "suggested_key": {
            "default": "Alt+Shift+M",
            "mac": "MacCtrl+Shift+M"
        },
        "description": "__MSG_shortcut_toggle__"
    }
}
```

### Handler in background
```js
browser.commands.onCommand.addListener((command) => {
    if (command === "toggle-muting") {
        enabled = !enabled;
        browser.storage.local.set({ enabled });
        if (enabled) {
            handleTabSwitch();
        } else {
            mutedTabs.clear();
            switchGeneration++;
            browser.tabs.query({}).then((tabs) => {
                for (const tab of tabs) {
                    browser.tabs.sendMessage(tab.id, { action: "unmute" }).catch(() => {});
                }
            });
        }
    }
});
```

### Display shortcut in popup
```js
browser.commands.getAll().then((commands) => {
    const toggleCmd = commands.find((c) => c.name === "toggle-muting");
    if (toggleCmd && toggleCmd.shortcut) {
        shortcutHint.innerHTML = label + " <kbd>" + toggleCmd.shortcut + "</kbd>";
    }
}).catch(() => {});
```

### Safari-specific key notes
- `MacCtrl` = physical Control key (not Cmd).
- Safari reserves most Cmd-based shortcuts. Use `MacCtrl+Shift+<key>`.
- Users can customize shortcuts in Safari > Settings > Extensions > Shortcuts.

---

## Localization (i18n)

### Directory structure
```
_locales/
├── en/messages.json      # Default (required)
├── es/messages.json      # Spanish
├── fr/messages.json      # French
├── de/messages.json      # German
├── it/messages.json      # Italian
├── pt/messages.json      # Portuguese
├── nl/messages.json      # Dutch
├── ru/messages.json      # Russian
├── ja/messages.json      # Japanese
├── ko/messages.json      # Korean
├── zh_CN/messages.json   # Chinese (Simplified)
├── zh_TW/messages.json   # Chinese (Traditional)
├── ar/messages.json      # Arabic
├── th/messages.json      # Thai
└── tr/messages.json      # Turkish
```
Note: Safari uses underscore for regional locales (`zh_CN`, `zh_TW`), not hyphens.

### Message format
```json
{
    "extension_name": {
        "message": "Auto Mute Tab For Safari",
        "description": "The display name for the extension."
    },
    "popup_description": {
        "message": "Mutes all tabs except the one you're focused on.",
        "description": "Description shown in the popup."
    }
}
```

### Usage in manifest (static)
```json
"name": "__MSG_extension_name__",
"description": "__MSG_extension_description__"
```

### Usage in JavaScript (runtime) — with required fallback
`browser.i18n.getMessage()` can silently fail in Safari popup/settings pages (see Gotcha #9). Always use a safe wrapper:
```js
// Define English fallbacks for every key your UI uses
const fallback = {
    popup_title: "Auto Mute",
    popup_description: "Mutes all tabs except the one you're focused on.",
    enabled: "Enabled",
    disabled: "Disabled",
    settings: "Settings",
    shortcut_label: "Shortcut:"
};

// Safe i18n wrapper — returns localized string or English fallback
function i18n(key) {
    try {
        const msg = browser.i18n.getMessage(key);
        if (msg) return msg;
    } catch (e) {}
    return fallback[key] || key;
}

// Use it throughout your UI code
document.querySelector(".title").textContent = i18n("popup_title");
document.getElementById("pipDesc").textContent = i18n("pip_exemption_desc");
```

### Localization in HTML
HTML files use placeholder text that gets replaced by JS on load. Do not use `__MSG_key__` in HTML files — that syntax only works in `manifest.json` and CSS. Keep meaningful English defaults in the HTML so the UI is never blank even if JS fails.

### Tips
- `default_locale` in manifest must match an `_locales/` directory.
- Safari picks the locale based on the system language. There's no API to force a language.
- Keep the `"description"` field in the English file — it helps translators but is ignored at runtime.
- Every locale file must have the same set of keys. Missing keys fall back to `default_locale`.
- **Always provide English fallbacks in JS** — don't trust that `browser.i18n` will work in every context (see Gotcha #9).

---

## Performance Patterns

### 1. Lazy enforcement timer
Only run the periodic mute-enforcement interval when actually muting. Stop it when unmuting:
```js
if (mute) startEnforcement();
else stopEnforcement();
```

### 2. Debounced media notifications
Multiple play/volumechange events fire rapidly (e.g., scrolling a Twitter feed). Debounce:
```js
let mediaStartedTimer = null;
function notifyMediaStarted() {
    if (mediaStartedTimer) return;
    mediaStartedTimer = setTimeout(() => { mediaStartedTimer = null; }, 500);
    browser.runtime.sendMessage({ action: "mediaStarted" }).catch(() => {});
}
```

### 3. Generation counter for race conditions
Rapid tab switching causes multiple `handleTabSwitch()` calls. The generation counter ensures only the latest one takes effect:
```js
const thisGeneration = ++switchGeneration;
// ... async work ...
if (thisGeneration !== switchGeneration) return; // stale
```

### 4. Minimize `tabs.query()` calls
Cache the active tab ID when possible. Avoid querying all tabs unless you need to mute them all.

### 5. Don't re-mute already-muted tabs
Before sending a mute message, check if the tab is already in `mutedTabs`:
```js
if (!mutedTabs.has(tab.id)) {
    mutedTabs.add(tab.id);
    browser.tabs.sendMessage(tab.id, { action: "mute" }).catch(() => {});
}
```

### 6. Detached element pruning
Periodically clean up references to ended/paused detached Audio elements to prevent memory leaks (see page-world script section).

---

## Xcode Integration

### Targets
The Xcode project has 4 targets:
- **macOS (App)** / **iOS (App)** — Host apps (minimal, just tell users to enable the extension)
- **macOS (Extension)** / **iOS (Extension)** — The actual extension bundles

### Version management
- `manifest.json` `"version"` — The extension version shown in Safari
- Xcode `MARKETING_VERSION` — The app version shown in App Store / Finder
- Keep both in sync manually. Xcode's project file (`.pbxproj`) can be edited, but not while Xcode is open.

### Build and test
- Build from Xcode (Cmd+B) or use `xcodebuild` CLI.
- After building, enable the extension in Safari > Settings > Extensions.
- During development, enable "Allow Unsigned Extensions" in Safari > Develop menu.
- Inspect extension pages (popup, background, content scripts) via Safari > Develop > Web Extension Background Pages.

### Debugging
- **Background script**: Safari > Develop > Web Extension Background Pages > your extension
- **Content script**: Safari > Develop > [device/page] > your page (content script context is available)
- **Popup**: Click the extension icon, then right-click > Inspect Element
- Use `console.log()` / `console.error()` freely — they show up in the respective Web Inspector.

---

## Common Pitfalls

### 1. Forgetting to track state before sending messages
Always update your tracking Set *before* sending the message. Otherwise, if the tab reloads before the message arrives, you lose track:
```js
// Wrong:
browser.tabs.sendMessage(tabId, { action: "mute" });
mutedTabs.add(tabId);

// Right:
mutedTabs.add(tabId);
browser.tabs.sendMessage(tabId, { action: "mute" }).catch(() => {});
```

### 2. PiP exit without re-muting
When a tab exits PiP and is not the active tab, you need to explicitly mute it again — it was exempt while in PiP:
```js
if (request.action === "pipExited" && sender.tab) {
    pipTabs.delete(sender.tab.id);
    // Must re-mute if not active and not whitelisted
    browser.tabs.query({ active: true, currentWindow: true }).then((activeTabs) => {
        const activeTabId = activeTabs.length > 0 ? activeTabs[0].id : null;
        if (sender.tab.id !== activeTabId && !isWhitelisted(sender.tab)) {
            mutedTabs.add(sender.tab.id);
            browser.tabs.sendMessage(sender.tab.id, { action: "mute" }).catch(() => {});
        }
    });
}
```

### 3. Not handling `WINDOW_ID_NONE`
```js
browser.windows.onFocusChanged.addListener((windowId) => {
    if (windowId === browser.windows.WINDOW_ID_NONE) return; // No window focused
    // ...
});
```

### 4. Duplicate PiP events from iframes
PiP events bubble up from iframes. If you listen in every frame, you'll get duplicate notifications. Only listen in the top frame:
```js
if (window === window.top) {
    document.addEventListener("enterpictureinpicture", () => { ... }, true);
}
```

### 5. `tabs.sendMessage` to unloaded tabs
New tabs, `about:blank`, and extension pages don't have content scripts. Always `.catch(() => {})`.

### 6. Muting a tab that's still loading
If you send `mute` to a tab that's still loading, the content script may not be ready. Use `tabs.onUpdated` with `status === "complete"` to re-apply mute state after navigation.

### 7. Race condition: disable then immediately re-enable
When disabling, increment `switchGeneration` to cancel any in-flight `handleTabSwitch()`:
```js
mutedTabs.clear();
switchGeneration++; // cancel in-flight calls
browser.tabs.query({}).then(tabs => { /* unmute all */ });
```

### 8. Using `type="module"` in popup/settings HTML
`<script type="module">` in popup or settings pages can break `browser.*` API access. Symptoms: `browser.i18n` returns undefined, `browser.runtime.sendMessage` fails silently, UI shows blank text or "undefined". Fix: use `<script src="file.js" defer></script>` instead. This does not affect `"type": "module"` in `manifest.json` for the background script.

### 9. Blank popup UI from i18n failures
If your popup shows blank text where localized strings should be, the `browser.i18n` API is likely failing silently. This is hard to debug because the popup closes when you try to inspect it. Always use the safe `i18n()` wrapper with English fallbacks (see Gotcha #9 in Safari-Specific Gotchas), and keep meaningful default text in the HTML as a last resort.

---

## Locale-Agnostic DOM Selectors

When your extension interacts with the host page's UI (clicking buttons, reading labels, finding elements), **never use English text in selectors**. Most SPAs localize `aria-label`, button text, and tooltip values based on the user's system language.

### The problem

```js
// BROKEN: only works in English
document.querySelector('button[aria-label="Theatre Mode (alt+t)"]');

// In Spanish this becomes "Modo cine (alt+t)" — selector fails silently
// In German: "Theatermodus (Alt+T)"
// In Japanese: "シアターモード (alt+t)"
```

### The solution: match language-neutral substrings

```js
// CORRECT: keyboard shortcut hint "alt+t" is consistent across all locales
document.querySelector('button[aria-label*="alt+t"]');
```

### Selector priority order

Use this priority when targeting host-page elements:

1. **`data-*` attributes** — `data-a-target`, `data-test-selector`, `data-testid`. These are set by developers for testing and are language-independent. However, sites may remove them over time.

2. **`aria-label` with language-neutral substrings** — Keyboard shortcut hints like `"alt+t"`, `"ctrl+m"`, icon names, or emoji are often consistent across translations. Use `*=` (contains) matching, not `=` (exact).

3. **Structural CSS selectors** — `.parent > :nth-child(n) button`, `.container button:last-of-type`. These don't depend on text content but are fragile if the DOM structure changes.

4. **Class names** — Stable BEM-style classes are safe. Avoid Styled Components hashes (`sc-abc123-4`) or obfuscated classes that change every deploy.

5. **Text content / full `aria-label` strings** — **Last resort only.** These break for every non-English user.

### Always use a fallback chain

Sites remove selectors over time. Use a priority chain so the first working selector wins:

```js
const btn = document.querySelector('button[aria-label*="alt+t"]')        // locale-agnostic
    || document.querySelector('[data-a-target="player-theatre-mode-button"]') // data attribute
    || document.querySelector('button[aria-label*="Theatre Mode"]')           // English fallback
    || document.querySelector('button[aria-label*="Theater Mode"]');          // US English variant
```

### Debugging locale issues

When a DOM interaction doesn't work, dump all candidate elements and their attributes:
```js
document.querySelectorAll('.player-controls button').forEach(btn => {
    console.log('aria-label:', btn.getAttribute('aria-label'),
                'data-a-target:', btn.getAttribute('data-a-target'));
});
```
This immediately reveals whether your selector is matching the wrong attribute value due to localization.

---

## In-Page Settings Panel

For extensions with many settings, an in-page settings panel (injected into the target site) is more convenient than a popup. A sidebar navigation layout scales well as features grow.

### Recommended layout

```
┌─────────────────────────────────────────┐
│  Logo  Title              [ON/OFF]  ✕   │  ← Fixed header with master toggle
├──────────┬──────────────────────────────┤
│ Category │  SECTION TITLE               │
│ Category │  ┌───────────────────────┐   │
│ Category │  │ Toggle / select row   │   │  ← Scrollable content area
│ Category │  │ Toggle / select row   │   │
│ ...      │  └───────────────────────┘   │
├──────────┴──────────────────────────────┤
│            Extension v1.0.0             │  ← Fixed footer
└─────────────────────────────────────────┘
```

**Why sidebar navigation over tabs:** Horizontal tab bars overflow when you have more than 4–5 categories. A vertical sidebar (icon + label, ~90px wide) scales to many categories without wrapping or scrollbar hacks.

### DOM structure

```js
function createSettingsPanel() {
    const panel = document.createElement("div");
    panel.className = "my-ext-settings-panel";

    // ── Header (logo + title + master toggle + close) ──
    const header = document.createElement("div");
    header.className = "my-ext-panel-header";
    // ... logo, title h3, master toggle switch, close button
    panel.appendChild(header);

    // ── Sidebar layout (nav + content) ──
    const layout = document.createElement("div");
    layout.className = "my-ext-sidebar-layout"; // display: flex

    // Left sidebar with category buttons
    const sidebar = document.createElement("div");
    sidebar.className = "my-ext-sidebar"; // flex-direction: column, ~90px

    const categories = [
        { id: "general", label: "General", icon: "..." },
        { id: "chat", label: "Chat", icon: "..." },
        // ...
    ];

    const categoryContents = {};
    let activeId = categories[0].id;

    function switchCategory(id) {
        sidebar.querySelectorAll(".my-ext-sidebar-btn").forEach(btn =>
            btn.classList.toggle("active", btn.dataset.category === id));
        Object.entries(categoryContents).forEach(([cid, el]) =>
            el.classList.toggle("visible", cid === id));
    }

    categories.forEach(cat => {
        const btn = document.createElement("button");
        btn.className = "my-ext-sidebar-btn";
        btn.dataset.category = cat.id;
        btn.innerHTML = cat.icon + `<span>${cat.label}</span>`;
        btn.addEventListener("click", () => switchCategory(cat.id));
        sidebar.appendChild(btn);
    });
    layout.appendChild(sidebar);

    // Right scrollable content
    const content = document.createElement("div");
    content.className = "my-ext-sidebar-content"; // flex: 1, overflow-y: auto

    // Build category content containers (only one visible at a time)
    // ... append toggle rows, select rows, section titles
    layout.appendChild(content);
    panel.appendChild(layout);

    // ── Footer ──
    const footer = document.createElement("div");
    footer.className = "my-ext-panel-footer";
    panel.appendChild(footer);

    return panel;
}
```

### CSS skeleton

```css
/* Panel — fixed sidebar from right edge */
.my-ext-settings-panel {
    position: fixed;
    top: 0; right: 0;
    width: 380px;
    height: 100vh; height: 100dvh; /* Safari viewport fix */
    display: flex;
    flex-direction: column;
    z-index: 9999;
    animation: slide-in 0.25s cubic-bezier(0.16, 1, 0.3, 1);
}

/* Header — always visible, contains master toggle */
.my-ext-panel-header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px;
    flex-shrink: 0;
}

/* Two-column body */
.my-ext-sidebar-layout {
    display: flex;
    flex: 1;
    min-height: 0; /* critical for overflow to work */
}

/* Left sidebar nav */
.my-ext-sidebar {
    width: 88px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px 6px;
    overflow-y: auto;
}

/* Sidebar buttons — icon stacked above label */
.my-ext-sidebar-btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
    padding: 8px 4px;
    border: none;
    border-radius: 8px;
    font-size: 10px;
    cursor: pointer;
}

/* Right scrollable content */
.my-ext-sidebar-content {
    flex: 1;
    overflow-y: auto;
    min-width: 0;
}

/* Category containers — show/hide */
.my-ext-category { display: none; }
.my-ext-category.visible { display: block; }
```

### Key principles

- **Master toggle in the header.** The extension on/off switch must always be visible and not scroll with content. Place it in the header row.
- **Use `100dvh` for panel height.** Safari's `100vh` can extend behind the dynamic toolbar on iOS. The `100dvh` fallback-after-`100vh` pattern handles this.
- **`min-height: 0` on the flex container.** Without this, the sidebar layout won't allow the content area to scroll properly.
- **Backdrop + click-outside to close.** Add a semi-transparent backdrop behind the panel. Clicking it or pressing Escape closes the panel. For HTML `<dialog>` elements using `.showModal()`, listen for clicks where `e.target === dialog` (the backdrop area) and call `dialog.close()`. Apply this to all dialogs at init time with a single loop:
  ```js
  document.querySelectorAll("dialog").forEach(dialog => {
      dialog.addEventListener("click", (e) => {
          if (e.target === dialog) dialog.close();
      });
  });
  ```
  Requires `padding: 0` on the `<dialog>` element so clicks on the visible panel hit child elements, not the dialog itself.
- **Backdrop blur for depth.** Use `backdrop-filter: blur()` on the dialog backdrop to create visual depth separation between the panel and the page content behind it. The `-webkit-` prefix is required for Safari:
  ```css
  dialog::backdrop {
      background: rgba(0, 0, 0, 0.4);
      backdrop-filter: blur(2px);
      -webkit-backdrop-filter: blur(2px);
  }
  ```
  Keep the blur subtle (2–4px) — heavier values (8px+) cause visible lag on lower-end hardware and distract from the panel content.
- **Merge sparse categories.** If a category has only 1–2 items, merge it into a "More" category with section headers to keep the sidebar concise.
- **Disable state propagation.** When the master toggle is off, grey out (opacity + pointer-events: none) all sidebar buttons and content controls.
- **Re-create the panel on open.** Don't cache the panel DOM. Recreate it each time from current settings state to avoid stale toggles after background changes.
- **Stop click propagation.** Call `e.stopPropagation()` on the panel to prevent clicks inside it from triggering the backdrop close handler or the host site's event listeners.

---

## RSS / Feed Content Rendering in a Reading Pane

Rendering arbitrary HTML from RSS feeds inside a constrained reading pane is surprisingly tricky. Feed content is authored for full-width websites and often contains layout structures that break in narrow containers.

### Message Size Limits

- **`browser.runtime.sendMessage()` has a silent size limit in Safari** (~4–8 MB). If you store full article HTML content and send hundreds of articles in a single message, it will fail silently — the promise never resolves and no error is thrown.
- **Fix: lightweight article projections.** Strip the `content` field when sending article lists. Send only metadata (title, date, summary, thumbnailUrl). Lazy-load full content on demand via a separate `getArticleContent` message when the user selects an article.
- **Pre-extract thumbnail URLs** at article creation time so list views never need the full content blob.

### HTML Sanitization for Feed Content

- **Strip fixed `width`/`height` attributes** from all elements except `<img>` (images need them for aspect ratio). RSS feeds frequently include `<table width="800">` or `<div width="1000">` that overflow narrow containers.
- **Clamp inline `style` widths** — remove `min-width`, convert fixed-pixel `width` values to `width: 100%`. Leave percentage widths and `auto` alone.
- **Duplicate thumbnails**: When you extract a thumbnail from `<img>` in the content and display it as a standalone element above the body, remove the first matching `<img>` from the content DOM to avoid showing it twice.

### Layout Tables in RSS Feeds

- **RSS feeds use `<table>` for page layout**, not just data. Reddit, newsletters, and many CMS platforms wrap article content in `<table><tr><td>text</td><td>sidebar</td></tr></table>`. This creates multi-column layouts that break in narrow reading panes.
- **CSS-only fix**: Force all table elements inside article content to `display: block; width: 100% !important`. This linearises any table — layout or data — into a single stacked column:
  ```css
  .article-body table, .article-body thead, .article-body tbody,
  .article-body tfoot, .article-body tr, .article-body th, .article-body td {
      display: block;
      width: 100% !important;
      box-sizing: border-box;
  }
  ```
- This is more reliable than JS-based heuristics for detecting "layout tables" vs "data tables".

### CSS Multi-Column (`column-count`) Pitfalls

- **Never apply `column-count` to articles with complex content.** CSS multi-column fragments images, tables, code blocks, lists, and headings across columns, creating broken layouts.
- **Guard with a content check**: Before applying newspaper-style columns, scan for `table, pre, code, img, ul, ol, iframe, video, figure, blockquote, h1, h2, h3`. If any exist, skip multi-column entirely.
- Multi-column layout only works well for long-form **pure text** articles (just paragraphs and links).

### Grid Children and Overflow

- **CSS Grid children default to `min-height: auto`**, which prevents them from shrinking below their content size. A scrollable article list inside a grid cell won't scroll unless the grid child has `min-height: 0` or `overflow: hidden`.
- Both `min-height: 0` and `overflow: hidden` solve this. Use `overflow: hidden` when you also want to clip overflowing content.

---

## Safari WebKit Limitations

### `createMediaElementSource()` does not work with HLS/MSE streams

Safari uses native HLS playback for `<video>` elements on sites like Twitch. The Web Audio API's `createMediaElementSource()` **does not route audio** from HLS (or MSE) streams through the audio graph. This is a confirmed WebKit bug (#231656 / #180696).

**Symptoms**: You connect a `MediaElementSourceNode` to a chain of audio processing nodes (compressor, gain, etc.) and attach an `AnalyserNode`. The analyser reports all zeros — no audio is flowing through the graph, even though the video plays with sound via its native output.

**Workarounds that don't exist**:
- `captureStream()` — not implemented in Safari.
- Intercepting MSE SourceBuffers — Safari uses native HLS, not MSE, so there are no SourceBuffers to tap.
- WebCodecs — limited Safari support, no viable path.

**Conclusion**: Real-time audio processing (compression, EQ, normalization) is not possible for HLS video in Safari. If you need this feature, it cannot be implemented as a Safari extension. Remove the feature or use a volume-based approximation (e.g., `video.volume = 0.65`) with a clear disclaimer.

---

## MutationObserver for Lazy-Rendered UI

### The problem: dropdowns, popovers, and modals render on demand

Many web apps (Twitch, YouTube, etc.) only render dropdown/popover/modal content into the DOM when the user interacts (clicks a button, hovers). If your extension needs to modify text or elements inside these containers, **`setTimeout` will miss them** because the DOM nodes don't exist yet at any fixed delay.

### The solution: MutationObserver on `document.body`

```js
let observer = null;

function startObserver() {
    if (observer) return;
    observer = new MutationObserver(() => {
        modifyTargetElements();  // Your DOM modification function
    });
    observer.observe(document.body, { childList: true, subtree: true });
    modifyTargetElements();  // Run once immediately for any existing content
}

function stopObserver() {
    if (observer) { observer.disconnect(); observer = null; }
}
```

### When to use this pattern
- Modifying text in dropdown menus (e.g., shortening download labels)
- Injecting elements into popover cards (e.g., enhanced user cards)
- Watching for modals or dialogs that appear on user action
- Any case where the target DOM doesn't exist at page load or at a predictable time

### Performance note
A `MutationObserver` on `document.body` with `subtree: true` fires frequently. Keep the callback lightweight — use early-exit checks (e.g., `if (!regex.test(el.textContent)) continue`) and avoid heavy DOM queries. Scope the observer to the most specific container when possible.

---

## Multi-Language Text Matching

### Never hardcode English strings when modifying third-party UI

When your extension modifies text in a host page (e.g., shortening labels, hiding elements by text content), the text will be in the user's language, not English.

### Use language-spanning regex patterns

```js
// BAD: only matches English
node.nodeValue.replace(/Version/gi, "");

// GOOD: matches English "Version" and Spanish "versión"
node.nodeValue.replace(/\s*versi[oó]n\s*/gi, " ").trim();
```

### Strategy for unknown languages
1. **Identify the invariant part** — find the substring that's common across all translations (e.g., a number, a symbol, or a root word).
2. **Use character class ranges** for accented variants: `[oó]`, `[eé]`, `[aáà]`, etc.
3. **Test with at least 2 non-English locales** before shipping.
4. **If no invariant substring exists**, use structural selectors (nth-child, data attributes) instead of text matching.

This pattern applies to **all text replacement operations**, not just DOM modifications. It includes `aria-label` matching, button text detection, and any string comparison against host page content.

---

## Popup as Settings Panel Opener

### The problem: in-page settings buttons can't be injected everywhere

In-page settings buttons (e.g., next to chat input) only work on pages that have the expected DOM structure. On clip pages, VOD pages, directory pages, or other non-channel views, there may be no chat area to anchor the button to. Injecting into the top nav is fragile and breaks across Twitch UI updates.

### The solution: use the extension popup to open the in-page panel

Instead of a full settings UI in the popup, make the popup a lightweight launcher that sends a message to the content script to open the in-page settings panel:

```js
// popup.js — on DOMContentLoaded, send a message to open the panel
browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
    if (tabs[0]) {
        browser.tabs.sendMessage(tabs[0].id, { action: "openSettingsPanel" });
    }
});
// Close the popup immediately
window.close();
```

```js
// content.js — handle the message
browser.runtime.onMessage.addListener((request) => {
    if (request.action === "openSettingsPanel") {
        openSettingsPanel();
    }
});
```

**Benefits**:
- Works on every page the content script runs on (no DOM anchor needed)
- Single source of truth for settings UI (the in-page panel)
- No need to maintain a separate popup UI with duplicate toggle logic
- The popup is just a bridge — zero UI to keep in sync

---

## Welcome Screen with Platform-Specific Setup Instructions

The host app (the thin native wrapper) displays a welcome/onboarding screen when launched. This is the user's first interaction with your extension. It should detect the platform (macOS vs iOS/iPadOS) and show localized, step-by-step instructions for enabling the extension in Safari.

### Architecture

```
ViewController.swift  →  WKWebView  →  Main.html + Style.css + Script.js
      │
      ├─ #if os(iOS):  evaluateJavaScript("show('ios')")
      └─ #if os(macOS): evaluateJavaScript("show('mac', isEnabled, useSettings)")
```

The native `ViewController` loads `Main.html` into a `WKWebView`, then calls a JS function with platform info. On macOS, it also queries `SFSafariExtensionManager.getStateOfSafariExtension()` to check if the extension is already enabled and passes that state to JS.

### ViewController.swift pattern

```swift
import WebKit

#if os(iOS)
import UIKit
typealias PlatformViewController = UIViewController
#elseif os(macOS)
import Cocoa
import SafariServices
typealias PlatformViewController = NSViewController
#endif

let extensionBundleIdentifier = "com.yourcompany.YourApp.Extension"

class ViewController: PlatformViewController, WKNavigationDelegate, WKScriptMessageHandler {
    @IBOutlet var webView: WKWebView!

    override func viewDidLoad() {
        super.viewDidLoad()
        webView.navigationDelegate = self
        #if os(iOS)
        webView.scrollView.isScrollEnabled = false
        #endif
        webView.configuration.userContentController.add(self, name: "controller")
        webView.loadFileURL(
            Bundle.main.url(forResource: "Main", withExtension: "html")!,
            allowingReadAccessTo: Bundle.main.resourceURL!
        )
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        #if os(iOS)
        // iOS: no SFSafariExtensionManager — show instructions only
        webView.evaluateJavaScript("show('ios')")
        #elseif os(macOS)
        // macOS: query extension state and show enabled/disabled badge
        webView.evaluateJavaScript("show('mac')")
        SFSafariExtensionManager.getStateOfSafariExtension(
            withIdentifier: extensionBundleIdentifier
        ) { (state, error) in
            guard let state = state, error == nil else { return }
            DispatchQueue.main.async {
                if #available(macOS 13, *) {
                    webView.evaluateJavaScript("show('mac', \(state.isEnabled), true)")
                } else {
                    webView.evaluateJavaScript("show('mac', \(state.isEnabled), false)")
                }
            }
        }
        #endif
    }

    func userContentController(_ userContentController: WKUserContentController,
                                didReceive message: WKScriptMessage) {
        #if os(macOS)
        guard (message.body as? String) == "open-preferences" else { return }
        SFSafariApplication.showPreferencesForExtension(
            withIdentifier: extensionBundleIdentifier
        ) { error in
            guard error == nil else { return }
            DispatchQueue.main.async { NSApp.terminate(self) }
        }
        #endif
    }
}
```

Key points:
- **`SFSafariExtensionManager`** is macOS-only. On iOS there is no API to check extension state programmatically — just show instructions.
- **macOS 13+ uses "Settings"** instead of "Preferences" in Safari's menu. The `useSettingsInsteadOfPreferences` flag lets the JS update button text accordingly.
- **`webkit.messageHandlers.controller.postMessage()`** sends messages from the WKWebView back to Swift for actions like opening Safari's extension preferences pane.

### HTML: platform-conditional content

Use CSS classes for platform/state visibility. The JS `show()` function adds the appropriate class to `<body>`, and CSS rules hide irrelevant content.

```html
<body>
    <img src="../Icon.png" width="128" height="128" alt="App Icon">
    <h1>Your Extension</h1>

    <!-- macOS status badges (shown based on extension state) -->
    <p class="platform-mac state-on">Extension is enabled in Safari. You're all set!</p>
    <p class="platform-mac state-off">Extension is currently disabled.</p>
    <p class="platform-mac state-unknown">Enable the extension to get started.</p>

    <!-- macOS instructions -->
    <div class="platform-mac instructions">
        <div class="step"><span class="step-num">1</span><span>Open <strong>Safari</strong> and go to <strong>Settings</strong> (⌘,)</span></div>
        <div class="step"><span class="step-num">2</span><span>Click the <strong>Extensions</strong> tab</span></div>
        <div class="step"><span class="step-num">3</span><span>Check the box next to <strong>Your Extension</strong></span></div>
        <div class="step"><span class="step-num">4</span><span>Allow it to run on <strong>yoursite.com</strong> when prompted</span></div>
        <div class="step"><span class="step-num">5</span><span>Visit <strong>yoursite.com</strong> — look for the icon in your toolbar</span></div>
    </div>

    <button class="platform-mac open-preferences">Quit and Open Safari Extensions Preferences…</button>

    <!-- iOS / iPadOS instructions -->
    <div class="platform-ios instructions">
        <div class="step"><span class="step-num">1</span><span>Open the <strong>Settings</strong> app on your device</span></div>
        <div class="step"><span class="step-num">2</span><span>Scroll down and tap <strong>Safari</strong></span></div>
        <div class="step"><span class="step-num">3</span><span>Tap <strong>Extensions</strong></span></div>
        <div class="step"><span class="step-num">4</span><span>Tap <strong>Your Extension</strong> and toggle it <strong>on</strong></span></div>
        <div class="step"><span class="step-num">5</span><span>Set permissions to <strong>Allow</strong> on <strong>yoursite.com</strong></span></div>
        <div class="step"><span class="step-num">6</span><span>Open Safari and visit <strong>yoursite.com</strong> — tap <strong>ᴬᴬ</strong> in the address bar to verify</span></div>
    </div>
</body>
```

### CSS: platform and state visibility

```css
/* Hide all platform-specific content until JS sets the class */
body:not(.platform-mac, .platform-ios) :is(.platform-mac, .platform-ios) {
    display: none;
}
body.platform-ios .platform-mac { display: none; }
body.platform-mac .platform-ios { display: none; }

/* State badges (macOS only — iOS has no state API) */
body:not(.state-on, .state-off) :is(.state-on, .state-off) { display: none; }
body.state-on :is(.state-off, .state-unknown) { display: none; }
body.state-off :is(.state-on, .state-unknown) { display: none; }

.state-on { color: #22c55e; font-weight: 600; }
.state-off { color: #ef4444; font-weight: 600; }

/* Instruction steps with numbered circles */
.instructions {
    width: 100%;
    text-align: left;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 16px;
    border-radius: 12px;
    background: rgba(0, 0, 0, 0.03);
}
@media (prefers-color-scheme: dark) {
    .instructions { background: rgba(255, 255, 255, 0.06); }
}
.step {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    font-size: 14px;
    line-height: 1.5;
}
.step-num {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px; height: 24px;
    border-radius: 50%;
    background: var(--accent-color, #9147ff);
    color: #fff;
    font-size: 12px;
    font-weight: 700;
    flex-shrink: 0;
}
```

### JS: show function

```js
function show(platform, enabled, useSettingsInsteadOfPreferences) {
    document.body.classList.add(`platform-${platform}`);

    // macOS 13+ renamed "Preferences" → "Settings"
    if (useSettingsInsteadOfPreferences) {
        document.querySelector('.platform-mac.open-preferences').innerText =
            "Quit and Open Safari Settings…";
    }

    if (typeof enabled === "boolean") {
        document.body.classList.toggle("state-on", enabled);
        document.body.classList.toggle("state-off", !enabled);
    }
}

function openPreferences() {
    webkit.messageHandlers.controller.postMessage("open-preferences");
}

document.querySelector("button.open-preferences")
    .addEventListener("click", openPreferences);
```

### Localization considerations

- **The welcome screen HTML is a local file**, not an extension resource. It does **not** have access to `browser.i18n.getMessage()`. It runs inside the native app's `WKWebView`, not in the extension context.
- **For multi-language support**: Use the native `WKWebView` localization system. Place `Main.html` inside a `.lproj` folder (e.g., `en.lproj/Main.html`, `es.lproj/Main.html`) or use Xcode's Base localization with localized `.strings` files. The WKWebView will load the correct localized variant based on the system language.
- **Keep instruction text simple and universal.** Safari's UI labels ("Settings", "Extensions") are localized by Apple. Refer to them by function ("the Extensions tab") rather than by exact localized name to avoid mismatches if Apple changes the wording.
- **Use Xcode's Base Internationalization**: Set `Main.html` to use Base localization. Xcode will generate a base version and allow you to add localizable strings for each target language. This is the cleanest approach for HTML content inside a native app.

### Platform-specific notes

| Feature | macOS | iOS/iPadOS |
|---------|-------|------------|
| Extension state detection | `SFSafariExtensionManager.getStateOfSafariExtension()` | Not available |
| Open extension prefs | `SFSafariApplication.showPreferencesForExtension()` | Not available |
| Enable path | Safari > Settings > Extensions > checkbox | Settings app > Safari > Extensions > toggle |
| Permission grant | Safari prompt on first visit | Settings app > Extensions > website access |
| Verify enabled | Toolbar icon appears | ᴬᴬ menu in address bar shows extension |
| "Preferences" vs "Settings" | macOS 12: "Preferences", macOS 13+: "Settings" | Always "Settings" |

---

## Quick Checklist for New Safari Extensions

- [ ] Use `browser.*` APIs with Promises (not `chrome.*` with callbacks)
- [ ] Always `.catch(() => {})` on `sendMessage` calls
- [ ] Track state in background, re-apply on tab reload
- [ ] Use `document_start` + `prepend` for page-world script injection
- [ ] Guard async operations with a generation counter
- [ ] Clean up tracking Sets in `tabs.onRemoved`
- [ ] Test with rapid tab switching, window switching, and tab reload
- [ ] Test with sites that fight back (YouTube, Twitter, Spotify)
- [ ] Add `"all_frames": true` if you need to run in iframes
- [ ] Use `postMessage` for cross-origin iframe communication
- [ ] Keep `manifest.json` version and Xcode `MARKETING_VERSION` in sync
- [ ] Enable "Allow Unsigned Extensions" during development
- [ ] Test on both macOS and iOS if targeting both
- [ ] Use `<script defer>` not `<script type="module">` in popup/settings HTML
- [ ] Wrap `browser.i18n.getMessage()` with fallbacks in popup and settings JS
- [ ] Apply settings live via `applySettingChange()` — never require a page reload
- [ ] Use locale-agnostic selectors (match `data-*` attrs or keyboard shortcut hints, not English text)
- [ ] Test DOM interactions with a non-English system language
- [ ] Use sidebar navigation (not tab bars) for in-page settings panels with 5+ categories
- [ ] Use MutationObserver (not setTimeout) to modify dynamically-rendered dropdowns/popovers
- [ ] Use language-spanning regex (e.g., `versi[oó]n`) for all text matching in host pages
- [ ] Don't attempt `createMediaElementSource()` on HLS/MSE video — it won't route audio in Safari
- [ ] Consider making the popup a bridge to the in-page settings panel for universal access
- [ ] Check established implementations of similar extensions before building features they already solve — avoid trial-and-error when proven approaches exist
- [ ] Include platform-specific setup instructions in the welcome screen (macOS: Safari Settings > Extensions; iOS: Settings app > Safari > Extensions)
- [ ] Use `SFSafariExtensionManager.getStateOfSafariExtension()` on macOS to show enabled/disabled state badges
- [ ] Handle macOS 13+ "Settings" vs older "Preferences" naming in button text
