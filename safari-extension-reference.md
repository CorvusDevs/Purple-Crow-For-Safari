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

1. **`data-*` attributes** — `data-a-target`, `data-test-selector`, `data-testid`. These are set by developers for testing and are language-independent. However, sites may remove them over time (Twitch has been dropping `data-a-target` attributes).

2. **`aria-label` with language-neutral substrings** — Keyboard shortcut hints like `"alt+t"`, `"ctrl+m"`, icon names, or emoji are often consistent across translations. Use `*=` (contains) matching, not `=` (exact).

3. **Structural CSS selectors** — `.parent > :nth-child(n) button`, `.container button:last-of-type`. These don't depend on text content but are fragile if the DOM structure changes.

4. **Class names** — Stable BEM-style classes (`.chat-line__message`, `.video-player`) are safe. Avoid Styled Components hashes (`sc-abc123-4`) that change every deploy.

5. **Text content / full `aria-label` strings** — **Last resort only.** These break for every non-English user.

### Always use a fallback chain

Sites remove selectors over time. Use a priority chain so the first working selector wins:

```js
const btn = document.querySelector('button[aria-label*="alt+t"]')        // locale-agnostic
    || document.querySelector('[data-a-target="player-theatre-mode-button"]') // data attribute
    || document.querySelector('button[aria-label*="Theatre Mode"]')           // English fallback
    || document.querySelector('button[aria-label*="Theater Mode"]');          // US English variant
```

### Real-world example (Twitch)

The theater mode button's `aria-label` varies by locale:
| Language | `aria-label` value |
|---|---|
| English | `Theatre Mode (alt+t)` |
| Spanish | `Modo cine (alt+t)` |
| German | `Theatermodus (Alt+T)` |
| Japanese | `シアターモード (alt+t)` |

The `data-a-target="player-theatre-mode-button"` attribute that used to exist was removed by Twitch. The only reliable, locale-agnostic selector is `button[aria-label*="alt+t"]`.

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
