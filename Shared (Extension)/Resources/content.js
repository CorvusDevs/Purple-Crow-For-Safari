/**
 * Twitch Plus — Content Script
 *
 * Runs on twitch.tv pages. Responsibilities:
 *  1. Inject the page-world script (injected.js) for React/navigation access
 *  2. Detect channel changes via events from injected.js
 *  3. Request emotes from the background script
 *  4. Observe chat via MutationObserver and replace emote text with images
 *  5. Add chat enhancements (timestamps, highlights, deleted messages)
 */
(function () {
    "use strict";

    // Avoid double injection
    if (window.__twitchPlusContentLoaded) return;
    window.__twitchPlusContentLoaded = true;

    // ---------------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------------
    let emoteMap = new Map();    // name -> emoteData
    let emoteNamesSorted = [];   // pre-lowered sorted emote names for autocomplete
    let settings = {};
    let currentChannel = null;   // channel login name
    let currentChannelId = null; // twitch user ID
    let chatObserver = null;
    let tooltipEl = null;
    let username = null;         // logged-in user's display name
    let userColorIndex = 0;      // rotating index for alternating user bg colors
    const userColorMap = {};     // username -> color index for consistent coloring
    // (altRowIndex removed — DOM-based alternation now used in processMessage)
    let frequentEmotes = {};     // emoteName -> usage count (loaded from storage)

    // ---------------------------------------------------------------------------
    // Alternating Chat Color Presets
    // ---------------------------------------------------------------------------
    const SPLIT_CHAT_PRESETS = {
        default: {
            label: "Twitch Dark",
            dark: ["rgba(24, 24, 28, 0.6)", "rgba(50, 50, 56, 0.5)"],
            light: ["rgba(0, 0, 0, 0.03)", "rgba(0, 0, 0, 0.08)"],
        },
        midnight: {
            label: "Midnight",
            dark: ["rgba(15, 15, 30, 0.6)", "rgba(35, 30, 60, 0.5)"],
            light: ["rgba(220, 220, 240, 0.08)", "rgba(200, 200, 230, 0.12)"],
        },
        ocean: {
            label: "Ocean",
            dark: ["rgba(10, 25, 40, 0.6)", "rgba(20, 50, 70, 0.5)"],
            light: ["rgba(200, 230, 255, 0.08)", "rgba(180, 220, 250, 0.12)"],
        },
        forest: {
            label: "Forest",
            dark: ["rgba(15, 30, 15, 0.6)", "rgba(30, 55, 30, 0.5)"],
            light: ["rgba(200, 240, 200, 0.08)", "rgba(180, 230, 180, 0.12)"],
        },
        sunset: {
            label: "Sunset",
            dark: ["rgba(40, 15, 15, 0.6)", "rgba(60, 30, 20, 0.5)"],
            light: ["rgba(255, 230, 220, 0.08)", "rgba(255, 215, 200, 0.12)"],
        },
        neon: {
            label: "Neon Nights",
            dark: ["rgba(20, 5, 30, 0.7)", "rgba(5, 20, 35, 0.7)"],
            light: ["rgba(230, 200, 255, 0.1)", "rgba(200, 220, 255, 0.1)"],
        },
        rainbow: {
            label: "Rainbow",
            dark: [
                "rgba(60, 20, 20, 0.45)", "rgba(60, 40, 15, 0.45)",
                "rgba(55, 55, 15, 0.45)", "rgba(20, 50, 20, 0.45)",
                "rgba(15, 30, 60, 0.45)", "rgba(35, 15, 60, 0.45)",
            ],
            light: [
                "rgba(255, 200, 200, 0.12)", "rgba(255, 220, 180, 0.12)",
                "rgba(255, 255, 180, 0.12)", "rgba(200, 255, 200, 0.12)",
                "rgba(200, 210, 255, 0.12)", "rgba(230, 200, 255, 0.12)",
            ],
        },
        usa: {
            label: "USA",
            dark: [
                "rgba(50, 15, 15, 0.55)", "rgba(240, 240, 240, 0.06)",
                "rgba(15, 20, 55, 0.55)",
            ],
            light: [
                "rgba(255, 200, 200, 0.15)", "rgba(240, 240, 240, 0.08)",
                "rgba(200, 200, 255, 0.15)",
            ],
        },
        candy: {
            label: "Cotton Candy",
            dark: ["rgba(45, 15, 35, 0.55)", "rgba(15, 30, 50, 0.55)"],
            light: ["rgba(255, 200, 230, 0.1)", "rgba(200, 220, 255, 0.1)"],
        },
        hacker: {
            label: "Hacker",
            dark: ["rgba(0, 15, 0, 0.7)", "rgba(0, 30, 5, 0.5)"],
            light: ["rgba(200, 255, 200, 0.06)", "rgba(180, 240, 180, 0.1)"],
        },
    };

    /**
     * Get the colors array for the current split chat theme.
     * Theme mode is cached and updated via a lightweight MutationObserver
     * on <html> instead of querying the DOM on every chat message.
     */
    let cachedThemeMode = null;

    function detectThemeMode() {
        const isDark = document.querySelector(".tw-root--theme-dark") ||
            document.querySelector("[class*='dark-theme']") ||
            document.documentElement.classList.contains("tw-root--theme-dark");
        cachedThemeMode = isDark ? "dark" : "light";
        return cachedThemeMode;
    }

    // Watch for theme changes on the root element (class changes only)
    const themeObserver = new MutationObserver(() => detectThemeMode());
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

    function getSplitChatColors() {
        const mode = cachedThemeMode || detectThemeMode();

        const themeKey = settings.splitChatTheme || "default";

        // Custom colors
        if (themeKey === "custom") {
            const custom = settings.splitChatCustomColors;
            if (Array.isArray(custom) && custom.length >= 2) {
                return custom;
            }
            // Fallback to default if custom not configured
            return SPLIT_CHAT_PRESETS.default[mode];
        }

        const preset = SPLIT_CHAT_PRESETS[themeKey];
        if (!preset) {
            console.warn(`[Twitch Plus] Unknown theme "${themeKey}", falling back to default`);
            return SPLIT_CHAT_PRESETS.default[mode];
        }
        return preset[mode];
    }
    let settingsReady = false;   // gate: true once initial settings are loaded
    let pendingChannel = null;   // channel detected before settings were ready

    // Non-channel path prefixes (shared between content.js and injected.js)
    const EXCLUDED_PATHS = new Set([
        "directory", "downloads", "jobs", "turbo", "settings",
        "subscriptions", "inventory", "wallet", "friends",
        "moderator", "search", "following", "videos", "",
    ]);

    // New feature state (v3.0.0)
    let knownBots = new Set();         // set of known bot usernames (lowercase)
    let spamBuffer = new Map();        // normalized text -> [timestamps]
    let emoteMenuOpen = false;         // emote picker state
    let chatSearchActive = false;      // chat search overlay state
    let ytPreviewEl = null;            // YouTube preview tooltip
    let channelPreviewEl = null;       // channel preview tooltip
    let channelPreviewTimer = null;    // debounce timer
    let slowModeTimer = null;          // slow mode countdown interval
    let sidebarExpandObserver = null;  // auto-expand observer

    // Touch device detection (updated on first touch)
    let isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);

    // ---------------------------------------------------------------------------
    // 1. Inject page-world script
    // ---------------------------------------------------------------------------
    function injectPageScript() {
        try {
            const script = document.createElement("script");
            script.src = browser.runtime.getURL("injected.js");
            script.onload = () => script.remove();
            (document.head || document.documentElement).appendChild(script);
            console.log("[Twitch Plus] Page-world script injected.");
        } catch (e) {
            console.error("[Twitch Plus] Failed to inject page-world script:", e);
        }
    }

    // ---------------------------------------------------------------------------
    // 2. Utilities
    // ---------------------------------------------------------------------------

    /**
     * Wait for a DOM element to appear.
     */
    function waitForElement(selector, timeout = 20000) {
        return new Promise((resolve, reject) => {
            const el = document.querySelector(selector);
            if (el) return resolve(el);

            const obs = new MutationObserver(() => {
                const el = document.querySelector(selector);
                if (el) {
                    obs.disconnect();
                    resolve(el);
                }
            });
            obs.observe(document.body, { childList: true, subtree: true });
            setTimeout(() => {
                obs.disconnect();
                reject(new Error(`Timeout waiting for ${selector}`));
            }, timeout);
        });
    }

    /**
     * Try to resolve the channel's Twitch user ID.
     * We try several approaches:
     * 1. Ask the page-world script (React fiber)
     * 2. Parse from URL and use Twitch's internal __NEXT_DATA__ or similar
     * 3. Fallback: use the channel name and let background resolve via API
     */
    function requestChannelId() {
        return new Promise((resolve) => {
            let resolved = false;
            const handler = (e) => {
                if (resolved) return;
                resolved = true;
                document.removeEventListener("twitch-plus-channel-id", handler);
                resolve(e.detail || { channelId: null, authToken: null });
            };
            document.addEventListener("twitch-plus-channel-id", handler);
            document.dispatchEvent(new CustomEvent("twitch-plus-request-channel-id"));

            // Timeout fallback
            setTimeout(() => {
                if (resolved) return;
                resolved = true;
                document.removeEventListener("twitch-plus-channel-id", handler);
                resolve({ channelId: null, authToken: null });
            }, 3000);
        });
    }

    /**
     * Try to get the logged-in username from the page.
     */
    function detectUsername() {
        // From the user menu button or from cookies
        const el = document.querySelector("[data-a-target=\"user-display-name\"]");
        if (el) return el.textContent.trim();
        // From cookie
        const match = document.cookie.match(/(?:^|;\s*)name=([^;]+)/);
        if (match) return decodeURIComponent(match[1]);
        // From login cookie
        const loginMatch = document.cookie.match(/(?:^|;\s*)login=([^;]+)/);
        if (loginMatch) return decodeURIComponent(loginMatch[1]);
        return null;
    }

    // ---------------------------------------------------------------------------
    // 3. Emote loading
    // ---------------------------------------------------------------------------

    function rebuildEmoteIndex() {
        emoteNamesSorted = [...emoteMap.keys()]
            .map(name => ({ lower: name.toLowerCase(), name }))
            .sort((a, b) => a.lower.localeCompare(b.lower));
    }

    async function loadEmotes(channelId) {
        try {
            const response = await browser.runtime.sendMessage({
                action: "getEmotes",
                channelId: channelId,
            });
            if (response && response.emoteMap) {
                emoteMap = new Map(Object.entries(response.emoteMap));
                rebuildEmoteIndex();
                settings = response.settings || {};
                const bttvCount = [...emoteMap.values()].filter(e => e.source === "bttv").length;
                const ffzCount = [...emoteMap.values()].filter(e => e.source === "ffz").length;
                const stvCount = [...emoteMap.values()].filter(e => e.source === "7tv").length;
                console.log(
                    `[Twitch Plus] Emote map loaded: ${emoteMap.size} emotes (BTTV=${bttvCount}, FFZ=${ffzCount}, 7TV=${stvCount})`
                );

                // Subscribe to 7TV EventAPI for live emote updates
                if (response.sevenTvEmoteSetId && settings.sevenTvEventApi) {
                    browser.runtime.sendMessage({
                        action: "subscribe7tv",
                        emoteSetId: response.sevenTvEmoteSetId,
                        channelId: channelId,
                    }).catch(() => {});
                }
            }
        } catch (e) {
            console.error("[Twitch Plus] Failed to load emotes:", e);
        }
    }

    async function loadGlobalEmotesOnly() {
        try {
            const response = await browser.runtime.sendMessage({
                action: "getGlobalEmotes",
            });
            if (response && response.emoteMap) {
                emoteMap = new Map(Object.entries(response.emoteMap));
                rebuildEmoteIndex();
                settings = response.settings || {};
            }
        } catch (e) {
            console.error("[Twitch Plus] Failed to load global emotes:", e);
        }
    }

    // ---------------------------------------------------------------------------
    // 4. Chat observation & emote replacement
    // ---------------------------------------------------------------------------

    // Multiple selectors for chat containers (Twitch changes these periodically)
    const CHAT_CONTAINER_SELECTORS = [
        // Live chat
        ".chat-scrollable-area__message-container",
        "section[data-test-selector='chat-room-component-layout'] .simplebar-content",
        ".chat-list--default .simplebar-content",
        ".chat-list .chat-scrollable-area__message-container",
        // VOD chat replay
        ".video-chat__message-list-wrapper",
        ".qa-vod-chat",
        ".va-vod-chat",
        ".video-chat",
    ];

    // Multiple selectors for chat message lines
    const CHAT_LINE_SELECTORS = [
        // Live chat
        ".chat-line__message",
        "[data-a-target='chat-line-message']",
        ".chat-line__message--emote-button",
        // VOD chat replay
        ".vod-message",
        ".vod-message__content",
        "[data-test-selector='comment-message-selector']",
        ".video-chat__message",
    ];
    const CHAT_LINE_SELECTOR = CHAT_LINE_SELECTORS.join(", ");

    function findChatContainer() {
        for (const sel of CHAT_CONTAINER_SELECTORS) {
            const el = document.querySelector(sel);
            if (el) return el;
        }
        return null;
    }

    function startChatObserver() {
        if (chatObserver) {
            chatObserver.disconnect();
            chatObserver = null;
        }

        const chatContainer = findChatContainer();
        if (!chatContainer) {
            // Chat not visible yet — retry with broader selectors
            console.log("[Twitch Plus] Chat container not found, waiting...");
            const waitSelectors = CHAT_CONTAINER_SELECTORS.join(", ");
            waitForElement(waitSelectors, 30000)
                .then(() => startChatObserver())
                .catch(() => console.warn("[Twitch Plus] Chat container not found after wait."));
            return;
        }

        console.log(`[Twitch Plus] Chat container found: ${chatContainer.className}`);

        chatObserver = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType !== Node.ELEMENT_NODE) continue;
                    processChatNode(node);
                }
            }
        });

        chatObserver.observe(chatContainer, { childList: true, subtree: true });

        // Process existing messages
        const existing = chatContainer.querySelectorAll(CHAT_LINE_SELECTOR);
        existing.forEach((msg) => processMessage(msg));

        console.log(`[Twitch Plus] Chat observer started. Found ${existing.length} existing messages.`);
    }

    /**
     * Process a newly added chat DOM node.
     * The node might be a chat-line__message itself, a wrapper div, or something else.
     * We match broadly then hand off to processMessage for each actual message.
     */
    function processChatNode(node) {
        // Check if the node itself is a chat message
        if (isMessageElement(node)) {
            processMessage(node);
            return;
        }

        // Check children — the added node is often a wrapper
        if (node.querySelectorAll) {
            const messages = node.querySelectorAll(CHAT_LINE_SELECTOR);
            for (const msg of messages) {
                processMessage(msg);
            }
        }

        // Also check if the node is within a chat message (e.g. a badge or text fragment
        // being added to an existing message line)
        const parentMsg = node.closest?.(CHAT_LINE_SELECTOR);
        if (parentMsg && !parentMsg.dataset.tpProcessed) {
            processMessage(parentMsg);
        }
    }

    /**
     * Check if an element is a chat message line.
     */
    function isMessageElement(el) {
        if (!el || !el.classList) return false;
        // Live chat
        if (el.classList.contains("chat-line__message")) return true;
        if (el.getAttribute?.("data-a-target") === "chat-line-message") return true;
        // VOD chat replay
        if (el.classList.contains("vod-message")) return true;
        if (el.classList.contains("vod-message__content")) return true;
        if (el.classList.contains("video-chat__message")) return true;
        if (el.getAttribute?.("data-test-selector") === "comment-message-selector") return true;
        return false;
    }

    /**
     * Process a single chat message element. Applies all enhancements.
     */
    function processMessage(msg) {
        if (!msg || msg.dataset.tpProcessed) return;
        msg.dataset.tpProcessed = "1";

        // Bot hiding (check early to skip processing)
        if (checkBotMessage(msg)) return;

        // Spam detection (check early to skip processing)
        if (checkSpamMessage(msg)) return;

        processEmotesInMessage(msg);

        // Custom nicknames (before other text processing)
        const nicks = settings.customNicknames;
        if (nicks && Object.keys(nicks).length > 0) {
            applyCustomNicknames(msg);
        }

        // Keyword highlighting/hiding
        if ((settings.highlightKeywords?.length > 0) || (settings.hiddenKeywords?.length > 0)) {
            processKeywords(msg);
        }

        // Spoiler tags
        if (settings.spoilerHiding !== false) {
            wrapSpoilers(msg);
        }

        if (settings.chatTimestamps) {
            addTimestamp(msg);
        }

        if (settings.mentionHighlights && username) {
            highlightMentions(msg);
        }

        if (settings.alternatingUsers !== false) {
            applyUserColor(msg);
        }

        if (settings.firstTimeChatterHighlight) {
            highlightFirstTimeChatter(msg);
        }

        // Mod tools
        if (settings.modToolsEnabled) {
            injectModButtons(msg);
        }

        // Pronouns (async — doesn't block message rendering)
        applyPronouns(msg);

        // YouTube link previews
        attachYoutubePreviewListeners(msg);

        // Chat image previews (inline)
        attachImagePreviewListeners(msg);

        // Alternating row backgrounds — DOM-based to stay in sync
        // even when Twitch removes old messages from the DOM.
        // Twitch wraps each message in a container div, so we must
        // walk parent-wrapper siblings (not direct siblings).
        if (settings.splitChat !== false) {
            const colors = getSplitChatColors();
            let prevMsg = null;

            // Strategy 1: direct previous sibling (flat DOM)
            let sib = msg.previousElementSibling;
            while (sib) {
                if (isMessageElement(sib) && sib.dataset.tpColorIdx !== undefined) {
                    prevMsg = sib; break;
                }
                sib = sib.previousElementSibling;
            }

            // Strategy 2: parent wrapper's previous siblings (wrapped DOM)
            if (!prevMsg && msg.parentElement) {
                let prevWrap = msg.parentElement.previousElementSibling;
                while (prevWrap) {
                    if (isMessageElement(prevWrap) && prevWrap.dataset.tpColorIdx !== undefined) {
                        prevMsg = prevWrap; break;
                    }
                    if (prevWrap.querySelector) {
                        const inner = prevWrap.querySelector("[data-tp-color-idx]");
                        if (inner) { prevMsg = inner; break; }
                    }
                    prevWrap = prevWrap.previousElementSibling;
                }
            }

            const prevIdx = prevMsg ? parseInt(prevMsg.dataset.tpColorIdx, 10) : -1;
            const colorIndex = (prevIdx + 1) % colors.length;
            msg.style.backgroundColor = colors[colorIndex];
            msg.dataset.tpColorIdx = String(colorIndex);
        }
    }

    /**
     * Highlight first-time chatters with a gold border.
     */
    function highlightFirstTimeChatter(messageEl) {
        const isFirstTime =
            messageEl.querySelector("[data-a-target='chat-badge'][alt*='first']") ||
            messageEl.querySelector("[data-a-target='chat-message-first-time-chatter']") ||
            messageEl.querySelector(".chat-badge[alt*='first' i]") ||
            messageEl.closest("[data-a-target='chat-message-first-time-chatter']");
        if (isFirstTime) {
            messageEl.classList.add("twitch-plus-first-time-chatter");
        }
    }

    /**
     * Replace display names with custom nicknames.
     */
    function applyCustomNicknames(messageEl) {
        const nicks = settings.customNicknames || {};
        if (Object.keys(nicks).length === 0) return;

        const nameEl = messageEl.querySelector(
            "[data-a-target=\"chat-message-username\"], " +
            ".chat-author__display-name, " +
            ".chat-line__username"
        );
        if (!nameEl) return;

        const original = nameEl.textContent.trim().toLowerCase();
        if (nicks[original]) {
            nameEl.dataset.tpOriginalName = nameEl.textContent;
            nameEl.textContent = nicks[original];
        }
    }

    /**
     * Highlight or hide messages matching keyword lists.
     */
    function processKeywords(messageEl) {
        const msgText = messageEl.querySelector("[data-a-target=\"chat-message-text\"]");
        if (!msgText) return;
        const text = msgText.textContent.toLowerCase();

        // Hidden keywords — hide the entire message
        const hidden = settings.hiddenKeywords || [];
        for (const kw of hidden) {
            if (kw && text.includes(kw.toLowerCase())) {
                messageEl.classList.add("twitch-plus-keyword-hidden");
                return; // Don't bother highlighting if hidden
            }
        }

        // Highlight keywords
        const highlights = settings.highlightKeywords || [];
        for (const kw of highlights) {
            if (kw && text.includes(kw.toLowerCase())) {
                messageEl.classList.add("twitch-plus-keyword-highlight");
                return;
            }
        }
    }

    /**
     * Wrap ||text|| patterns in spoiler spans.
     */
    function wrapSpoilers(messageEl) {
        const msgText = messageEl.querySelector("[data-a-target=\"chat-message-text\"]");
        if (!msgText) return;

        const walker = document.createTreeWalker(msgText, NodeFilter.SHOW_TEXT, null);
        const textNodes = [];
        while (walker.nextNode()) textNodes.push(walker.currentNode);

        for (const textNode of textNodes) {
            const text = textNode.textContent;
            if (!text.includes("||")) continue;

            const parts = text.split(/(\|\|[^|]+\|\|)/g);
            if (parts.length <= 1) continue;

            const frag = document.createDocumentFragment();
            for (const part of parts) {
                if (part.startsWith("||") && part.endsWith("||") && part.length > 4) {
                    const spoiler = document.createElement("span");
                    spoiler.className = "tp-spoiler";
                    spoiler.textContent = part.slice(2, -2);
                    spoiler.addEventListener("click", () => {
                        spoiler.classList.toggle("tp-spoiler-revealed");
                    });
                    frag.appendChild(spoiler);
                } else {
                    frag.appendChild(document.createTextNode(part));
                }
            }
            textNode.parentNode.replaceChild(frag, textNode);
        }
    }

    /**
     * Inject mod quick-action buttons (timeout) next to usernames.
     */
    function injectModButtons(messageEl) {
        // Don't duplicate
        if (messageEl.querySelector(".tp-mod-btn")) return;

        const nameEl = messageEl.querySelector(
            "[data-a-target=\"chat-message-username\"], " +
            ".chat-author__display-name"
        );
        if (!nameEl) return;

        const targetUser = (nameEl.dataset.tpOriginalName || nameEl.textContent).trim();
        if (!targetUser) return;

        const durations = settings.customTimeouts || [60, 600, 3600];
        const container = nameEl.parentElement;
        if (!container) return;

        durations.forEach((secs) => {
            const btn = document.createElement("button");
            btn.className = "tp-mod-btn";
            btn.title = `Timeout ${targetUser} for ${formatTimeout(secs)}`;
            btn.textContent = formatTimeout(secs);
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                executeChatCommand(`/timeout ${targetUser} ${secs}`);
            });
            container.appendChild(btn);
        });
    }

    function formatTimeout(secs) {
        if (secs < 60) return `${secs}s`;
        if (secs < 3600) return `${Math.floor(secs / 60)}m`;
        return `${Math.floor(secs / 3600)}h`;
    }

    function executeChatCommand(command) {
        const input = document.querySelector(
            "[data-a-target=\"chat-input\"] textarea, " +
            "[data-a-target=\"chat-input\"] [contenteditable]"
        );
        if (!input) return;

        // Focus and set value
        input.focus();
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype, "value"
        )?.set || Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, "value"
        )?.set;

        if (nativeInputValueSetter) {
            nativeInputValueSetter.call(input, command);
        } else {
            input.value = command;
        }
        input.dispatchEvent(new Event("input", { bubbles: true }));

        // Press Enter after a short delay
        setTimeout(() => {
            const enterEvent = new KeyboardEvent("keydown", {
                key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true,
            });
            input.dispatchEvent(enterEvent);
        }, 50);
    }

    /**
     * Scan text fragments in a message and replace emote words with images.
     */
    function processEmotesInMessage(messageEl) {
        if (emoteMap.size === 0) return;

        // Primary: Twitch wraps text in .text-fragment spans (works for both live & some VOD messages)
        const textFragments = messageEl.querySelectorAll(
            "[data-a-target=\"chat-message-text\"] .text-fragment, " +
            ".message .text-fragment, " +
            ".chat-line__message--emote-button + .text-fragment, " +
            "span.text-fragment"
        );

        if (textFragments.length > 0) {
            for (const fragment of textFragments) {
                replaceEmotesInTextNode(fragment);
            }
            return;
        }

        // Fallback 1: VOD chat replay — text lives in different containers
        // VOD messages use .video-chat__message spans or direct text in .vod-message__content
        const vodTextContainers = messageEl.querySelectorAll(
            ".video-chat__message span[data-a-target='chat-message-text'], " +
            "[data-a-target='chat-message-text'], " +
            ".vod-message__content span[data-a-target='chat-message-text']"
        );

        if (vodTextContainers.length > 0) {
            for (const container of vodTextContainers) {
                // Check for .text-fragment children first
                const fragments = container.querySelectorAll(".text-fragment");
                if (fragments.length > 0) {
                    for (const f of fragments) replaceEmotesInTextNode(f);
                } else {
                    // Process raw text nodes directly
                    processChildTextNodes(container);
                }
            }
            return;
        }

        // Fallback 2: process childNodes of the message text container directly.
        // BTTV uses this approach — Twitch may not always use .text-fragment spans.
        const msgBody = messageEl.querySelector(
            "span[data-a-target='chat-message-text'], " +
            "[data-a-target='chat-message-text'], " +
            ".chat-line__message-body, " +
            "[class*='message-container'], " +
            ".vod-message__content"
        );
        if (msgBody) {
            processChildTextNodes(msgBody);
        }
    }

    /**
     * Walk child nodes of a container and replace emote text in text nodes and simple spans.
     */
    function processChildTextNodes(container) {
        const children = [...container.childNodes];
        for (const child of children) {
            if (child.nodeType === Node.TEXT_NODE && child.textContent?.trim()) {
                // Wrap in a span so replaceEmotesInTextNode can replace it
                const wrapper = document.createElement("span");
                wrapper.textContent = child.textContent;
                child.replaceWith(wrapper);
                replaceEmotesInTextNode(wrapper);
            } else if (child.nodeType === Node.ELEMENT_NODE) {
                // Process spans that contain only text (no nested elements like badges)
                if (child.children.length === 0 && child.textContent?.trim()) {
                    replaceEmotesInTextNode(child);
                }
            }
        }
    }

    /**
     * Replace emote words inside a text fragment element.
     */
    function replaceEmotesInTextNode(fragment) {
        const text = fragment.textContent;
        if (!text || !text.trim()) return;

        const words = text.split(/(\s+)/); // Keep whitespace tokens
        let hasEmote = false;

        // First pass: check if any word is an emote
        for (const word of words) {
            if (emoteMap.has(word)) {
                hasEmote = true;
                break;
            }
        }

        if (!hasEmote) return;

        // Build replacement fragment
        const docFrag = document.createDocumentFragment();
        let lastEmoteContainer = null;

        for (const word of words) {
            const emote = emoteMap.get(word);

            if (!emote) {
                // Not an emote — append as text
                lastEmoteContainer = null;
                docFrag.appendChild(document.createTextNode(word));
                continue;
            }

            // It's an emote
            const img = document.createElement("img");
            img.className = "twitch-plus-emote chat-image";
            img.src = emote.url1x;
            img.srcset = `${emote.url1x} 1x, ${emote.url2x} 2x, ${emote.url4x} 4x`;
            img.alt = emote.name;
            img.dataset.tpEmoteName = emote.name;
            img.dataset.tpEmoteSource = emote.source;
            img.dataset.tpEmoteUrl4x = emote.url4x;
            img.loading = "lazy";

            // Add tooltip listeners (hover for desktop, tap for touch)
            img.addEventListener("mouseenter", showTooltip);
            img.addEventListener("mouseleave", hideTooltip);
            img.addEventListener("touchstart", (e) => {
                if (tooltipEl) { hideTooltip(); return; }
                e.preventDefault();
                showTooltip(e);
                // Dismiss tooltip on next tap anywhere
                const dismiss = () => { hideTooltip(); document.removeEventListener("touchstart", dismiss, true); };
                setTimeout(() => document.addEventListener("touchstart", dismiss, true), 50);
            }, { passive: false });

            if (emote.zeroWidth && lastEmoteContainer) {
                // Zero-width emote: overlay on the previous emote container
                img.classList.add("twitch-plus-emote-zw");
                lastEmoteContainer.appendChild(img);
            } else if (emote.zeroWidth && docFrag.lastChild) {
                // Zero-width but previous was a standalone img — wrap it
                const prevImg = docFrag.lastChild;
                if (prevImg.classList?.contains("twitch-plus-emote")) {
                    const container = document.createElement("span");
                    container.className = "twitch-plus-emote-container";
                    docFrag.removeChild(prevImg);
                    prevImg.classList.remove("twitch-plus-emote");
                    container.appendChild(prevImg);
                    img.classList.add("twitch-plus-emote-zw");
                    container.appendChild(img);
                    docFrag.appendChild(container);
                    lastEmoteContainer = container;
                } else {
                    // No previous emote to overlay — render standalone
                    docFrag.appendChild(img);
                    lastEmoteContainer = null;
                }
            } else {
                // Standard emote
                docFrag.appendChild(img);
                lastEmoteContainer = null;

                // Wrap in container in case a zero-width follows
                // We'll do lazy wrapping — only wrap when a ZW emote appears (above)
            }
        }

        // Replace the text fragment's content
        fragment.textContent = "";
        fragment.appendChild(docFrag);
    }

    // ---------------------------------------------------------------------------
    // 5. Chat enhancements
    // ---------------------------------------------------------------------------

    function addTimestamp(messageEl) {
        if (messageEl.querySelector(".twitch-plus-timestamp")) return;
        const now = new Date();
        const hours = String(now.getHours()).padStart(2, "0");
        const minutes = String(now.getMinutes()).padStart(2, "0");
        const span = document.createElement("span");
        span.className = "twitch-plus-timestamp";
        span.textContent = `${hours}:${minutes}`;
        const container = messageEl.querySelector(".chat-line__message-container")
            || messageEl.querySelector(".chat-line__no-background")
            || messageEl;
        container.insertBefore(span, container.firstChild);
    }

    function highlightMentions(messageEl) {
        if (!username) return;
        const text = messageEl.textContent.toLowerCase();
        const lowerUser = username.toLowerCase();
        if (text.includes(`@${lowerUser}`) || text.includes(lowerUser)) {
            // Check it's actually in the message body, not just the username
            const msgText = messageEl.querySelector(
                "[data-a-target=\"chat-message-text\"], .vod-message__content"
            );
            if (msgText && msgText.textContent.toLowerCase().includes(lowerUser)) {
                messageEl.classList.add("twitch-plus-mention-highlight");
            }
        }
    }

    /**
     * Assign a consistent background color to each user's messages.
     * Uses a small palette of subtle, distinguishable tints.
     */
    const USER_BG_COLORS = [
        "rgba(255, 127, 80, 0.08)",   // coral
        "rgba(100, 149, 237, 0.08)",   // cornflower
        "rgba(144, 238, 144, 0.08)",   // light green
        "rgba(238, 130, 238, 0.08)",   // violet
        "rgba(255, 215, 0, 0.08)",     // gold
        "rgba(0, 206, 209, 0.08)",     // turquoise
        "rgba(255, 182, 193, 0.08)",   // pink
        "rgba(152, 251, 152, 0.08)",   // pale green
        "rgba(135, 206, 250, 0.08)",   // sky blue
        "rgba(255, 160, 122, 0.08)",   // light salmon
    ];

    function applyUserColor(messageEl) {
        // Get the display name from the message
        const nameEl = messageEl.querySelector(
            "[data-a-target=\"chat-message-username\"], " +
            ".chat-author__display-name, " +
            ".chat-line__username"
        );
        if (!nameEl) return;

        const displayName = nameEl.textContent.trim().toLowerCase();
        if (!displayName) return;

        // Assign a consistent color index to this user
        if (!(displayName in userColorMap)) {
            userColorMap[displayName] = userColorIndex % USER_BG_COLORS.length;
            userColorIndex++;
        }

        const colorIdx = userColorMap[displayName];
        messageEl.style.backgroundColor = USER_BG_COLORS[colorIdx];
    }

    // ---------------------------------------------------------------------------
    // 6. Tooltip
    // ---------------------------------------------------------------------------

    function showTooltip(e) {
        hideTooltip();
        const img = e.target;
        const name = img.dataset.tpEmoteName;
        const source = img.dataset.tpEmoteSource;
        const url4x = img.dataset.tpEmoteUrl4x;

        tooltipEl = document.createElement("div");
        tooltipEl.className = "twitch-plus-tooltip";

        const preview = document.createElement("img");
        preview.src = url4x;
        preview.alt = name;
        tooltipEl.appendChild(preview);

        const nameEl = document.createElement("div");
        nameEl.className = "tp-tooltip-name";
        nameEl.textContent = name;
        tooltipEl.appendChild(nameEl);

        const sourceEl = document.createElement("div");
        sourceEl.className = "tp-tooltip-source";
        const sourceLabels = { bttv: "BetterTTV", ffz: "FrankerFaceZ", "7tv": "7TV" };
        sourceEl.textContent = sourceLabels[source] || source;
        tooltipEl.appendChild(sourceEl);

        document.body.appendChild(tooltipEl);

        // Position above the emote
        const rect = img.getBoundingClientRect();
        const tooltipRect = tooltipEl.getBoundingClientRect();
        let top = rect.top - tooltipRect.height - 8;
        let left = rect.left + rect.width / 2 - tooltipRect.width / 2;

        // Keep within viewport
        if (top < 4) top = rect.bottom + 8;
        if (left < 4) left = 4;
        if (left + tooltipRect.width > window.innerWidth - 4) {
            left = window.innerWidth - tooltipRect.width - 4;
        }

        tooltipEl.style.top = `${top}px`;
        tooltipEl.style.left = `${left}px`;
    }

    function hideTooltip() {
        if (tooltipEl) {
            tooltipEl.remove();
            tooltipEl = null;
        }
    }

    // ---------------------------------------------------------------------------
    // 7. Auto-claim channel points
    // ---------------------------------------------------------------------------

    // ---- Auto-claim: channel points, drops, moments ----

    let autoClaimObserver = null;
    let autoClaimInterval = null;
    let lastClaimTime = 0;

    // Selectors ordered by reliability (BTTV uses .claimable-bonus__icon)
    const BONUS_SELECTORS = [
        ".claimable-bonus__icon",                               // BTTV's primary — the bouncing icon
        "button[aria-label='Claim Bonus']",                     // Accessible label (English)
        ".community-points-summary > *:nth-child(2) button",   // Structural, language-agnostic
        "button[data-a-target='chat-claim-bonus-button']",      // data-attribute based
    ];

    const DROP_SELECTORS = [
        "[data-test-selector='DropsCampaignInProgressRewardPresentation-claim-button']",
        "[data-test-selector='DropsHighlightRewardPresentation-claim-button']",
        "[data-test-selector='DropsClaimButton']",
        "button[data-a-target='drops-claim-button']",
        ".claimable-drop button",
        "[class*='drops'] button[class*='claim']",
        "[class*='drop-claim'] button",
    ];

    const MOMENT_SELECTORS = [
        "[data-test-selector='moment-claim-button']",
        "button[aria-label='Claim Now']",
        ".community-moments-claim button",
    ];

    const STREAK_SELECTORS = [
        "[data-test-selector*='streak'] button",
        "[data-test-selector*='watch-streak'] button",
        "button[data-a-target*='watch-streak']",
        "button[data-a-target*='streak-share']",
        ".chat-private-callout button",
    ];

    function findClaimButton(selectors) {
        for (const sel of selectors) {
            const btn = document.querySelector(sel);
            if (btn) return btn;
        }
        return null;
    }

    function tryClaimAll() {
        // Throttle: at least 2s between claims
        const now = Date.now();
        if (now - lastClaimTime < 2000) return;

        if (settings.autoClaimPoints !== false) {
            const btn = findClaimButton(BONUS_SELECTORS);
            if (btn) {
                btn.click();
                lastClaimTime = Date.now();
                console.log("[Twitch Plus] Auto-claimed channel points.");
            }
        }

        if (settings.autoClaimDrops !== false) {
            const btn = findClaimButton(DROP_SELECTORS);
            if (btn) {
                btn.click();
                lastClaimTime = Date.now();
                console.log("[Twitch Plus] Auto-claimed drop.");
            }
        }

        if (settings.autoClaimMoments) {
            const btn = findClaimButton(MOMENT_SELECTORS);
            if (btn) {
                btn.click();
                lastClaimTime = Date.now();
                console.log("[Twitch Plus] Auto-claimed moment.");
            }
        }

        if (settings.autoClaimStreaks !== false) {
            const btn = findClaimButton(STREAK_SELECTORS);
            if (btn) {
                btn.click();
                lastClaimTime = Date.now();
                console.log("[Twitch Plus] Auto-claimed watch streak.");
            }
        }
    }

    function startAutoClaimPoints() {
        if (autoClaimObserver || autoClaimInterval) return;

        // Strategy 1: MutationObserver on the community-points-summary container
        // This is how BTTV does it — react instantly when the claim button appears
        const pointsSummary = document.querySelector(".community-points-summary");
        if (pointsSummary) {
            autoClaimObserver = new MutationObserver(() => tryClaimAll());
            autoClaimObserver.observe(pointsSummary, { childList: true, subtree: true });
            console.log("[Twitch Plus] Auto-claim observer attached to points summary.");
        }

        // Strategy 2: Fallback interval that self-upgrades to observer once summary appears.
        // The observer handles the hot path (channel points). The interval continues at
        // 10s to catch drops, moments, and streaks which appear elsewhere in the DOM.
        autoClaimInterval = setInterval(() => {
            if (!autoClaimObserver) {
                const summary = document.querySelector(".community-points-summary");
                if (summary) {
                    autoClaimObserver = new MutationObserver(() => tryClaimAll());
                    autoClaimObserver.observe(summary, { childList: true, subtree: true });
                    console.log("[Twitch Plus] Auto-claim observer attached (delayed).");
                }
            }
            tryClaimAll();
        }, 10000);

        // Try claiming immediately
        tryClaimAll();
    }

    function stopAutoClaimPoints() {
        if (autoClaimObserver) {
            autoClaimObserver.disconnect();
            autoClaimObserver = null;
        }
        if (autoClaimInterval) {
            clearInterval(autoClaimInterval);
            autoClaimInterval = null;
        }
    }

    // ---- Channel-points popup: prevent right-side clipping ----
    // Twitch wraps the rewards popup in many nested overflow:hidden ancestors.
    // CSS overflow:visible on ancestors doesn't reliably reach them all.
    // Instead, we observe for the popup and reposition it with position:fixed.
    let rewardsPopupObserver = null;

    function startRewardsPopupFix() {
        if (rewardsPopupObserver) return;

        const watchForPopup = () => {
            const anchor = document.querySelector(".community-points-summary, [data-a-target='community-points-summary']");
            if (!anchor) return false;

            rewardsPopupObserver = new MutationObserver(() => {
                repositionRewardsPopup(anchor);
            });
            rewardsPopupObserver.observe(anchor, { childList: true, subtree: true });
            console.log("[Twitch Plus] Rewards popup fix observer attached.");
            return true;
        };

        if (!watchForPopup()) {
            // Retry until the points summary element exists
            const retryId = setInterval(() => {
                if (watchForPopup()) clearInterval(retryId);
            }, 3000);
        }
    }

    function repositionRewardsPopup(anchor) {
        // Twitch renders the popup as [role="dialog"] or .tw-balloon inside the summary
        const popup = anchor.querySelector('[role="dialog"], .tw-balloon, [class*="ScBalloonWrapper"]');
        if (!popup || popup.dataset.tpFixed) return;

        // Mark so we don't reprocess
        popup.dataset.tpFixed = "1";

        // Get the anchor button's position to align the popup
        const btn = anchor.querySelector("button") || anchor;
        const btnRect = btn.getBoundingClientRect();

        // Apply fixed positioning so the popup escapes all overflow:hidden ancestors
        popup.style.position = "fixed";
        popup.style.zIndex = "10000";
        // Align the popup's right edge to the button's right edge
        // and position it just below the button
        popup.style.top = (btnRect.bottom + 8) + "px";
        // Align right edge of popup with right edge of button
        popup.style.right = (window.innerWidth - btnRect.right) + "px";
        popup.style.left = "auto";

        // Ensure the popup doesn't go off-screen to the left
        requestAnimationFrame(() => {
            const popupRect = popup.getBoundingClientRect();
            if (popupRect.left < 8) {
                popup.style.right = "auto";
                popup.style.left = "8px";
            }
        });

        console.log("[Twitch Plus] Rewards popup repositioned with position:fixed.");
    }

    function stopRewardsPopupFix() {
        if (rewardsPopupObserver) {
            rewardsPopupObserver.disconnect();
            rewardsPopupObserver = null;
        }
    }

    // ---- Auto theater mode ----

    /**
     * Automatically enter theater mode on channel load.
     * Uses a polling/retry approach like working userscripts.
     */
    function autoTheaterMode() {
        if (!settings.autoTheaterMode) return;

        console.log("[Twitch Plus] Auto theater mode: starting...");

        let retries = 0;
        const maxRetries = 15;

        function tryTheater() {
            retries++;

            // Already in theater mode?
            if (document.querySelector(".persistent-player--theatre")) {
                console.log("[Twitch Plus] Already in theater mode.");
                return;
            }

            // Find the theater button. The aria-label is localized (e.g. "Modo cine (alt+t)"
            // in Spanish, "Theatre Mode (alt+t)" in English), but "alt+t" is consistent
            // across all languages. The data-a-target is no longer set by Twitch.
            const btn = document.querySelector('button[aria-label*="alt+t"]')
                || document.querySelector('[data-a-target="player-theatre-mode-button"]')
                || document.querySelector('button[aria-label*="Theatre Mode"]')
                || document.querySelector('button[aria-label*="Theater Mode"]');

            if (btn) {
                btn.click();
                console.log(`[Twitch Plus] Auto-entered theater mode (attempt ${retries}).`);
                return;
            }

            // Button not found yet — retry
            if (retries < maxRetries) {
                setTimeout(tryTheater, 500);
            } else {
                console.warn("[Twitch Plus] Theater mode button not found after retries.");
            }
        }

        // Start after a short delay for the player to load
        setTimeout(tryTheater, 500);
    }

    /**
     * Disable autoplay on homepage and offline channel pages.
     */
    function setupAutoplayPrevention() {
        if (!settings.disableAutoplay) return;

        const path = location.pathname;
        const isHomepage = path === "/" || path === "";
        const isDirectory = path.startsWith("/directory");

        if (isHomepage || isDirectory) {
            // Periodically pause any auto-playing videos on homepage/directory
            const pauseVideos = () => {
                document.querySelectorAll("video").forEach((v) => {
                    if (!v.paused && !v.dataset.tpUserPlayed) {
                        v.pause();
                        v.autoplay = false;
                    }
                });
            };

            // Immediate + periodic check
            pauseVideos();
            const pauseInterval = setInterval(pauseVideos, 2000);

            // Stop after 60s to avoid infinite CPU use
            setTimeout(() => clearInterval(pauseInterval), 60000);

            // Also observe new video elements (throttled to avoid firing on every DOM mutation)
            let autoplayThrottle = null;
            const observer = new MutationObserver(() => {
                if (autoplayThrottle) return;
                autoplayThrottle = setTimeout(() => {
                    autoplayThrottle = null;
                    pauseVideos();
                }, 500);
            });
            observer.observe(document.body, { childList: true, subtree: true });
            setTimeout(() => observer.disconnect(), 60000);

            console.log("[Twitch Plus] Autoplay prevention active on homepage/directory.");
        }
    }

    // ---- Auto-reload player on error ----
    // Twitch's IVS player sometimes shows "Error #1000" / "Error #2000" overlays
    // with a "click here to reload player" button. This polls for that button
    // and auto-clicks it so the stream resumes without user intervention.
    let playerReloadInterval = null;

    function startPlayerAutoReload() {
        if (playerReloadInterval) return;
        if (!settings.autoReloadPlayer) return;

        // Selectors for the various error/reload button states Twitch uses.
        // These target the error overlay's clickable elements.
        const RELOAD_SELECTORS = [
            "[data-a-target='player-overlay-content-gate'] button",
            "[data-a-target='player-overlay-content-gate'] [class*='allow-pointers']",
            "button[data-a-target='player-reload-button']",
            ".content-overlay-gate button",
            ".content-overlay-gate [class*='allow-pointers']",
            "[class*='content-overlay-gate'] button",
            "[class*='content-overlay-gate'] p[style]",
            ".player-overlay-background button",
            "[class*='error-overlay'] button",
            "[class*='player-error'] button",
        ];

        // Broader player container selectors to scope the text search
        const PLAYER_CONTAINERS = [
            ".video-player",
            "[data-a—target='video-player']",
            ".persistent-player",
            "[class*='player-overlay']",
            "[class*='content-overlay']",
        ];

        playerReloadInterval = setInterval(() => {
            if (!settings.autoReloadPlayer) return;

            // Strategy 1: Try specific selectors
            for (const sel of RELOAD_SELECTORS) {
                const btn = document.querySelector(sel);
                if (btn && isElementVisible(btn)) {
                    console.log(`[Twitch Plus] Player error detected — auto-clicking reload (selector: ${sel}).`);
                    btn.click();
                    return;
                }
            }

            // Strategy 2: Text-based search — find any clickable element in the
            // player area that says "reload" (language-agnostic: also check for
            // the reload icon or red-styled button in the player)
            for (const containerSel of PLAYER_CONTAINERS) {
                const container = document.querySelector(containerSel);
                if (!container) continue;
                // Look for any element with "reload" text
                const allClickable = container.querySelectorAll("button, [role='button'], p[style*='cursor'], a, [class*='allow-pointers']");
                for (const el of allClickable) {
                    const text = el.textContent?.toLowerCase() || "";
                    if ((text.includes("reload") || text.includes("try again") || text.includes("reintentar") || text.includes("recharger") || text.includes("neu laden")) && isElementVisible(el)) {
                        console.log(`[Twitch Plus] Player error detected — auto-clicking reload (text match: "${el.textContent.trim().slice(0, 50)}").`);
                        el.click();
                        return;
                    }
                }
            }
        }, 3000);

        console.log("[Twitch Plus] Player auto-reload watcher started.");
    }

    /** Check if an element is visible (not hidden or zero-size). */
    function isElementVisible(el) {
        if (!el) return false;
        // offsetParent is null for hidden elements, but also for fixed/body children
        // Use getBoundingClientRect for a more reliable check
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    function stopPlayerAutoReload() {
        if (playerReloadInterval) {
            clearInterval(playerReloadInterval);
            playerReloadInterval = null;
        }
    }

    // ---------------------------------------------------------------------------
    // 8. Chat Font Customization, Lurk Mode, Emote Tab-Completion
    // ---------------------------------------------------------------------------

    let chatFontStyleEl = null;

    /**
     * Apply custom chat font family and size.
     */
    function applyChatFont() {
        const family = settings.chatFontFamily || "";
        const size = settings.chatFontSize || 0;

        if (!family && !size) {
            // Remove custom style if exists
            if (chatFontStyleEl) { chatFontStyleEl.remove(); chatFontStyleEl = null; }
            return;
        }

        if (!chatFontStyleEl) {
            chatFontStyleEl = document.createElement("style");
            chatFontStyleEl.id = "tp-chat-font-style";
            document.head.appendChild(chatFontStyleEl);
        }

        let css = ".chat-scrollable-area__message-container, .chat-line__message {";
        if (family) css += `font-family: ${family} !important;`;
        if (size > 0) css += `font-size: ${size}px !important;`;
        css += "}";
        chatFontStyleEl.textContent = css;
    }

    /**
     * Lurk mode — grey out chat input and show indicator.
     */
    function enableLurkMode() {
        document.body.classList.add("tp-lurk-active");

        // Add indicator if not present
        if (!document.querySelector(".tp-lurk-indicator")) {
            const chatInputArea = document.querySelector(
                ".chat-input, [data-a-target=\"chat-input\"]"
            )?.closest(".chat-input");
            if (chatInputArea) {
                chatInputArea.style.position = "relative";
                const indicator = document.createElement("div");
                indicator.className = "tp-lurk-indicator";
                indicator.textContent = t("lurk_indicator");
                chatInputArea.appendChild(indicator);
            }
        }
    }

    function disableLurkMode() {
        document.body.classList.remove("tp-lurk-active");
        const indicator = document.querySelector(".tp-lurk-indicator");
        if (indicator) indicator.remove();
    }

    /**
     * Anonymous chat — show a prompt when the user tries to send a message,
     * asking if they want to leave anonymous mode.
     */
    function showAnonPrompt() {
        // Don't stack multiple prompts
        if (document.querySelector(".tp-anon-prompt")) return;

        const chatContainer = document.querySelector(".stream-chat") ||
                              document.querySelector(".chat-shell") ||
                              document.querySelector("[data-test-selector='chat-room-component-layout']");
        if (!chatContainer) return;

        const prompt = document.createElement("div");
        prompt.className = "tp-anon-prompt";

        const msg = document.createElement("p");
        msg.textContent = t("anon_leave_msg");
        prompt.appendChild(msg);

        const buttons = document.createElement("div");
        buttons.className = "tp-anon-prompt-buttons";

        const leaveBtn = document.createElement("button");
        leaveBtn.className = "tp-anon-prompt-btn primary";
        leaveBtn.textContent = t("anon_leave_btn");
        leaveBtn.addEventListener("click", () => {
            prompt.remove();
            // Disable anonymous mode
            settings.anonChat = false;
            browser.runtime.sendMessage({ type: "setSetting", key: "anonChat", value: false });
            applySettingChange("anonChat", false);
            // Update toggle in settings panel if open
            const toggle = document.querySelector('[data-setting="anonChat"]');
            if (toggle) toggle.checked = false;
        });

        const cancelBtn = document.createElement("button");
        cancelBtn.className = "tp-anon-prompt-btn secondary";
        cancelBtn.textContent = t("anon_cancel");
        cancelBtn.addEventListener("click", () => {
            prompt.remove();
        });

        buttons.appendChild(leaveBtn);
        buttons.appendChild(cancelBtn);
        prompt.appendChild(buttons);

        // Ensure container has positioning context
        const pos = getComputedStyle(chatContainer).position;
        if (pos === "static") chatContainer.style.position = "relative";
        chatContainer.appendChild(prompt);
    }

    // Listen for blocked message attempts in anonymous mode (WebSocket-level fallback)
    document.addEventListener("tp-anon-msg-blocked", () => {
        if (settings.anonChat) showAnonPrompt();
    });

    // Intercept chat input at the DOM level (capturing phase — fires before React).
    // This catches Enter key and Send button clicks regardless of whether Twitch
    // uses IRC PRIVMSG or GQL mutations to send messages.
    document.addEventListener("keydown", (e) => {
        if (!settings.anonChat) return;
        if (e.key !== "Enter" || e.shiftKey) return; // Shift+Enter = newline, not send
        const target = e.target;
        const isChatInput = target.matches(
            "[data-a-target='chat-input'], " +
            "[data-a-target='chat-input'] textarea, " +
            "[data-a-target='chat-input'] [contenteditable], " +
            ".chat-wysiwyg-input__editor, " +
            ".chat-wysiwyg-input__editor *"
        );
        if (!isChatInput) return;
        // Check if there's actual text to send
        const text = (target.value || target.textContent || "").trim();
        if (!text) return;
        e.stopPropagation();
        e.preventDefault();
        showAnonPrompt();
    }, true); // true = capturing phase

    document.addEventListener("click", (e) => {
        if (!settings.anonChat) return;
        const btn = e.target.closest("[data-a-target='chat-send-button']");
        if (!btn) return;
        e.stopPropagation();
        e.preventDefault();
        showAnonPrompt();
    }, true); // true = capturing phase

    /**
     * Inject a system-style message into the chat area (like BTTV admin messages).
     */
    function injectChatAdminMessage(text) {
        const container = document.querySelector(
            ".chat-scrollable-area__message-container"
        );
        if (!container) return;

        const msgDiv = document.createElement("div");
        msgDiv.className = "chat-line__status";
        msgDiv.style.cssText = "padding: 5px 20px; color: #bf94ff; font-size: 13px; opacity: 0.85;";
        msgDiv.textContent = text;
        container.appendChild(msgDiv);

        // Scroll to bottom
        const scroller = container.closest(".simplebar-scroll-content") ||
                         container.closest("[class*='scrollable']");
        if (scroller) {
            requestAnimationFrame(() => {
                scroller.scrollTop = scroller.scrollHeight;
            });
        }
    }

    // Listen for anon mode status changes from injected.js
    document.addEventListener("tp-anon-status", (e) => {
        const { active } = e.detail || {};
        if (active) {
            showAnonBanner();
        } else {
            removeAnonBanner();
            injectChatAdminMessage("[Twitch Plus] Reconnecting to chat...");
            // Dim the chat input while reconnecting
            const chatInput = document.querySelector(".chat-input");
            if (chatInput) chatInput.style.opacity = "0.4";
        }
    });

    // Listen for confirmed reconnection after leaving anon mode
    document.addEventListener("tp-anon-rejoined", () => {
        console.log("[Twitch Plus] Anon reconnect confirmed — chat is ready.");
        injectChatAdminMessage("[Twitch Plus] Reconnected — you can chat again.");
        // Restore chat input
        const chatInput = document.querySelector(".chat-input");
        if (chatInput) chatInput.style.opacity = "";
        // Scroll chat to bottom to flush any pending renders
        const container = document.querySelector(".chat-scrollable-area__message-container");
        if (container) {
            const scroller = container.closest(".simplebar-scroll-content") ||
                             container.closest("[class*='scrollable']");
            if (scroller) {
                requestAnimationFrame(() => {
                    scroller.scrollTop = scroller.scrollHeight;
                });
            }
        }
    });

    /**
     * Show a persistent banner at the bottom of the chat (above the input),
     * similar to Twitch's native "reconnecting to chat..." status bar.
     */
    function showAnonBanner() {
        if (document.querySelector(".tp-anon-banner")) return;

        // Find the chat input area — the banner sits right above it
        const chatInput = document.querySelector(".chat-input") ||
                          document.querySelector("[data-a-target='chat-input']")?.closest(".chat-input") ||
                          document.querySelector(".chat-input__buttons-container")?.parentElement;
        if (!chatInput) {
            // Fallback: just inject as chat message if we can't find the input area
            injectChatAdminMessage("[Twitch Plus] Anonymous mode — you are hidden.");
            return;
        }

        const banner = document.createElement("div");
        banner.className = "tp-anon-banner";
        banner.textContent = t("anon_chat_banner") || "Anonymous mode — you are hidden.";
        chatInput.parentElement.insertBefore(banner, chatInput);
    }

    function removeAnonBanner() {
        document.querySelectorAll(".tp-anon-banner").forEach(el => el.remove());
    }

    /**
     * Emote tab-completion system.
     */
    let completionDropdown = null;
    let completionIndex = -1;
    let completionMatches = [];
    let completionActive = false;

    function initEmoteCompletion() {
        if (!settings.emoteTabCompletion) return;

        const chatInput = document.querySelector(
            "[data-a-target=\"chat-input\"] textarea, " +
            "[data-a-target=\"chat-input\"] [contenteditable]"
        );
        if (!chatInput || chatInput.dataset.tpCompletionInit) return;
        chatInput.dataset.tpCompletionInit = "1";

        chatInput.addEventListener("input", onCompletionInput);
        chatInput.addEventListener("keydown", onCompletionKeydown);
        chatInput.addEventListener("blur", () => {
            setTimeout(hideCompletionDropdown, 150);
        });
    }

    function onCompletionInput(e) {
        const input = e.target;
        const text = input.value ?? input.textContent ?? "";
        const cursorPos = input.selectionStart ?? text.length;
        const beforeCursor = text.substring(0, cursorPos);
        const lastWord = beforeCursor.split(/\s/).pop();

        if (lastWord.length >= 2 && emoteNamesSorted.length > 0) {
            const lower = lastWord.toLowerCase();
            // Binary search for first entry starting with the prefix
            let lo = 0, hi = emoteNamesSorted.length;
            while (lo < hi) {
                const mid = (lo + hi) >>> 1;
                if (emoteNamesSorted[mid].lower < lower) lo = mid + 1; else hi = mid;
            }
            const matches = [];
            for (let i = lo; i < emoteNamesSorted.length && matches.length < 10; i++) {
                const entry = emoteNamesSorted[i];
                if (!entry.lower.startsWith(lower)) break;
                const emote = emoteMap.get(entry.name);
                if (emote) matches.push([entry.name, emote]);
            }

            if (matches.length > 0) {
                showCompletionDropdown(input, matches, lastWord);
                return;
            }
        }
        hideCompletionDropdown();
    }

    function onCompletionKeydown(e) {
        if (!completionActive) return;

        if (e.key === "ArrowDown") {
            e.preventDefault();
            completionIndex = Math.min(completionIndex + 1, completionMatches.length - 1);
            updateCompletionHighlight();
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            completionIndex = Math.max(completionIndex - 1, 0);
            updateCompletionHighlight();
        } else if (e.key === "Tab" || e.key === "Enter") {
            if (completionIndex >= 0 && completionIndex < completionMatches.length) {
                e.preventDefault();
                selectCompletion(e.target, completionMatches[completionIndex][0]);
            }
        } else if (e.key === "Escape") {
            hideCompletionDropdown();
        }
    }

    function showCompletionDropdown(input, matches, partialWord) {
        hideCompletionDropdown();
        completionActive = true;
        completionMatches = matches;
        completionIndex = 0;

        completionDropdown = document.createElement("div");
        completionDropdown.className = "tp-completion-dropdown";

        matches.forEach(([name, emote], idx) => {
            const item = document.createElement("div");
            item.className = "tp-completion-item" + (idx === 0 ? " tp-completion-active" : "");

            const img = document.createElement("img");
            img.src = emote.url1x;
            img.alt = name;
            img.loading = "lazy";
            item.appendChild(img);

            const nameSpan = document.createElement("span");
            nameSpan.className = "tp-completion-item-name";
            nameSpan.textContent = name;
            item.appendChild(nameSpan);

            const sourceSpan = document.createElement("span");
            sourceSpan.className = "tp-completion-item-source";
            sourceSpan.textContent = emote.source;
            item.appendChild(sourceSpan);

            item.addEventListener("mousedown", (e) => {
                e.preventDefault();
                selectCompletion(input, name);
            });

            completionDropdown.appendChild(item);
        });

        // Position relative to the chat input area
        const inputContainer = input.closest(".chat-input") || input.parentElement;
        if (inputContainer) {
            inputContainer.style.position = "relative";
            inputContainer.appendChild(completionDropdown);
        }
    }

    function hideCompletionDropdown() {
        if (completionDropdown) {
            completionDropdown.remove();
            completionDropdown = null;
        }
        completionActive = false;
        completionIndex = -1;
        completionMatches = [];
    }

    function updateCompletionHighlight() {
        if (!completionDropdown) return;
        const items = completionDropdown.querySelectorAll(".tp-completion-item");
        items.forEach((item, idx) => {
            item.classList.toggle("tp-completion-active", idx === completionIndex);
        });
        // Scroll into view
        items[completionIndex]?.scrollIntoView({ block: "nearest" });
    }

    function selectCompletion(input, emoteName) {
        const text = input.value ?? input.textContent ?? "";
        const cursorPos = input.selectionStart ?? text.length;
        const beforeCursor = text.substring(0, cursorPos);
        const afterCursor = text.substring(cursorPos);

        // Replace the partial word with the emote name
        const lastSpaceIdx = beforeCursor.lastIndexOf(" ");
        const newBefore = beforeCursor.substring(0, lastSpaceIdx + 1) + emoteName + " ";

        if (input.value !== undefined) {
            // Textarea
            const nativeSetter = Object.getOwnPropertyDescriptor(
                window.HTMLTextAreaElement.prototype, "value"
            )?.set;
            if (nativeSetter) {
                nativeSetter.call(input, newBefore + afterCursor);
            } else {
                input.value = newBefore + afterCursor;
            }
            input.selectionStart = input.selectionEnd = newBefore.length;
        } else {
            // Contenteditable
            input.textContent = newBefore + afterCursor;
        }

        input.dispatchEvent(new Event("input", { bubbles: true }));
        hideCompletionDropdown();
        input.focus();
    }

    // ---------------------------------------------------------------------------
    // 9. Emote Menu / Picker
    // ---------------------------------------------------------------------------

    function injectEmoteMenuButton() {
        if (settings.emoteMenuEnabled === false) return;
        if (document.querySelector(".tp-emote-menu-btn")) return;

        const chatButtons = document.querySelector(".chat-input__buttons-container");
        if (!chatButtons) return;

        const btn = document.createElement("button");
        btn.className = "tp-emote-menu-btn";
        btn.title = t("emote_menu_title");
        btn.innerHTML = `<svg viewBox="0 0 20 20"><path d="M10 0C4.477 0 0 4.477 0 10s4.477 10 10 10 10-4.477 10-10S15.523 0 10 0zm0 18.5a8.5 8.5 0 1 1 0-17 8.5 8.5 0 0 1 0 17zM6.5 7.5a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5zm7 0a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5zM5 11.5a.75.75 0 0 1 .68-.44h8.64a.75.75 0 0 1 .68 1.06A5.48 5.48 0 0 1 10 15a5.48 5.48 0 0 1-4.32-2.88.75.75 0 0 1 .32-.62z"/></svg>`;
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            toggleEmoteMenu(btn);
        });
        chatButtons.prepend(btn);
    }

    function toggleEmoteMenu(anchorBtn) {
        if (emoteMenuOpen) { closeEmoteMenu(); return; }
        openEmoteMenu(anchorBtn);
    }

    function openEmoteMenu(anchorBtn) {
        closeEmoteMenu();
        emoteMenuOpen = true;

        const menu = document.createElement("div");
        menu.className = "tp-emote-menu";

        // Position above the button (responsive for mobile)
        const rect = anchorBtn.getBoundingClientRect();
        const isMobile = window.innerWidth <= 500;
        if (isMobile) {
            // On mobile, CSS handles width/left/right/bottom via @media query
            menu.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 4)}px`;
        } else {
            menu.style.bottom = `${window.innerHeight - rect.top + 4}px`;
            menu.style.right = `${window.innerWidth - rect.right}px`;
        }

        // Header with search
        const header = document.createElement("div");
        header.className = "tp-emote-menu-header";
        const searchInput = document.createElement("input");
        searchInput.className = "tp-emote-search";
        searchInput.placeholder = t("emote_search_ph");
        searchInput.type = "text";
        header.appendChild(searchInput);
        const closeBtn = document.createElement("button");
        closeBtn.className = "tp-emote-menu-close";
        closeBtn.innerHTML = "✕";
        closeBtn.addEventListener("click", closeEmoteMenu);
        header.appendChild(closeBtn);
        menu.appendChild(header);

        // Tabs
        const providers = ["\u2605", "All", "BTTV", "FFZ", "7TV"];
        const tabBar = document.createElement("div");
        tabBar.className = "tp-emote-tabs";
        let activeProvider = "All";

        const grid = document.createElement("div");
        grid.className = "tp-emote-grid";

        function renderGrid(filter, providerFilter) {
            grid.innerHTML = "";
            const entries = [...emoteMap.entries()];
            let filtered = entries;

            // Frequently Used tab — show only emotes with usage, sorted by count
            if (providerFilter === "\u2605") {
                filtered = filtered.filter(([name]) => frequentEmotes[name] > 0);
                filtered.sort((a, b) => (frequentEmotes[b[0]] || 0) - (frequentEmotes[a[0]] || 0));
            } else if (providerFilter && providerFilter !== "All") {
                const pMap = { "BTTV": "bttv", "FFZ": "ffz", "7TV": "7tv" };
                const pKey = pMap[providerFilter];
                filtered = filtered.filter(([, e]) => e.source === pKey);
            }
            if (filter) {
                const lower = filter.toLowerCase();
                filtered = filtered.filter(([name]) => name.toLowerCase().includes(lower));
                // Sort: exact match > prefix match > substring match, then alphabetical
                filtered.sort((a, b) => {
                    const aName = a[0].toLowerCase();
                    const bName = b[0].toLowerCase();
                    const aExact = aName === lower;
                    const bExact = bName === lower;
                    if (aExact !== bExact) return aExact ? -1 : 1;
                    const aPrefix = aName.startsWith(lower);
                    const bPrefix = bName.startsWith(lower);
                    if (aPrefix !== bPrefix) return aPrefix ? -1 : 1;
                    return aName.localeCompare(bName);
                });
            }
            if (filtered.length === 0) {
                const empty = document.createElement("div");
                empty.className = "tp-emote-grid-empty";
                empty.textContent = t("emote_search_empty");
                grid.appendChild(empty);
                return;
            }
            // Limit to 200 for performance
            filtered.slice(0, 200).forEach(([name, emote]) => {
                const cell = document.createElement("div");
                cell.className = "tp-emote-cell";
                cell.title = name;
                const img = document.createElement("img");
                img.src = emote.url1x;
                img.alt = name;
                img.loading = "lazy";
                cell.appendChild(img);
                cell.addEventListener("click", () => {
                    insertEmoteInChat(name);
                    closeEmoteMenu();
                });
                grid.appendChild(cell);
            });
        }

        providers.forEach((p) => {
            const tab = document.createElement("button");
            tab.className = "tp-emote-tab" + (p === activeProvider ? " tp-emote-tab-active" : "");
            tab.textContent = p;
            if (p === "\u2605") tab.title = t("emote_tab_frequent");
            tab.addEventListener("click", () => {
                activeProvider = p;
                tabBar.querySelectorAll(".tp-emote-tab").forEach((t) =>
                    t.classList.toggle("tp-emote-tab-active", t.textContent === p));
                renderGrid(searchInput.value, p);
            });
            tabBar.appendChild(tab);
        });
        menu.appendChild(tabBar);

        searchInput.addEventListener("input", () => {
            renderGrid(searchInput.value, activeProvider);
        });

        menu.appendChild(grid);
        renderGrid("", "All");

        document.body.appendChild(menu);
        searchInput.focus();

        // Close on outside click
        setTimeout(() => {
            document.addEventListener("click", onEmoteMenuOutsideClick);
        }, 50);
        document.addEventListener("keydown", onEmoteMenuEscape);
    }

    function closeEmoteMenu() {
        emoteMenuOpen = false;
        const menu = document.querySelector(".tp-emote-menu");
        if (menu) menu.remove();
        document.removeEventListener("click", onEmoteMenuOutsideClick);
        document.removeEventListener("keydown", onEmoteMenuEscape);
    }

    function onEmoteMenuOutsideClick(e) {
        if (!e.target.closest(".tp-emote-menu") && !e.target.closest(".tp-emote-menu-btn")) {
            closeEmoteMenu();
        }
    }

    function onEmoteMenuEscape(e) {
        if (e.key === "Escape") closeEmoteMenu();
    }

    function insertEmoteInChat(emoteName) {
        // Twitch uses Slate.js with a contenteditable div, not a textarea.
        // We need to find the Slate editor and insert via execCommand or InputEvent.
        const editor = document.querySelector(
            "[data-slate-editor='true'], " +
            "[data-a-target='chat-input'] [role='textbox'], " +
            "[data-a-target='chat-input'] [contenteditable='true']"
        );
        if (!editor) {
            // Fallback: try legacy textarea selector
            const textarea = document.querySelector("[data-a-target='chat-input'] textarea");
            if (textarea) {
                textarea.focus();
                const nativeSetter = Object.getOwnPropertyDescriptor(
                    window.HTMLTextAreaElement.prototype, "value"
                )?.set;
                const text = textarea.value || "";
                const insert = (text && !text.endsWith(" ") ? " " : "") + emoteName + " ";
                if (nativeSetter) {
                    nativeSetter.call(textarea, text + insert);
                } else {
                    textarea.value = text + insert;
                }
                textarea.dispatchEvent(new Event("input", { bubbles: true }));
                return;
            }
            console.warn("[Twitch Plus] Could not find chat input element for emote insertion");
            return;
        }

        editor.focus();

        // Move caret to end of content
        const selection = window.getSelection();
        if (selection && editor.lastChild) {
            const range = document.createRange();
            range.selectNodeContents(editor);
            range.collapse(false); // collapse to end
            selection.removeAllRanges();
            selection.addRange(range);
        }

        // Check if there's existing text and add space if needed
        const existingText = editor.textContent || "";
        const prefix = existingText && !existingText.endsWith(" ") ? " " : "";
        const textToInsert = prefix + emoteName + " ";

        // Use execCommand('insertText') — Slate.js listens for beforeinput events
        // which execCommand triggers, making it recognize the insertion.
        const inserted = document.execCommand("insertText", false, textToInsert);
        if (!inserted) {
            // Fallback: dispatch InputEvent directly
            const inputEvent = new InputEvent("beforeinput", {
                inputType: "insertText",
                data: textToInsert,
                bubbles: true,
                cancelable: true,
                composed: true,
            });
            editor.dispatchEvent(inputEvent);

            // Also dispatch input event for any additional listeners
            editor.dispatchEvent(new InputEvent("input", {
                inputType: "insertText",
                data: textToInsert,
                bubbles: true,
            }));
        }

        // Track emote usage for "Frequently Used" tab
        if (emoteMap.has(emoteName)) {
            frequentEmotes[emoteName] = (frequentEmotes[emoteName] || 0) + 1;
            browser.runtime.sendMessage({
                action: "saveFrequentEmotes",
                data: frequentEmotes,
            }).catch(() => {});
        }
    }

    // ---------------------------------------------------------------------------
    // 10. Pronouns in Chat
    // ---------------------------------------------------------------------------

    async function applyPronouns(messageEl) {
        if (!settings.showPronouns) return;
        const nameEl = messageEl.querySelector(
            "[data-a-target=\"chat-message-username\"], .chat-author__display-name"
        );
        if (!nameEl || nameEl.querySelector(".tp-pronoun-badge")) return;

        const login = (nameEl.textContent || "").trim().toLowerCase();
        if (!login) return;

        try {
            const resp = await browser.runtime.sendMessage({ action: "getPronouns", login });
            if (resp?.pronouns) {
                const badge = document.createElement("span");
                badge.className = "tp-pronoun-badge";
                badge.textContent = resp.pronouns;
                nameEl.parentElement.insertBefore(badge, nameEl.nextSibling);
            }
        } catch (e) { /* ignore */ }
    }

    // ---------------------------------------------------------------------------
    // 11. Enhanced User Cards
    // ---------------------------------------------------------------------------

    let userCardObserver = null;

    function initEnhancedUserCards() {
        if (settings.enhancedUserCards === false) return;
        // Prevent stacking observers on repeated channel changes
        if (userCardObserver) return;

        userCardObserver = new MutationObserver((mutations) => {
            for (const m of mutations) {
                for (const node of m.addedNodes) {
                    if (node.nodeType !== Node.ELEMENT_NODE) continue;
                    const card = node.querySelector?.("[data-a-target=\"user-card-modal\"]") ||
                        (node.matches?.("[data-a-target=\"user-card-modal\"]") ? node : null);
                    if (card && !card.dataset.tpEnhanced) {
                        card.dataset.tpEnhanced = "1";
                        enhanceUserCard(card);
                    }
                }
            }
        });
        // Scope to the chat container instead of document.body when possible
        const chatRoot = document.querySelector(".stream-chat") || document.body;
        userCardObserver.observe(chatRoot, { childList: true, subtree: true });
    }

    function stopEnhancedUserCards() {
        if (userCardObserver) {
            userCardObserver.disconnect();
            userCardObserver = null;
        }
    }

    async function enhanceUserCard(card) {
        // Extract username from the card
        const nameEl = card.querySelector("[data-a-target=\"user-card-modal\"] h4, [data-a-target=\"user-card-username\"]");
        if (!nameEl) return;
        const login = nameEl.textContent.trim().toLowerCase();
        if (!login) return;

        // Request data from injected.js via custom event
        document.dispatchEvent(new CustomEvent("tp-request-user-data", { detail: { login } }));

        const handler = (e) => {
            if (e.detail?.login !== login) return;
            document.removeEventListener("tp-user-data-response", handler);

            const data = e.detail;
            if (!data.createdAt && !data.followDate) return;

            const container = document.createElement("div");
            container.className = "tp-usercard-extra";

            if (data.createdAt) {
                const created = new Date(data.createdAt);
                const age = getRelativeTime(created);
                const row = document.createElement("div");
                row.className = "tp-usercard-row";
                row.innerHTML = `<svg viewBox="0 0 16 16"><path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0zm0 14.5a6.5 6.5 0 1 1 0-13 6.5 6.5 0 0 1 0 13zm.75-10v4l3 1.75-.75 1.3L7.25 9.5V4.5h1.5z"/></svg>`;
                const span = document.createElement("span");
                span.textContent = `Account created ${age} (${created.toLocaleDateString()})`;
                row.appendChild(span);
                container.appendChild(row);
            }

            if (data.followDate) {
                const followed = new Date(data.followDate);
                const age = getRelativeTime(followed);
                const row = document.createElement("div");
                row.className = "tp-usercard-row";
                row.innerHTML = `<svg viewBox="0 0 16 16"><path d="M8 1.5l2.1 4.2 4.7.7-3.4 3.3.8 4.6L8 12.1l-4.2 2.2.8-4.6-3.4-3.3 4.7-.7z"/></svg>`;
                const span = document.createElement("span");
                span.textContent = `Following for ${age} (${followed.toLocaleDateString()})`;
                row.appendChild(span);
                container.appendChild(row);
            }

            // Insert after the existing card content
            const cardBody = card.querySelector("[class*='user-card']") || card;
            cardBody.appendChild(container);
        };
        document.addEventListener("tp-user-data-response", handler);

        // Timeout cleanup
        setTimeout(() => document.removeEventListener("tp-user-data-response", handler), 5000);
    }

    function getRelativeTime(date) {
        const now = new Date();
        const diffMs = now - date;
        const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
        if (days < 1) return "today";
        if (days < 30) return `${days}d ago`;
        const months = Math.floor(days / 30);
        if (months < 12) return `${months}mo ago`;
        const years = Math.floor(months / 12);
        const remainMonths = months % 12;
        return remainMonths > 0 ? `${years}y ${remainMonths}mo ago` : `${years}y ago`;
    }

    // ---------------------------------------------------------------------------
    // 12. Slow Mode Countdown
    // ---------------------------------------------------------------------------

    function initSlowModeCountdown() {
        if (settings.slowModeCountdown === false) return;

        const chatInput = document.querySelector("[data-a-target=\"chat-input\"] textarea, [data-a-target=\"chat-input\"] [contenteditable]");
        if (!chatInput || chatInput.dataset.tpSlowInit) return;
        chatInput.dataset.tpSlowInit = "1";

        chatInput.addEventListener("keydown", (e) => {
            if (e.key !== "Enter") return;
            // Check if slow mode notice exists
            const slowNotice = document.querySelector("[data-a-target=\"chat-input-buttons-container\"] [class*=\"slow-mode\"], .chat-input [class*=\"slow\"]");
            if (!slowNotice) return;

            // Extract seconds from the slow mode state (try to parse from text)
            const text = slowNotice.textContent || "";
            const match = text.match(/(\d+)/);
            const seconds = match ? parseInt(match[1]) : 30;

            showSlowModeCountdown(seconds);
        });
    }

    function showSlowModeCountdown(seconds) {
        const sendBtn = document.querySelector("[data-a-target=\"chat-send-button\"]");
        if (!sendBtn) return;

        // Clear any existing countdown
        if (slowModeTimer) clearInterval(slowModeTimer);
        const existing = sendBtn.parentElement?.querySelector(".tp-slow-countdown");
        if (existing) existing.remove();

        sendBtn.parentElement.style.position = "relative";
        const overlay = document.createElement("div");
        overlay.className = "tp-slow-countdown";
        let remaining = seconds;
        overlay.textContent = `${remaining}s`;
        sendBtn.parentElement.appendChild(overlay);

        slowModeTimer = setInterval(() => {
            remaining--;
            if (remaining <= 0) {
                clearInterval(slowModeTimer);
                slowModeTimer = null;
                overlay.remove();
                return;
            }
            overlay.textContent = `${remaining}s`;
        }, 1000);
    }

    // ---------------------------------------------------------------------------
    // 13. Spam Detection + Emote Combo Counter
    // ---------------------------------------------------------------------------

    const comboTracker = new Map(); // text → { count, lastSeen, displayText }
    let comboWidgetEl = null;

    function checkSpamMessage(messageEl) {
        if (!settings.spamFilter) return false;

        // Get message text — try multiple selectors to catch emote-only messages too
        const msgBody = messageEl.querySelector(
            "[data-a-target='chat-message-text'], .chat-line__message-body, [class*='message-container'], .vod-message__content"
        );
        if (!msgBody) return false;

        const text = msgBody.textContent.trim().toLowerCase().replace(/\s+/g, " ");
        if (!text || text.length < 1) return false;

        const now = Date.now();
        const windowMs = (settings.spamWindow || 10) * 1000;
        const threshold = settings.spamThreshold || 3;

        // --- Sliding window tracking ---
        let entry = spamBuffer.get(text);
        if (!entry) {
            entry = [];
            spamBuffer.set(text, entry);
        }

        entry.push(now);

        // Remove timestamps outside the window (binary search for cutoff)
        const cutoff = now - windowMs;
        let lo = 0;
        while (lo < entry.length && entry[lo] < cutoff) lo++;
        if (lo > 0) entry.splice(0, lo);

        // --- Combo counter tracking ---
        const displayText = msgBody.textContent.trim().replace(/\s+/g, " ");
        const comboEntry = comboTracker.get(text) || { count: 0, lastSeen: 0, displayText };
        comboEntry.count = entry.length;
        comboEntry.lastSeen = now;
        comboEntry.displayText = displayText.length > 30 ? displayText.slice(0, 30) + "…" : displayText;
        comboTracker.set(text, comboEntry);

        // Prune old combo entries
        if (comboTracker.size > 100) {
            for (const [key, val] of comboTracker) {
                if (val.lastSeen < now - windowMs * 2) comboTracker.delete(key);
            }
        }

        // Update combo widget
        updateComboWidget();

        // Check threshold — hide if spam
        if (entry.length >= threshold) {
            messageEl.classList.add("tp-spam-hidden");
            return true;
        }

        // Clean up old spam buffer entries periodically
        if (spamBuffer.size > 500) {
            for (const [key, timestamps] of spamBuffer) {
                if (timestamps.length === 0 || timestamps[timestamps.length - 1] < now - windowMs) {
                    spamBuffer.delete(key);
                }
            }
        }

        return false;
    }

    function updateComboWidget() {
        const now = Date.now();
        const windowMs = (settings.spamWindow || 10) * 1000;
        const threshold = settings.spamThreshold || 3;

        // Get top 5 active combos above threshold
        const activeCombos = [];
        for (const [key, val] of comboTracker) {
            if (val.count >= threshold && val.lastSeen > now - windowMs) {
                activeCombos.push(val);
            }
        }
        activeCombos.sort((a, b) => b.count - a.count);
        const top5 = activeCombos.slice(0, 5);

        if (top5.length === 0) {
            if (comboWidgetEl) { comboWidgetEl.remove(); comboWidgetEl = null; }
            return;
        }

        if (!comboWidgetEl) {
            comboWidgetEl = document.createElement("div");
            comboWidgetEl.className = "tp-combo-widget";
            const chatContainer = findChatContainer();
            if (chatContainer) {
                chatContainer.parentElement?.appendChild(comboWidgetEl);
            } else {
                document.body.appendChild(comboWidgetEl);
            }
        }

        comboWidgetEl.innerHTML = top5.map((c) =>
            `<div class="tp-combo-row"><span class="tp-combo-text">${escapeHtml(c.displayText)}</span><span class="tp-combo-count">×${c.count}</span></div>`
        ).join("");
    }

    const HTML_ESCAPE_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    const HTML_ESCAPE_RE = /[&<>"']/g;

    function escapeHtml(str) {
        return str.replace(HTML_ESCAPE_RE, (ch) => HTML_ESCAPE_MAP[ch]);
    }

    // ---------------------------------------------------------------------------
    // 14. Bot Hiding
    // ---------------------------------------------------------------------------

    async function loadKnownBots() {
        try {
            const resp = await browser.runtime.sendMessage({ action: "getKnownBots" });
            if (resp?.bots) {
                knownBots = new Set(resp.bots);
            }
        } catch (e) { /* ignore */ }
    }

    function checkBotMessage(messageEl) {
        if (!settings.hideBots || knownBots.size === 0) return false;

        const nameEl = messageEl.querySelector(
            "[data-a-target=\"chat-message-username\"], .chat-author__display-name"
        );
        if (!nameEl) return false;

        const username = nameEl.textContent.trim().toLowerCase();
        if (knownBots.has(username)) {
            messageEl.classList.add("tp-bot-hidden");
            return true;
        }
        return false;
    }

    // ---------------------------------------------------------------------------
    // 15. YouTube Link Preview
    // ---------------------------------------------------------------------------

    function attachYoutubePreviewListeners(messageEl) {
        if (settings.youtubePreview === false) return;

        const links = messageEl.querySelectorAll("a[href]");
        for (const link of links) {
            const href = link.href || "";
            if (!isYoutubeUrl(href)) continue;

            link.addEventListener("mouseenter", (e) => showYoutubePreview(e, href));
            link.addEventListener("mouseleave", hideYoutubePreview);
            // Touch: long-press to preview, tap navigates normally
            let ytTouchTimer = null;
            link.addEventListener("touchstart", (e) => {
                ytTouchTimer = setTimeout(() => {
                    e.preventDefault();
                    showYoutubePreview(e, href);
                    const dismiss = () => { hideYoutubePreview(); document.removeEventListener("touchstart", dismiss, true); };
                    setTimeout(() => document.addEventListener("touchstart", dismiss, true), 50);
                }, 500);
            }, { passive: false });
            link.addEventListener("touchend", () => clearTimeout(ytTouchTimer));
            link.addEventListener("touchmove", () => clearTimeout(ytTouchTimer));
        }
    }

    const YOUTUBE_URL_RE = /(?:youtube\.com\/watch|youtu\.be\/|youtube\.com\/shorts\/)/;

    function isYoutubeUrl(url) {
        return YOUTUBE_URL_RE.test(url);
    }

    async function showYoutubePreview(e, url) {
        hideYoutubePreview();

        try {
            const resp = await browser.runtime.sendMessage({ action: "getYoutubePreview", url });
            if (!resp?.preview) return;

            ytPreviewEl = document.createElement("div");
            ytPreviewEl.className = "tp-yt-preview";

            if (resp.preview.thumbnail) {
                const img = document.createElement("img");
                img.src = resp.preview.thumbnail;
                img.alt = "";
                ytPreviewEl.appendChild(img);
            }

            const info = document.createElement("div");
            info.className = "tp-yt-preview-info";

            const title = document.createElement("div");
            title.className = "tp-yt-preview-title";
            title.textContent = resp.preview.title;
            info.appendChild(title);

            if (resp.preview.author) {
                const author = document.createElement("div");
                author.className = "tp-yt-preview-author";
                author.textContent = resp.preview.author;
                info.appendChild(author);
            }

            ytPreviewEl.appendChild(info);
            document.body.appendChild(ytPreviewEl);

            // Position above the link
            const rect = e.target.getBoundingClientRect();
            const tooltipRect = ytPreviewEl.getBoundingClientRect();
            let top = rect.top - tooltipRect.height - 8;
            let left = rect.left;
            if (top < 4) top = rect.bottom + 8;
            if (left + tooltipRect.width > window.innerWidth - 4) {
                left = window.innerWidth - tooltipRect.width - 4;
            }
            ytPreviewEl.style.top = `${top}px`;
            ytPreviewEl.style.left = `${left}px`;
        } catch (e) { /* ignore */ }
    }

    function hideYoutubePreview() {
        if (ytPreviewEl) { ytPreviewEl.remove(); ytPreviewEl = null; }
    }

    // ---------------------------------------------------------------------------
    // 16. Picture-in-Picture Button
    // ---------------------------------------------------------------------------

    function injectPipButton() {
        if (settings.pipButton === false) return;
        if (document.querySelector(".tp-pip-btn")) return;

        const controls = document.querySelector(".player-controls__right-control-group, [data-a-target=\"player-controls\"] .player-controls__right-control-group");
        if (!controls) return;

        const btn = document.createElement("button");
        btn.className = "tp-player-btn tp-pip-btn";
        btn.title = t("pip_title");
        btn.innerHTML = `<svg viewBox="0 0 20 20"><path d="M2 3a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1H2zm0 1.5h16v11H2v-11zm8.5 5h5.5v4.5h-5.5v-4.5z"/></svg>`;

        btn.addEventListener("click", async () => {
            const video = document.querySelector("video");
            if (!video) return;
            try {
                if (document.pictureInPictureElement) {
                    await document.exitPictureInPicture();
                } else {
                    await video.requestPictureInPicture();
                }
            } catch (e) {
                console.warn("[Twitch Plus] PiP failed:", e);
            }
        });

        // Update icon state
        const video = document.querySelector("video");
        if (video) {
            video.addEventListener("enterpictureinpicture", () => btn.classList.add("tp-pip-active"));
            video.addEventListener("leavepictureinpicture", () => btn.classList.remove("tp-pip-active"));
        }

        controls.prepend(btn);
    }

    // ---------------------------------------------------------------------------
    // 17. Screenshot Capture
    // ---------------------------------------------------------------------------

    function injectScreenshotButton() {
        if (settings.screenshotButton === false) return;
        if (document.querySelector(".tp-screenshot-btn")) return;

        const controls = document.querySelector(".player-controls__right-control-group, [data-a-target=\"player-controls\"] .player-controls__right-control-group");
        if (!controls) return;

        const btn = document.createElement("button");
        btn.className = "tp-player-btn tp-screenshot-btn";
        btn.title = t("screenshot_title");
        btn.innerHTML = `<svg viewBox="0 0 20 20"><path d="M7.5 2L6 4H3a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1h-3l-1.5-2h-5zM10 14a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm0-1.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z"/></svg>`;

        btn.addEventListener("click", () => {
            const video = document.querySelector("video");
            if (!video) return;

            const canvas = document.createElement("canvas");
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(video, 0, 0);

            canvas.toBlob((blob) => {
                if (!blob) return;
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `twitch-screenshot-${Date.now()}.png`;
                a.click();
                URL.revokeObjectURL(url);

                // Flash effect
                const flash = document.createElement("div");
                flash.className = "tp-screenshot-flash";
                document.body.appendChild(flash);
                flash.addEventListener("animationend", () => flash.remove());
            }, "image/png");
        });

        controls.prepend(btn);
    }

    // ---------------------------------------------------------------------------
    // 17b. (Removed) Audio Compressor — not possible in Safari (WebKit bug #231656)
    // ---------------------------------------------------------------------------

    // ---------------------------------------------------------------------------
    // 17c. Player Controls Observer (re-inject buttons when Twitch re-renders)
    // ---------------------------------------------------------------------------

    let playerControlsObserver = null;
    let playerButtonCheckTimer = null;

    function ensurePlayerButtons() {
        const controls = document.querySelector(".player-controls__right-control-group");
        if (!controls) return;
        if (settings.pipButton !== false && !controls.querySelector(".tp-pip-btn")) {
            injectPipButton();
        }
        if (settings.screenshotButton !== false && !controls.querySelector(".tp-screenshot-btn")) {
            injectScreenshotButton();
        }
    }

    function startPlayerControlsObserver() {
        stopPlayerControlsObserver();

        // Observe the player container for re-renders (scoped, not document.body)
        const player = document.querySelector("[data-a-target='video-player'], .video-player");
        if (player) {
            playerControlsObserver = new MutationObserver(() => {
                ensurePlayerButtons();
            });
            playerControlsObserver.observe(player, { childList: true, subtree: true });
        }
        // Fallback: if player not found yet, use a short polling timer that stops once observer is set
        if (!playerControlsObserver && !playerButtonCheckTimer) {
            playerButtonCheckTimer = setInterval(() => {
                ensurePlayerButtons();
                const p = document.querySelector("[data-a-target='video-player'], .video-player");
                if (p) {
                    clearInterval(playerButtonCheckTimer);
                    playerButtonCheckTimer = null;
                    playerControlsObserver = new MutationObserver(() => ensurePlayerButtons());
                    playerControlsObserver.observe(p, { childList: true, subtree: true });
                }
            }, 3000);
        }
    }

    function stopPlayerControlsObserver() {
        if (playerControlsObserver) {
            playerControlsObserver.disconnect();
            playerControlsObserver = null;
        }
        if (playerButtonCheckTimer) {
            clearInterval(playerButtonCheckTimer);
            playerButtonCheckTimer = null;
        }
    }

    /**
     * Inject player buttons with retry logic.
     * Waits for `.player-controls__right-control-group` to appear before injecting.
     */
    async function injectPlayerButtonsWithRetry() {
        for (let attempt = 0; attempt < 8; attempt++) {
            const controls = document.querySelector(".player-controls__right-control-group");
            if (controls) {
                injectPipButton();
                injectScreenshotButton();
                startPlayerControlsObserver();
                console.log(`[Twitch Plus] Player buttons injected (attempt ${attempt + 1}).`);
                return;
            }
            await new Promise(r => setTimeout(r, 1500));
        }
        // Final fallback: start observer anyway so buttons get injected when controls appear
        const player = document.querySelector(".video-player, [data-a-target='video-player']");
        if (player) {
            startPlayerControlsObserver();
            console.log("[Twitch Plus] Player controls not found after retries; observer started as fallback.");
        }
    }

    // ---------------------------------------------------------------------------
    // 18. Channel Preview on Hover
    // ---------------------------------------------------------------------------

    function initChannelPreviews() {
        if (settings.channelPreviews === false) return;

        const sidebarSel = "[data-a-target=\"side-nav-card-metadata\"], .side-nav-card, .tw-link[href]";

        document.addEventListener("mouseenter", (e) => {
            const link = e.target.closest?.(sidebarSel);
            if (!link) return;

            const href = link.getAttribute("href") || link.querySelector("a")?.getAttribute("href") || "";
            const match = href.match(/^\/([a-zA-Z0-9_]+)\/?$/);
            if (!match) return;

            const login = match[1].toLowerCase();
            const excluded = new Set(["directory", "settings", "subscriptions", "inventory", "wallet", "friends", "moderator", "search", "following", "videos"]);
            if (excluded.has(login)) return;

            clearTimeout(channelPreviewTimer);
            channelPreviewTimer = setTimeout(() => showChannelPreview(e, login), 300);
        }, true);

        document.addEventListener("mouseleave", (e) => {
            const link = e.target.closest?.(sidebarSel);
            if (!link) return;
            clearTimeout(channelPreviewTimer);
            hideChannelPreview();
        }, true);

        // Touch: long-press to preview sidebar channel
        let chPreviewTouchTimer = null;
        document.addEventListener("touchstart", (e) => {
            const link = e.target.closest?.(sidebarSel);
            if (!link) return;
            const href = link.getAttribute("href") || link.querySelector("a")?.getAttribute("href") || "";
            const match = href.match(/^\/([a-zA-Z0-9_]+)\/?$/);
            if (!match) return;
            const login = match[1].toLowerCase();
            const excluded = new Set(["directory", "settings", "subscriptions", "inventory", "wallet", "friends", "moderator", "search", "following", "videos"]);
            if (excluded.has(login)) return;
            chPreviewTouchTimer = setTimeout(() => {
                e.preventDefault();
                showChannelPreview(e, login);
                const dismiss = () => { hideChannelPreview(); document.removeEventListener("touchstart", dismiss, true); };
                setTimeout(() => document.addEventListener("touchstart", dismiss, true), 50);
            }, 500);
        }, { passive: false, capture: true });
        document.addEventListener("touchend", () => clearTimeout(chPreviewTouchTimer), true);
        document.addEventListener("touchmove", () => clearTimeout(chPreviewTouchTimer), true);

        // Clean up preview on click (navigating to a channel)
        document.addEventListener("click", (e) => {
            if (e.target.closest?.(sidebarSel)) {
                hideChannelPreview();
            }
        }, true);

        // Clean up on any SPA navigation
        document.addEventListener("twitch-plus-navigation", () => hideChannelPreview());
    }

    function showChannelPreview(e, login) {
        hideChannelPreview();

        channelPreviewEl = document.createElement("div");
        channelPreviewEl.className = "tp-channel-preview";

        const img = document.createElement("img");
        img.src = `https://static-cdn.jtvnw.net/previews-ttv/live_user_${login}-320x180.jpg?t=${Date.now()}`;
        img.alt = login;
        img.onerror = () => hideChannelPreview();
        channelPreviewEl.appendChild(img);

        document.body.appendChild(channelPreviewEl);

        const rect = e.target.getBoundingClientRect();
        channelPreviewEl.style.top = `${rect.top}px`;
        channelPreviewEl.style.left = `${rect.right + 8}px`;

        // Keep within viewport
        const previewRect = channelPreviewEl.getBoundingClientRect();
        if (previewRect.right > window.innerWidth - 4) {
            channelPreviewEl.style.left = `${rect.left - previewRect.width - 8}px`;
        }
        if (previewRect.bottom > window.innerHeight - 4) {
            channelPreviewEl.style.top = `${window.innerHeight - previewRect.height - 4}px`;
        }
    }

    function hideChannelPreview() {
        clearTimeout(channelPreviewTimer);
        if (channelPreviewEl) { channelPreviewEl.remove(); channelPreviewEl = null; }
    }

    // ---------------------------------------------------------------------------
    // 19. Auto-Expand Followed Channels
    // ---------------------------------------------------------------------------

    function initAutoExpandFollowed() {
        if (settings.autoExpandFollowed === false) return;
        if (sidebarExpandObserver) return;

        let expandedOnce = false;
        let debounceTimer = null;

        function clickShowMore() {
            if (expandedOnce) return;
            const btn = document.querySelector("[data-a-target=\"side-nav-show-more-button\"]");
            if (btn) {
                expandedOnce = true;
                btn.click();
                console.log("[Twitch Plus] Auto-expanded followed channels.");
            }
        }

        clickShowMore();

        // Only watch for the button re-appearing after Twitch re-renders the sidebar
        // (e.g. after navigation). Debounce to avoid infinite loops.
        const sidebar = document.querySelector(".side-nav-section, [class*=\"side-nav\"]");
        if (!sidebar) return; // Don't fall back to document.body — too broad
        sidebarExpandObserver = new MutationObserver(() => {
            if (expandedOnce) return;
            if (debounceTimer) return;
            debounceTimer = setTimeout(() => {
                debounceTimer = null;
                clickShowMore();
            }, 500);
        });
        sidebarExpandObserver.observe(sidebar, { childList: true, subtree: true });
    }

    function stopAutoExpandFollowed() {
        if (sidebarExpandObserver) {
            sidebarExpandObserver.disconnect();
            sidebarExpandObserver = null;
        }
    }

    // ---------------------------------------------------------------------------
    // 20. Chat Message Search
    // ---------------------------------------------------------------------------

    function toggleChatSearch() {
        if (chatSearchActive) { closeChatSearch(); return; }
        openChatSearch();
    }

    function openChatSearch() {
        closeChatSearch();
        chatSearchActive = true;

        const chatContainer = findChatContainer();
        if (!chatContainer) return;

        const wrapper = chatContainer.closest(".chat-scrollable-area__message-container")?.parentElement ||
            chatContainer.parentElement;
        if (!wrapper) return;
        wrapper.style.position = "relative";

        const searchBar = document.createElement("div");
        searchBar.className = "tp-chat-search";

        const input = document.createElement("input");
        input.placeholder = t("chat_search_ph");
        input.type = "text";
        searchBar.appendChild(input);

        const countSpan = document.createElement("span");
        countSpan.className = "tp-chat-search-count";
        searchBar.appendChild(countSpan);

        const closeBtn = document.createElement("button");
        closeBtn.className = "tp-chat-search-close";
        closeBtn.innerHTML = "✕";
        closeBtn.addEventListener("click", closeChatSearch);
        searchBar.appendChild(closeBtn);

        wrapper.prepend(searchBar);
        input.focus();

        input.addEventListener("input", () => {
            const query = input.value.trim().toLowerCase();
            const messages = chatContainer.querySelectorAll(CHAT_LINE_SELECTOR);
            let matchCount = 0;

            messages.forEach((msg) => {
                msg.classList.remove("tp-search-highlight", "tp-search-no-match");
                if (!query) return;
                const text = msg.textContent.toLowerCase();
                if (text.includes(query)) {
                    msg.classList.add("tp-search-highlight");
                    matchCount++;
                } else {
                    msg.classList.add("tp-search-no-match");
                }
            });

            countSpan.textContent = query ? `${matchCount} matches` : "";
        });
    }

    function closeChatSearch() {
        chatSearchActive = false;
        const searchBar = document.querySelector(".tp-chat-search");
        if (searchBar) searchBar.remove();

        // Remove highlight classes
        const container = findChatContainer();
        if (container) {
            container.querySelectorAll(".tp-search-highlight, .tp-search-no-match").forEach((msg) => {
                msg.classList.remove("tp-search-highlight", "tp-search-no-match");
            });
        }
    }

    // ---------------------------------------------------------------------------
    // 21. Clip Download Button
    // ---------------------------------------------------------------------------

    function injectClipDownloadButton() {
        if (settings.clipDownload === false) return;
        if (!location.pathname.includes("/clip/")) return;
        if (document.querySelector(".tp-clip-download-btn")) return;

        // Find the clip actions area
        const actionsArea = document.querySelector(
            "[data-a-target='clips-watch-actions'], .clips-watch .clips-chat-and-actions, .clips-side-bar-actions"
        );
        if (!actionsArea) return;

        const btn = document.createElement("button");
        btn.className = "tp-clip-download-btn";
        btn.innerHTML = `<svg viewBox="0 0 20 20"><path d="M10 2v10.585l3.293-3.292 1.414 1.414L10 15.414l-4.707-4.707 1.414-1.414L10 12.585V2zm-7 14h14v2H3v-2z"/></svg> ${t("download")}`;

        btn.addEventListener("click", async () => {
            const video = document.querySelector("video");
            if (!video?.src) {
                console.warn("[Twitch Plus] No video source found for clip download.");
                return;
            }
            try {
                btn.textContent = t("downloading");
                btn.disabled = true;
                const resp = await fetch(video.src);
                const blob = await resp.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                const clipSlug = location.pathname.split("/clip/")[1]?.split("?")[0] || "clip";
                a.download = `twitch-clip-${clipSlug}.mp4`;
                a.click();
                URL.revokeObjectURL(url);
                btn.innerHTML = `<svg viewBox="0 0 20 20"><path d="M10 2v10.585l3.293-3.292 1.414 1.414L10 15.414l-4.707-4.707 1.414-1.414L10 12.585V2zm-7 14h14v2H3v-2z"/></svg> ${t("download")}`;
                btn.disabled = false;
            } catch (e) {
                console.error("[Twitch Plus] Clip download failed:", e);
                btn.innerHTML = `<svg viewBox="0 0 20 20"><path d="M10 2v10.585l3.293-3.292 1.414 1.414L10 15.414l-4.707-4.707 1.414-1.414L10 12.585V2zm-7 14h14v2H3v-2z"/></svg> ${t("download")}`;
                btn.disabled = false;
            }
        });

        actionsArea.prepend(btn);
    }

    /**
     * Shorten Twitch's native clip download button text by removing "version"/"versión".
     * Works across locales: "Download Vertical Version" → "Download Vertical",
     * "Descargar versión original" → "Descargar original", etc.
     *
     * Uses a MutationObserver on document.body because the download options live
     * inside a dropdown/popover that only renders when the user clicks share.
     */
    let clipLabelObserver = null;

    function startClipLabelObserver() {
        if (clipLabelObserver) return;
        if (!location.pathname.includes("/clip/")) return;

        // Debounce to avoid running on every single DOM mutation
        let clipLabelDebounce = null;
        clipLabelObserver = new MutationObserver(() => {
            if (clipLabelDebounce) return;
            clipLabelDebounce = setTimeout(() => {
                clipLabelDebounce = null;
                shortenClipDownloadLabelsNow();
            }, 200);
        });
        clipLabelObserver.observe(document.body, { childList: true, subtree: true });
        // Also run immediately in case the dropdown is already open
        shortenClipDownloadLabelsNow();
        console.log("[Twitch Plus] Clip label observer started.");
    }

    function stopClipLabelObserver() {
        if (clipLabelObserver) {
            clipLabelObserver.disconnect();
            clipLabelObserver = null;
        }
    }

    const VERSION_RE = /versi[oó]n/i;
    const VERSION_REPLACE_RE = /\s*versi[oó]n\s*/gi;

    function shortenClipDownloadLabelsNow() {
        // Scope to dropdown/popover/modal containers — not the entire page
        const roots = document.querySelectorAll(
            "[data-a-target='dropdown-menu'], [role='dialog'], [role='menu'], " +
            "[class*='popover'], [class*='dropdown'], [class*='modal']"
        );
        const scanRoot = roots.length > 0 ? roots : [document.querySelector(".clip-info, main") || document.body];
        for (const root of scanRoot) {
            if (!root) continue;
            const elements = root.querySelectorAll("button, a, div[role='menuitem'], [data-a-target]");
            for (const el of elements) {
                if (!VERSION_RE.test(el.textContent)) continue;
                const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
                let node;
                while ((node = walker.nextNode())) {
                    if (VERSION_RE.test(node.nodeValue)) {
                        node.nodeValue = node.nodeValue.replace(VERSION_REPLACE_RE, " ").trim();
                    }
                }
            }
        }
    }

    // ---------------------------------------------------------------------------
    // 22. Chat Image Previews (inline)
    // ---------------------------------------------------------------------------

    function attachImagePreviewListeners(messageEl) {
        if (settings.chatImagePreview === false) return;

        const links = messageEl.querySelectorAll("a[href]");
        for (const link of links) {
            const href = link.href || "";
            if (!isImageUrl(href)) continue;
            if (link.dataset.tpImagePreview) continue;
            link.dataset.tpImagePreview = "1";

            const img = document.createElement("img");
            img.className = "tp-image-preview";
            img.src = href;
            img.loading = "lazy";
            img.addEventListener("error", () => { img.classList.add("tp-image-preview-error"); });
            img.addEventListener("click", (e) => {
                e.preventDefault();
                window.open(href, "_blank");
            });
            // Insert after the link's parent text container
            const parent = link.closest("[data-a-target='chat-message-text']") || link.parentElement;
            if (parent) parent.after(img);
        }
    }

    const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg)(\?.*)?$/i;
    const IMGUR_RE = /imgur\.com\/[a-zA-Z0-9]+$/i;
    const I_IMGUR_RE = /i\.imgur\.com\//i;
    const TWIMG_RE = /pbs\.twimg\.com\//i;

    function isImageUrl(url) {
        if (IMAGE_EXT_RE.test(url)) return true;
        // Common image hosts
        if (IMGUR_RE.test(url)) return true;
        if (I_IMGUR_RE.test(url)) return true;
        if (TWIMG_RE.test(url)) return true;
        return false;
    }

    // ---------------------------------------------------------------------------
    // 24. Watch Time Tracker
    // ---------------------------------------------------------------------------

    let watchTimeInterval = null;
    let watchTimeEl = null;
    let sessionWatchTime = 0;
    let cachedVideoEl = null;

    function getVideoElement() {
        if (cachedVideoEl && cachedVideoEl.isConnected) return cachedVideoEl;
        cachedVideoEl = document.querySelector("video");
        return cachedVideoEl;
    }

    function initWatchTimeTracker() {
        if (!settings.watchTimeTracker) return;
        if (watchTimeInterval) return;
        if (!currentChannel) return;

        sessionWatchTime = 0;

        watchTimeInterval = setInterval(() => {
            const video = getVideoElement();
            if (video && !video.paused) {
                sessionWatchTime++;
                updateWatchTimeDisplay();
                // Persist to storage every 60 seconds
                if (sessionWatchTime % 60 === 0) {
                    persistWatchTime();
                }
            }
        }, 1000);
    }

    function stopWatchTimeTracker() {
        if (watchTimeInterval) {
            persistWatchTime();
            clearInterval(watchTimeInterval);
            watchTimeInterval = null;
        }
        if (watchTimeEl) { watchTimeEl.remove(); watchTimeEl = null; }
    }

    function updateWatchTimeDisplay() {
        // If element was removed from DOM (React re-render), recreate it
        if (watchTimeEl && !watchTimeEl.isConnected) { watchTimeEl = null; }

        if (!watchTimeEl) {
            watchTimeEl = document.createElement("span");
            watchTimeEl.className = "tp-watch-time";
            watchTimeEl.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0zm0 14.5a6.5 6.5 0 1 1 0-13 6.5 6.5 0 0 1 0 13zm.75-10v4l3 1.75-.75 1.3L7.25 9.5V4.5h1.5z"/></svg><span class="tp-watch-time-value"></span>`;
            // Insert near the viewer count in the stream info area
            const viewerCount = document.querySelector("main [data-a-target='animated-channel-viewers-count']");
            const container = viewerCount?.parentElement;
            if (container) {
                container.appendChild(watchTimeEl);
            } else {
                // Broader fallback selectors — Twitch's stream info layout may vary
                const fallback = document.querySelector(
                    "[data-a-target='stream-game-link'], " +
                    ".metadata-layout__support, " +
                    "#live-channel-stream-information, " +
                    ".channel-info-content, " +
                    ".chat-input__buttons-container"
                );
                if (fallback) {
                    const parent = fallback.closest("[class*='Layout']") || fallback.parentElement;
                    if (parent) {
                        parent.appendChild(watchTimeEl);
                    } else {
                        fallback.appendChild(watchTimeEl);
                    }
                } else {
                    // Not ready yet — null out so next tick retries
                    watchTimeEl = null;
                    return;
                }
            }
        }
        const valueSpan = watchTimeEl.querySelector(".tp-watch-time-value");
        if (valueSpan) {
            const h = Math.floor(sessionWatchTime / 3600);
            const m = Math.floor((sessionWatchTime % 3600) / 60);
            const s = sessionWatchTime % 60;
            valueSpan.textContent = h > 0
                ? `${h}h ${m}m`
                : `${m}m ${s.toString().padStart(2, "0")}s`;
        }
    }

    function persistWatchTime() {
        if (!currentChannel || sessionWatchTime === 0) return;
        browser.runtime.sendMessage({
            action: "saveSetting",
            key: `watchTime_${currentChannel}`,
            value: (settings[`watchTime_${currentChannel}`] || 0) + sessionWatchTime,
        }).catch(() => {});
        // Reset session counter (we've persisted it)
        settings[`watchTime_${currentChannel}`] = (settings[`watchTime_${currentChannel}`] || 0) + sessionWatchTime;
        sessionWatchTime = 0;
    }

    // ---------------------------------------------------------------------------
    // 25. Unwanted Content Filter (directory/browse pages)
    // ---------------------------------------------------------------------------

    function initUnwantedFilter() {
        const filters = settings.unwantedFilter || [];
        if (filters.length === 0) return;

        // Only run on directory/browse pages
        if (!location.pathname.startsWith("/directory")) return;

        function hideUnwanted() {
            const filterSet = new Set(filters.map((f) => f.toLowerCase()));

            // Hide game/category cards
            const cards = document.querySelectorAll(
                "[data-a-target='card-0'], [data-a-target='card-1'], [data-a-target='card-2'], " +
                ".tw-tower [class*='card'], [class*='game-card']"
            );
            for (const card of cards) {
                const title = card.querySelector("[data-a-target='card-title'], h3, [class*='game-name']")?.textContent?.trim()?.toLowerCase() || "";
                const streamer = card.querySelector("a[data-a-target='preview-card-channel-link']")?.textContent?.trim()?.toLowerCase() || "";
                if (filterSet.has(title) || filterSet.has(streamer)) {
                    card.classList.add("tp-unwanted-hidden");
                }
            }

            // Hide stream cards with matching game or channel
            const streamCards = document.querySelectorAll("[data-a-target='preview-card-titles']");
            for (const card of streamCards) {
                const parent = card.closest("[class*='card']") || card.parentElement?.parentElement;
                if (!parent) continue;
                const game = card.querySelector("a[data-a-target='preview-card-game-link']")?.textContent?.trim()?.toLowerCase() || "";
                const channel = card.querySelector("a[data-a-target='preview-card-channel-link']")?.textContent?.trim()?.toLowerCase() || "";
                if (filterSet.has(game) || filterSet.has(channel)) {
                    parent.classList.add("tp-unwanted-hidden");
                }
            }
        }

        hideUnwanted();

        // Re-apply when directory updates (infinite scroll)
        const dirObserver = new MutationObserver(() => hideUnwanted());
        const mainContent = document.querySelector("[class*='browse'], [class*='directory'], main");
        if (mainContent) dirObserver.observe(mainContent, { childList: true, subtree: true });
    }

    // ---------------------------------------------------------------------------
    // 26. Move Chat to Left
    // ---------------------------------------------------------------------------

    function applyChatPosition() {
        const enabled = !!settings.chatOnLeft;
        // Toggle class on body — all layout changes are handled purely in CSS.
        // This mirrors the approach used by BTTV and FrankerFaceZ.
        document.body.classList.toggle("tp-chat-left", enabled);
        console.log(`[Twitch Plus] Chat position: ${enabled ? "left" : "right"}`);
    }

    // ---------------------------------------------------------------------------
    // 27. VOD Real-Time Clock
    // ---------------------------------------------------------------------------

    let vodClockInterval = null;
    let vodClockEl = null;
    let vodStartTime = null;
    let vodDataListener = null; // track pending event listener for cleanup

    function initVodClock() {
        if (settings.vodRealTimeClock === false) return;

        // Only on VOD pages
        const isVod = location.pathname.includes("/videos/") || location.pathname.includes("/video/");
        if (!isVod) return;

        if (vodClockInterval) return;

        // Extract video ID from URL: /videos/12345678
        const videoIdMatch = location.pathname.match(/\/videos?\/(\d+)/);
        if (!videoIdMatch) {
            console.warn("[Twitch Plus] Could not extract video ID from URL.");
            return;
        }
        const videoId = videoIdMatch[1];

        console.log(`[Twitch Plus] Requesting VOD data for video ID: ${videoId}`);

        // Clean up any pending listener from a previous init
        if (vodDataListener) {
            document.removeEventListener("tp-vod-data-response", vodDataListener);
            vodDataListener = null;
        }

        // Request VOD metadata from page-world script (has auth token access)
        const onVodData = (e) => {
            const { createdAt } = e.detail || {};
            if (e.detail?.videoId !== videoId) return;
            document.removeEventListener("tp-vod-data-response", onVodData);
            vodDataListener = null;

            if (!createdAt) {
                console.warn("[Twitch Plus] VOD createdAt not available from GQL.");
                return;
            }

            vodStartTime = new Date(createdAt);
            if (isNaN(vodStartTime.getTime())) {
                console.warn("[Twitch Plus] Invalid VOD createdAt date:", createdAt);
                return;
            }

            console.log(`[Twitch Plus] VOD broadcast started at: ${vodStartTime.toISOString()}`);
            startVodClockUpdater();
        };
        vodDataListener = onVodData;
        document.addEventListener("tp-vod-data-response", onVodData);
        document.dispatchEvent(new CustomEvent("tp-request-vod-data", { detail: { videoId } }));
    }

    function startVodClockUpdater() {
        if (vodClockInterval) return;

        function updateVodClock() {
            const video = getVideoElement();
            if (!video || !vodStartTime) return;

            const currentWallTime = new Date(vodStartTime.getTime() + (video.currentTime * 1000));

            // Check if our element was detached from the DOM (Twitch React re-renders)
            if (vodClockEl && !vodClockEl.isConnected) {
                vodClockEl = null;
            }

            // Remove any orphaned/duplicate clock elements before creating ours
            if (!vodClockEl) {
                document.querySelectorAll(".tp-vod-clock").forEach(el => el.remove());

                vodClockEl = document.createElement("div");
                vodClockEl.className = "tp-vod-clock";
                vodClockEl.innerHTML = `<svg viewBox="0 0 16 16"><path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0zm0 14.5a6.5 6.5 0 1 1 0-13 6.5 6.5 0 0 1 0 13zm.75-10v4l3 1.75-.75 1.3L7.25 9.5V4.5h1.5z"/></svg><span class="tp-vod-clock-time"></span>`;
                vodClockEl.title = t("vod_clock_tooltip");

                // Place in the player controls bar (right side, before settings)
                const rightControls = document.querySelector(".player-controls__right-control-group");
                if (rightControls) {
                    // Insert at the beginning of right controls (before fullscreen/settings)
                    rightControls.prepend(vodClockEl);
                } else {
                    // Fallback: place below the video metadata area
                    const metadataBar = document.querySelector(
                        "[data-a-target='stream-game-link']," +
                        ".channel-info-content," +
                        "[class*='metadata-layout']"
                    );
                    if (metadataBar) {
                        const parent = metadataBar.closest("[class*='Layout']") || metadataBar.parentElement;
                        if (parent) {
                            parent.appendChild(vodClockEl);
                        }
                    } else {
                        // Last resort: place below the player
                        const playerWrapper = document.querySelector(
                            "[class*='video-player'], [data-a-target='video-player']"
                        );
                        if (playerWrapper) {
                            playerWrapper.parentElement?.insertBefore(vodClockEl, playerWrapper.nextSibling);
                        }
                    }
                }
            }

            const timeSpan = vodClockEl?.querySelector(".tp-vod-clock-time");
            if (timeSpan) {
                const timeStr = currentWallTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                const dateStr = currentWallTime.toLocaleDateString([], { month: "short", day: "numeric" });
                timeSpan.textContent = `${dateStr} ${timeStr}`;
            }
        }

        vodClockInterval = setInterval(updateVodClock, 1000);
        updateVodClock();
    }

    function stopVodClock() {
        if (vodClockInterval) { clearInterval(vodClockInterval); vodClockInterval = null; }
        if (vodDataListener) { document.removeEventListener("tp-vod-data-response", vodDataListener); vodDataListener = null; }
        if (vodClockEl) { vodClockEl.remove(); vodClockEl = null; }
        // Also remove any orphaned clock elements
        document.querySelectorAll(".tp-vod-clock").forEach(el => el.remove());
        vodStartTime = null;
    }

    // ---------------------------------------------------------------------------
    // 28. In-page Settings Button & Panel
    // ---------------------------------------------------------------------------

    let settingsPanelOpen = false;

    // SVG icons for tab navigation
    const CATEGORY_ICONS = {
        emotes: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0zm0 14.5a6.5 6.5 0 1 1 0-13 6.5 6.5 0 0 1 0 13zM5.5 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm5 0a1 1 0 1 1 0-2 1 1 0 0 1 0 2zM4.25 9.5a.75.75 0 0 1 .65-.37h6.2a.75.75 0 0 1 .65 1.12A4.48 4.48 0 0 1 8 12.5a4.48 4.48 0 0 1-3.75-2.25.75.75 0 0 1 0-.75z"/></svg>`,
        chat: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M2 2a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3.5l2.5 2 2.5-2H14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H2zm0 1.5h12a.5.5 0 0 1 .5.5v8a.5.5 0 0 1-.5.5h-4l-2 1.6-2-1.6H2a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5z"/></svg>`,
        player: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M2 3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1H2zm4.5 2.25L10 8l-3.5 2.75V5.25z"/></svg>`,
        auto: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 8 1zm4.95 2.05a.75.75 0 0 1 0 1.06l-1.06 1.06a.75.75 0 1 1-1.06-1.06l1.06-1.06a.75.75 0 0 1 1.06 0zM13.25 8a.75.75 0 0 1 0 1.5h-1.5a.75.75 0 0 1 0-1.5h1.5zM8 12a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 8 12zM4.17 4.17a.75.75 0 0 1 0 1.06L3.11 6.29a.75.75 0 1 1-1.06-1.06l1.06-1.06a.75.75 0 0 1 1.06 0zM4.25 8a.75.75 0 0 1 0 1.5h-1.5a.75.75 0 0 1 0-1.5h1.5zM8 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/></svg>`,
        more: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M3 8a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm6.5 0a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm5 1.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z"/></svg>`,
    };

    /**
     * Inject the Twitch Plus settings button next to the chat settings gear.
     */
    async function injectSettingsButton() {
        // Don't duplicate
        if (document.querySelector(".tp-settings-btn")) return;

        console.log("[Twitch Plus] Attempting to inject settings button...");

        // Strategy 1: Find the chat settings gear button directly
        const gearSelectors = [
            '[data-a-target="chat-settings"]',
            'button[aria-label="Chat Settings"]',
            '.chat-input__buttons-container button:last-of-type',
        ];

        let gearBtn = null;
        for (const sel of gearSelectors) {
            gearBtn = document.querySelector(sel);
            if (gearBtn) {
                console.log(`[Twitch Plus] Found gear button via: ${sel}`);
                break;
            }
        }

        // Strategy 2: If no gear found yet, wait for the chat buttons area
        if (!gearBtn) {
            console.log("[Twitch Plus] Gear button not found immediately, waiting for chat area...");
            try {
                // Wait for the general chat area first
                const chatArea = await waitForElement(
                    '.chat-input__buttons-container, .stream-chat .chat-input, [class*="chat-buttons"], [class*="chat-input"]',
                    15000
                );
                if (chatArea) {
                    console.log("[Twitch Plus] Chat area found, searching for gear button...");
                    // Now look for the gear button in the chat area
                    for (const sel of gearSelectors) {
                        gearBtn = document.querySelector(sel);
                        if (gearBtn) {
                            console.log(`[Twitch Plus] Found gear button via: ${sel} (after wait)`);
                            break;
                        }
                    }
                }
            } catch (e) {
                console.warn("[Twitch Plus] Chat area wait timed out.");
            }
        }

        // Create the button
        const wrapper = document.createElement("div");
        wrapper.className = "tp-settings-wrapper";
        wrapper.appendChild(createSettingsButton());

        if (gearBtn) {
            // Insert next to the gear button — walk up to find the layout row
            let inserted = false;
            let parent = gearBtn.parentElement;
            for (let i = 0; i < 4 && parent; i++) {
                const grandParent = parent.parentElement;
                if (grandParent && grandParent.children.length > 1) {
                    grandParent.insertBefore(wrapper, parent);
                    inserted = true;
                    console.log(`[Twitch Plus] Settings button injected next to gear (level ${i + 1}).`);
                    break;
                }
                parent = grandParent;
            }
            if (!inserted) {
                gearBtn.parentElement?.insertBefore(wrapper, gearBtn);
                console.log("[Twitch Plus] Settings button injected (direct sibling).");
            }
        } else {
            // Fallback: append to any chat buttons container we can find
            const fallbackTargets = [
                '.chat-input__buttons-container',
                '.stream-chat .chat-input',
                '.chat-shell',
                '.stream-chat',
            ];
            let fallbackTarget = null;
            for (const sel of fallbackTargets) {
                fallbackTarget = document.querySelector(sel);
                if (fallbackTarget) break;
            }
            if (fallbackTarget) {
                fallbackTarget.appendChild(wrapper);
                console.log("[Twitch Plus] Settings button appended to fallback container.");
            } else {
                console.warn("[Twitch Plus] Could not find any chat container for settings button.");
                return;
            }
        }

        observeSettingsButtonRemoval();
    }

    /**
     * Create the settings button element.
     */
    function createSettingsButton() {
        const btn = document.createElement("button");
        btn.className = "tp-settings-btn";
        btn.setAttribute("aria-label", "Twitch Plus");
        btn.title = t("settings_btn_title");
        btn.innerHTML = `<span class="tp-settings-emoji">\u{1F426}\u{200D}\u{2B1B}</span>`;

        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            toggleSettingsPanel();
        });

        return btn;
    }

    /**
     * Watch for our button being removed and re-inject if needed.
     */
    function observeSettingsButtonRemoval() {
        let settingsBtnDebounce = null;
        const observer = new MutationObserver(() => {
            if (settingsBtnDebounce) return;
            settingsBtnDebounce = setTimeout(() => {
                settingsBtnDebounce = null;
                if (!document.querySelector(".tp-settings-btn")) {
                    observer.disconnect();
                    injectSettingsButton();
                }
            }, 300);
        });

        const chatRoot = document.querySelector(".stream-chat");
        if (chatRoot) observer.observe(chatRoot, { childList: true, subtree: true });
    }

    /**
     * Toggle the settings panel open/closed.
     */
    function toggleSettingsPanel() {
        if (settingsPanelOpen) {
            closeSettingsPanel();
            return;
        }
        openSettingsPanel();
    }

    /**
     * Open the settings panel as a fixed sidebar.
     */
    function openSettingsPanel() {
        closeSettingsPanel(); // Ensure no stale panel

        settingsPanelOpen = true;

        // Create backdrop
        const backdrop = document.createElement("div");
        backdrop.className = "tp-settings-backdrop";
        backdrop.addEventListener("click", () => closeSettingsPanel());
        document.body.appendChild(backdrop);

        // Create panel and append to body (fixed position)
        const panel = createSettingsPanel();
        document.body.appendChild(panel);

        // Close on Escape
        document.addEventListener("keydown", onEscapeClose);
    }

    /**
     * Close the settings panel.
     */
    function closeSettingsPanel() {
        settingsPanelOpen = false;
        const panel = document.querySelector(".tp-settings-panel");
        if (panel) panel.remove();
        const backdrop = document.querySelector(".tp-settings-backdrop");
        if (backdrop) backdrop.remove();
        document.removeEventListener("keydown", onEscapeClose);
    }

    function onEscapeClose(e) {
        if (e.key === "Escape") {
            closeSettingsPanel();
        }
    }

    /**
     * Build the settings panel DOM — sidebar navigation layout.
     */
    function createSettingsPanel() {
        const panel = document.createElement("div");
        panel.className = "tp-settings-panel";
        panel.addEventListener("click", (e) => e.stopPropagation());

        // ── Header (logo + title + master toggle + close) ──
        const header = document.createElement("div");
        header.className = "tp-panel-header";

        const logo = document.createElement("img");
        logo.className = "tp-panel-logo";
        logo.src = browser.runtime.getURL("images/icon-128.png");
        logo.alt = "";
        header.appendChild(logo);

        const title = document.createElement("h3");
        title.textContent = t("settings_title");
        header.appendChild(title);

        // Master toggle in header
        const headerToggle = document.createElement("label");
        headerToggle.className = "tp-header-toggle tp-toggle-switch";
        const masterInput = document.createElement("input");
        masterInput.type = "checkbox";
        masterInput.checked = settings.enabled !== false;
        masterInput.dataset.settingKey = "enabled";
        masterInput.addEventListener("change", () => {
            onSettingToggle("enabled", masterInput.checked);
        });
        const masterSlider = document.createElement("span");
        masterSlider.className = "tp-toggle-slider";
        headerToggle.appendChild(masterInput);
        headerToggle.appendChild(masterSlider);
        header.appendChild(headerToggle);

        const closeBtn = document.createElement("button");
        closeBtn.className = "tp-panel-close";
        closeBtn.innerHTML = "✕";
        closeBtn.addEventListener("click", () => closeSettingsPanel());
        header.appendChild(closeBtn);

        panel.appendChild(header);

        // ── Sidebar layout (sidebar + content) ──
        const layout = document.createElement("div");
        layout.className = "tp-sidebar-layout";

        // ── Category definitions ──
        const categories = [
            { id: "emotes", label: t("cat_emotes"), icon: CATEGORY_ICONS.emotes },
            { id: "chat", label: t("cat_chat"), icon: CATEGORY_ICONS.chat },
            { id: "player", label: t("cat_player"), icon: CATEGORY_ICONS.player },
            { id: "auto", label: t("cat_auto"), icon: CATEGORY_ICONS.auto },
            { id: "more", label: t("cat_more"), icon: CATEGORY_ICONS.more },
        ];

        // ── Sidebar nav ──
        const sidebar = document.createElement("div");
        sidebar.className = "tp-sidebar";

        const categoryContents = {};
        let activeCategoryId = "emotes";

        function switchCategory(catId) {
            activeCategoryId = catId;
            sidebar.querySelectorAll(".tp-sidebar-btn").forEach((btn) => {
                btn.classList.toggle("tp-sidebar-active", btn.dataset.category === catId);
            });
            Object.entries(categoryContents).forEach(([id, el]) => {
                el.classList.toggle("tp-category-visible", id === catId);
            });
        }

        categories.forEach((cat) => {
            const btn = document.createElement("button");
            btn.className = "tp-sidebar-btn" + (cat.id === activeCategoryId ? " tp-sidebar-active" : "");
            btn.dataset.category = cat.id;
            btn.innerHTML = cat.icon + `<span>${cat.label}</span>`;
            btn.addEventListener("click", () => switchCategory(cat.id));
            sidebar.appendChild(btn);
        });

        layout.appendChild(sidebar);

        // ── Scrollable content area ──
        const content = document.createElement("div");
        content.className = "tp-sidebar-content";

        // ── EMOTES ──
        const emotesSection = document.createElement("div");
        emotesSection.className = "tp-category-content tp-category-visible";

        emotesSection.appendChild(createSectionTitle(t("sec_emote_providers")));
        const emotesCard = document.createElement("div");
        emotesCard.className = "tp-setting-card";
        emotesCard.appendChild(createToggleRow(t("bttv"), "bttvEmotes", settings.bttvEmotes !== false, t("bttv_desc")));
        emotesCard.appendChild(createToggleRow(t("ffz"), "ffzEmotes", settings.ffzEmotes !== false, t("ffz_desc")));
        emotesCard.appendChild(createToggleRow(t("stv"), "sevenTvEmotes", settings.sevenTvEmotes !== false, t("stv_desc")));
        emotesSection.appendChild(emotesCard);

        emotesSection.appendChild(createSectionTitle(t("sec_7tv_advanced")));
        const sevenTvCard = document.createElement("div");
        sevenTvCard.className = "tp-setting-card";
        sevenTvCard.appendChild(createToggleRow(t("stv_events"), "sevenTvEventApi", settings.sevenTvEventApi !== false, t("stv_events_desc")));
        sevenTvCard.appendChild(createToggleRow(t("stv_cosmetics"), "sevenTvCosmetics", settings.sevenTvCosmetics !== false, t("stv_cosmetics_desc")));
        emotesSection.appendChild(sevenTvCard);

        emotesSection.appendChild(createSectionTitle(t("sec_emote_tools")));
        const emoteToolsCard = document.createElement("div");
        emoteToolsCard.className = "tp-setting-card";
        emoteToolsCard.appendChild(createToggleRow(t("emote_menu"), "emoteMenuEnabled", settings.emoteMenuEnabled !== false, t("emote_menu_desc")));
        emoteToolsCard.appendChild(createToggleRow(t("animated_emotes"), "animatedEmotes", settings.animatedEmotes !== false, t("animated_emotes_desc")));
        emotesSection.appendChild(emoteToolsCard);

        content.appendChild(emotesSection);
        categoryContents["emotes"] = emotesSection;

        // ── CHAT ──
        const chatSection = document.createElement("div");
        chatSection.className = "tp-category-content";

        chatSection.appendChild(createSectionTitle(t("sec_appearance")));
        const chatAppCard = document.createElement("div");
        chatAppCard.className = "tp-setting-card";
        chatAppCard.appendChild(createToggleRow(t("timestamps"), "chatTimestamps", !!settings.chatTimestamps, t("timestamps_desc")));
        chatAppCard.appendChild(createToggleRow(t("split_chat"), "splitChat", settings.splitChat !== false, t("split_chat_desc")));
        chatAppCard.appendChild(createSplitChatThemeSelector());
        chatAppCard.appendChild(createToggleRow(t("user_colors"), "alternatingUsers", settings.alternatingUsers !== false, t("user_colors_desc")));
        chatAppCard.appendChild(createToggleRow(t("readable_colors"), "readableColors", !!settings.readableColors, t("readable_colors_desc")));
        chatAppCard.appendChild(createToggleRow(t("first_chatter"), "firstTimeChatterHighlight", settings.firstTimeChatterHighlight !== false, t("first_chatter_desc")));
        chatAppCard.appendChild(createToggleRow(t("spoiler_tags"), "spoilerHiding", settings.spoilerHiding !== false, t("spoiler_tags_desc")));
        chatAppCard.appendChild(createSelectRow(t("chat_font"), "chatFontFamily", [
            { label: t("font_default"), value: "" },
            { label: t("font_system"), value: "system-ui, -apple-system, sans-serif" },
            { label: t("font_mono"), value: "'SF Mono', 'Menlo', 'Consolas', monospace" },
            { label: t("font_inter"), value: "'Inter', sans-serif" },
            { label: t("font_comic"), value: "'Comic Neue', cursive" },
        ], settings.chatFontFamily || ""));
        chatAppCard.appendChild(createNumberInputRow(t("font_size"), "chatFontSize", 0, 24, settings.chatFontSize || 0, t("font_size_ph")));
        chatSection.appendChild(chatAppCard);

        chatSection.appendChild(createSectionTitle(t("sec_behavior")));
        const chatBehCard = document.createElement("div");
        chatBehCard.className = "tp-setting-card";
        chatBehCard.appendChild(createToggleRow(t("deleted_msgs"), "showDeletedMessages", !!settings.showDeletedMessages, t("deleted_msgs_desc")));
        chatBehCard.appendChild(createToggleRow(t("mention_hl"), "mentionHighlights", settings.mentionHighlights !== false, t("mention_hl_desc")));
        chatBehCard.appendChild(createToggleRow(t("tab_complete"), "emoteTabCompletion", settings.emoteTabCompletion !== false, t("tab_complete_desc")));
        chatBehCard.appendChild(createToggleRow(t("lurk"), "lurkMode", !!settings.lurkMode, t("lurk_desc")));
        chatBehCard.appendChild(createToggleRow(t("anon_chat"), "anonChat", !!settings.anonChat, t("anon_chat_desc")));
        chatSection.appendChild(chatBehCard);

        chatSection.appendChild(createSectionTitle(t("sec_user_info")));
        const userInfoCard = document.createElement("div");
        userInfoCard.className = "tp-setting-card";
        userInfoCard.appendChild(createToggleRow(t("pronouns"), "showPronouns", !!settings.showPronouns, t("pronouns_desc")));
        userInfoCard.appendChild(createToggleRow(t("user_cards"), "enhancedUserCards", settings.enhancedUserCards !== false, t("user_cards_desc")));
        chatSection.appendChild(userInfoCard);

        chatSection.appendChild(createSectionTitle(t("sec_chat_tools")));
        const chatToolsCard = document.createElement("div");
        chatToolsCard.className = "tp-setting-card";
        chatToolsCard.appendChild(createToggleRow(t("slow_mode"), "slowModeCountdown", settings.slowModeCountdown !== false, t("slow_mode_desc")));
        chatToolsCard.appendChild(createToggleRow(t("chat_search"), "chatSearch", !!settings.chatSearch, t("chat_search_desc")));
        chatToolsCard.appendChild(createToggleRow(t("yt_preview"), "youtubePreview", settings.youtubePreview !== false, t("yt_preview_desc")));
        chatToolsCard.appendChild(createToggleRow(t("img_preview"), "chatImagePreview", settings.chatImagePreview !== false, t("img_preview_desc")));
        chatSection.appendChild(chatToolsCard);

        chatSection.appendChild(createSectionTitle(t("sec_spam")));
        const spamCard = document.createElement("div");
        spamCard.className = "tp-setting-card";
        spamCard.appendChild(createToggleRow(t("spam_filter"), "spamFilter", !!settings.spamFilter, t("spam_filter_desc")));
        spamCard.appendChild(createNumberInputRow(t("spam_threshold"), "spamThreshold", 2, 50, settings.spamThreshold || 3, "3"));
        spamCard.appendChild(createNumberInputRow(t("spam_window"), "spamWindow", 5, 120, settings.spamWindow || 10, "10"));
        spamCard.appendChild(createToggleRow(t("hide_bots"), "hideBots", !!settings.hideBots, t("hide_bots_desc")));
        chatSection.appendChild(spamCard);

        chatSection.appendChild(createSectionTitle(t("sec_filters")));
        chatSection.appendChild(createKeywordEditor(t("hl_keywords"), "highlightKeywords", settings.highlightKeywords || []));
        chatSection.appendChild(createKeywordEditor(t("hidden_keywords"), "hiddenKeywords", settings.hiddenKeywords || []));
        chatSection.appendChild(createNicknameEditor(t("custom_nicks"), "customNicknames", settings.customNicknames || {}));

        content.appendChild(chatSection);
        categoryContents["chat"] = chatSection;

        // ── PLAYER ──
        const playerSection = document.createElement("div");
        playerSection.className = "tp-category-content";

        playerSection.appendChild(createSectionTitle(t("sec_player_controls")));
        const playerCtrlCard = document.createElement("div");
        playerCtrlCard.className = "tp-setting-card";
        playerCtrlCard.appendChild(createToggleRow(t("pip_btn"), "pipButton", settings.pipButton !== false, t("pip_btn_desc")));
        playerCtrlCard.appendChild(createToggleRow(t("screenshot_btn"), "screenshotButton", settings.screenshotButton !== false, t("screenshot_btn_desc")));
        playerCtrlCard.appendChild(createToggleRow(t("clip_dl"), "clipDownload", settings.clipDownload !== false, t("clip_dl_desc")));
        playerCtrlCard.appendChild(createToggleRow(t("vod_clock"), "vodRealTimeClock", settings.vodRealTimeClock !== false, t("vod_clock_desc")));
        playerSection.appendChild(playerCtrlCard);

        playerSection.appendChild(createSectionTitle(t("sec_audio_video")));
        const avCard = document.createElement("div");
        avCard.className = "tp-setting-card";
        avCard.appendChild(createSelectRow(t("quality"), "autoQuality", [
            { label: t("quality_auto"), value: "" },
            { label: "160p", value: "160p" },
            { label: "360p", value: "360p" },
            { label: "480p", value: "480p" },
            { label: "720p", value: "720p" },
            { label: "1080p", value: "1080p" },
            { label: "1440p (2K)", value: "1440p" },
            { label: t("quality_source"), value: "chunked" },
        ], settings.autoQuality || ""));
        avCard.appendChild(createToggleRow(t("autoplay_off"), "disableAutoplay", !!settings.disableAutoplay, t("autoplay_off_desc")));
        avCard.appendChild(createToggleRow(t("auto_reload_player"), "autoReloadPlayer", settings.autoReloadPlayer !== false, t("auto_reload_player_desc")));
        playerSection.appendChild(avCard);

        playerSection.appendChild(createSectionTitle(t("sec_theater")));
        const theaterCard = document.createElement("div");
        theaterCard.className = "tp-setting-card";
        theaterCard.appendChild(createToggleRow(t("auto_theater"), "autoTheaterMode", !!settings.autoTheaterMode, t("auto_theater_desc")));
        theaterCard.appendChild(createToggleRow(t("oled_black"), "theaterOledBlack", !!settings.theaterOledBlack, t("oled_black_desc")));
        theaterCard.appendChild(createToggleRow(t("transparent_chat"), "theaterTransparentChat", !!settings.theaterTransparentChat, t("transparent_chat_desc")));
        playerSection.appendChild(theaterCard);

        content.appendChild(playerSection);
        categoryContents["player"] = playerSection;

        // ── AUTO ──
        const autoSection = document.createElement("div");
        autoSection.className = "tp-category-content";

        autoSection.appendChild(createSectionTitle(t("sec_auto_claim")));
        const autoCard = document.createElement("div");
        autoCard.className = "tp-setting-card";
        autoCard.appendChild(createToggleRow(t("claim_points"), "autoClaimPoints", settings.autoClaimPoints !== false, t("claim_points_desc")));
        autoCard.appendChild(createToggleRow(t("claim_drops"), "autoClaimDrops", settings.autoClaimDrops !== false, t("claim_drops_desc")));
        autoCard.appendChild(createToggleRow(t("claim_moments"), "autoClaimMoments", !!settings.autoClaimMoments, t("claim_moments_desc")));
        autoCard.appendChild(createToggleRow(t("claim_streaks"), "autoClaimStreaks", settings.autoClaimStreaks !== false, t("claim_streaks_desc")));
        autoSection.appendChild(autoCard);

        content.appendChild(autoSection);
        categoryContents["auto"] = autoSection;

        // ── MORE (merged Mod + UI) ──
        const moreSection = document.createElement("div");
        moreSection.className = "tp-category-content";

        moreSection.appendChild(createSectionTitle(t("sec_language")));
        const langCard = document.createElement("div");
        langCard.className = "tp-setting-card";
        langCard.appendChild(createSelectRow(t("language_label"), "language", [
            { label: "\uD83C\uDF10 " + t("language_auto"), value: "auto" },
            { label: "\uD83C\uDDEC\uD83C\uDDE7 English", value: "en" },
            { label: "\uD83C\uDDEA\uD83C\uDDF8 Español", value: "es" },
            { label: "\uD83C\uDDEB\uD83C\uDDF7 Français", value: "fr" },
            { label: "\uD83C\uDDE9\uD83C\uDDEA Deutsch", value: "de" },
            { label: "\uD83C\uDDEF\uD83C\uDDF5 日本語", value: "ja" },
            { label: "\uD83C\uDDF0\uD83C\uDDF7 한국어", value: "ko" },
            { label: "\uD83C\uDDE7\uD83C\uDDF7 Português", value: "pt" },
            { label: "\uD83C\uDDE8\uD83C\uDDF3 中文 (简体)", value: "zh_CN" },
            { label: "\uD83C\uDDF9\uD83C\uDDFC 中文 (繁體)", value: "zh_TW" },
            { label: "\uD83C\uDDEE\uD83C\uDDF9 Italiano", value: "it" },
            { label: "\uD83C\uDDF7\uD83C\uDDFA Русский", value: "ru" },
            { label: "\uD83C\uDDF3\uD83C\uDDF1 Nederlands", value: "nl" },
            { label: "\uD83C\uDDF9\uD83C\uDDF7 Türkçe", value: "tr" },
            { label: "\uD83C\uDDF8\uD83C\uDDE6 العربية", value: "ar" },
            { label: "\uD83C\uDDF9\uD83C\uDDED ไทย", value: "th" },
            { label: "\uD83C\uDDF5\uD83C\uDDF1 Polski", value: "pl" },
            { label: "\uD83C\uDDF8\uD83C\uDDEA Svenska", value: "sv" },
            { label: "\uD83C\uDDEE\uD83C\uDDE9 Bahasa Indonesia", value: "id" },
        ], settings.language || "auto"));
        moreSection.appendChild(langCard);

        moreSection.appendChild(createSectionTitle(t("sec_moderation")));
        const modCard = document.createElement("div");
        modCard.className = "tp-setting-card";
        modCard.appendChild(createToggleRow(t("mod_tools"), "modToolsEnabled", !!settings.modToolsEnabled, t("mod_tools_desc")));
        moreSection.appendChild(modCard);

        moreSection.appendChild(createSectionTitle(t("sec_interface")));
        const uiCard = document.createElement("div");
        uiCard.className = "tp-setting-card";
        uiCard.appendChild(createToggleRow(t("hide_clutter"), "hideClutter", !!settings.hideClutter, t("hide_clutter_desc")));
        moreSection.appendChild(uiCard);

        moreSection.appendChild(createSectionTitle(t("sec_sidebar")));
        const sidebarCard = document.createElement("div");
        sidebarCard.className = "tp-setting-card";
        sidebarCard.appendChild(createToggleRow(t("auto_expand"), "autoExpandFollowed", settings.autoExpandFollowed !== false, t("auto_expand_desc")));
        sidebarCard.appendChild(createToggleRow(t("chan_previews"), "channelPreviews", settings.channelPreviews !== false, t("chan_previews_desc")));
        moreSection.appendChild(sidebarCard);

        moreSection.appendChild(createSectionTitle(t("sec_extras")));
        const extrasCard = document.createElement("div");
        extrasCard.className = "tp-setting-card";
        extrasCard.appendChild(createToggleRow(t("chat_left"), "chatOnLeft", !!settings.chatOnLeft, t("chat_left_desc")));
        extrasCard.appendChild(createToggleRow(t("watch_time"), "watchTimeTracker", !!settings.watchTimeTracker, t("watch_time_desc")));
        moreSection.appendChild(extrasCard);

        moreSection.appendChild(createSectionTitle(t("sec_content_filters")));
        moreSection.appendChild(createKeywordEditor(t("unwanted"), "unwantedFilter", settings.unwantedFilter || []));



        // Debug section
        moreSection.appendChild(createSectionTitle(t("sec_debug")));
        const debugCard = document.createElement("div");
        debugCard.className = "tp-setting-card";
        const debugBtn = document.createElement("button");
        debugBtn.className = "tp-debug-btn";
        debugBtn.textContent = t("debug_btn");
        debugBtn.addEventListener("click", () => toggleDebugOverlay());
        debugCard.appendChild(debugBtn);
        moreSection.appendChild(debugCard);

        content.appendChild(moreSection);
        categoryContents["more"] = moreSection;

        layout.appendChild(content);
        panel.appendChild(layout);

        // ── Footer ──
        const footer = document.createElement("div");
        footer.className = "tp-panel-footer";
        footer.innerHTML = `<span>${t("settings_footer").replace("{version}", "3.1.3")}</span>`;
        panel.appendChild(footer);

        // Apply disabled state to non-master toggles if extension is off
        updatePanelDisabledState(panel);

        return panel;
    }

    // ---------------------------------------------------------------------------
    // Debug Overlay
    // ---------------------------------------------------------------------------

    let debugOverlayEl = null;
    let debugOverlayInterval = null;

    function toggleDebugOverlay() {
        if (debugOverlayEl) {
            debugOverlayEl.remove();
            debugOverlayEl = null;
            if (debugOverlayInterval) { clearInterval(debugOverlayInterval); debugOverlayInterval = null; }
            return;
        }

        debugOverlayEl = document.createElement("div");
        debugOverlayEl.className = "tp-debug-overlay";
        debugOverlayEl.innerHTML = `
            <div class="tp-debug-header">
                <span>${t("debug_title")}</span>
                <button class="tp-debug-close">&times;</button>
            </div>
            <div class="tp-debug-content"></div>
        `;
        debugOverlayEl.querySelector(".tp-debug-close").addEventListener("click", () => toggleDebugOverlay());
        document.body.appendChild(debugOverlayEl);

        function updateDebug() {
            if (!debugOverlayEl) return;
            const content = debugOverlayEl.querySelector(".tp-debug-content");
            const isVod = location.pathname.includes("/videos/");
            const isClip = location.pathname.includes("/clip/");
            const playerEl = document.querySelector(".video-player, [data-a-target='video-player']");
            const controlsEl = document.querySelector(".player-controls__right-control-group");
            const videoEl = document.querySelector("video");
            const pipBtn = document.querySelector(".tp-pip-btn");
            const screenshotBtn = document.querySelector(".tp-screenshot-btn");
            const settingsBtn = document.querySelector(".tp-settings-btn");

            const lines = [
                `<b>Page</b>: ${location.pathname}`,
                `<b>Type</b>: ${currentChannel ? "Channel (" + currentChannel + ")" : isVod ? "VOD" : isClip ? "Clip" : "Other"}`,
                `<b>Channel ID</b>: ${currentChannelId || "none"}`,
                ``,
                `<b>DOM Elements</b>:`,
                `  Player: ${playerEl ? "found" : "MISSING"}`,
                `  Controls: ${controlsEl ? "found" : "MISSING"}`,
                `  Video: ${videoEl ? "found (src: " + (videoEl.src ? "yes" : "no") + ")" : "MISSING"}`,
                ``,
                `<b>Injected Buttons</b>:`,
                `  PiP: ${pipBtn ? "yes" : "NOT INJECTED"}`,
                `  Screenshot: ${screenshotBtn ? "yes" : "NOT INJECTED"}`,
                `  Settings: ${settingsBtn ? "yes (" + settingsBtn.className + ")" : "NOT INJECTED"}`,
                ``,
                `<b>Settings (key values)</b>:`,
                `  pipButton: ${settings.pipButton}`,
                `  screenshotButton: ${settings.screenshotButton}`,
                `  vodRealTimeClock: ${settings.vodRealTimeClock}`,
                ``,
                `<b>Player Observer</b>: ${playerControlsObserver ? "active" : "not set"}`,
                ``,
                `<b>VOD Clock</b>:`,
                `  Element: ${vodClockEl ? "created" : "not created"}`,
                `  Start time: ${vodStartTime ? vodStartTime.toISOString() : "not set"}`,
                `  Interval: ${vodClockInterval ? "running" : "not started"}`,
            ];

            content.innerHTML = lines.join("<br>");
        }

        updateDebug();
        debugOverlayInterval = setInterval(updateDebug, 1000);
    }

    /**
     * Create a section title element.
     */
    function createSectionTitle(text) {
        const el = document.createElement("div");
        el.className = "tp-section-title";
        el.textContent = text;
        return el;
    }

    /**
     * Create a toggle row with label, optional description, and switch.
     */
    function createToggleRow(label, settingKey, isOn, description) {
        const row = document.createElement("div");
        row.className = "tp-toggle-row";
        row.dataset.settingKey = settingKey;

        const info = document.createElement("div");
        info.className = "tp-toggle-info";

        const labelEl = document.createElement("span");
        labelEl.className = "tp-toggle-label";
        labelEl.textContent = label;
        info.appendChild(labelEl);

        if (description) {
            const desc = document.createElement("span");
            desc.className = "tp-toggle-desc";
            desc.textContent = description;
            info.appendChild(desc);
        }

        row.appendChild(info);

        const toggle = document.createElement("label");
        toggle.className = "tp-toggle-switch";

        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = isOn;
        input.addEventListener("change", () => {
            onSettingToggle(settingKey, input.checked);
        });

        const slider = document.createElement("span");
        slider.className = "tp-toggle-slider";

        toggle.appendChild(input);
        toggle.appendChild(slider);
        row.appendChild(toggle);

        // Clicking the row also toggles
        row.addEventListener("click", (e) => {
            if (e.target === input || e.target === slider) return;
            input.checked = !input.checked;
            input.dispatchEvent(new Event("change"));
        });

        return row;
    }

    /**
     * Create a dropdown select row.
     */
    function createSelectRow(label, settingKey, options, currentValue) {
        const row = document.createElement("div");
        row.className = "tp-toggle-row";
        row.dataset.settingKey = settingKey;

        const labelEl = document.createElement("span");
        labelEl.className = "tp-toggle-label";
        labelEl.textContent = label;
        row.appendChild(labelEl);

        const select = document.createElement("select");
        select.className = "tp-select";
        options.forEach((opt) => {
            const option = document.createElement("option");
            option.value = opt.value;
            option.textContent = opt.label;
            if (opt.value === currentValue) option.selected = true;
            select.appendChild(option);
        });
        select.addEventListener("change", () => {
            onSettingToggle(settingKey, select.value);
        });
        row.appendChild(select);
        return row;
    }

    /**
     * Create a number input row.
     */
    function createNumberInputRow(label, settingKey, min, max, currentValue, placeholder) {
        const row = document.createElement("div");
        row.className = "tp-toggle-row";
        row.dataset.settingKey = settingKey;

        const labelEl = document.createElement("span");
        labelEl.className = "tp-toggle-label";
        labelEl.textContent = label;
        row.appendChild(labelEl);

        const input = document.createElement("input");
        input.type = "number";
        input.className = "tp-number-input";
        input.min = min;
        input.max = max;
        input.value = currentValue || "";
        if (placeholder) input.placeholder = placeholder;
        input.addEventListener("change", () => {
            const val = parseInt(input.value, 10) || 0;
            onSettingToggle(settingKey, val);
        });
        row.appendChild(input);
        return row;
    }

    /**
     * Create the split chat theme selector with preset grid + customize option.
     */
    function createSplitChatThemeSelector() {
        const wrapper = document.createElement("div");
        wrapper.className = "tp-split-theme-selector";
        wrapper.dataset.settingKey = "splitChatTheme";

        // Preset grid
        const grid = document.createElement("div");
        grid.className = "tp-theme-grid";

        const currentTheme = settings.splitChatTheme || "default";
        const themeI18nKeys = { default: "theme_twitch_dark", midnight: "theme_midnight", ocean: "theme_ocean", forest: "theme_forest", sunset: "theme_sunset", neon: "theme_neon", rainbow: "theme_rainbow", usa: "theme_usa", candy: "theme_candy", hacker: "theme_hacker" };

        Object.entries(SPLIT_CHAT_PRESETS).forEach(([key, preset]) => {
            const btn = document.createElement("button");
            btn.className = "tp-theme-btn" + (key === currentTheme ? " tp-theme-active" : "");
            btn.dataset.theme = key;
            const themeLabel = themeI18nKeys[key] ? t(themeI18nKeys[key]) : preset.label;
            btn.title = themeLabel;

            // Color preview swatch
            const swatch = document.createElement("div");
            swatch.className = "tp-theme-swatch";
            preset.dark.forEach((color) => {
                const stripe = document.createElement("div");
                stripe.className = "tp-theme-stripe";
                stripe.style.backgroundColor = color;
                swatch.appendChild(stripe);
            });
            btn.appendChild(swatch);

            const label = document.createElement("span");
            label.className = "tp-theme-label";
            label.textContent = themeLabel;
            btn.appendChild(label);

            btn.addEventListener("click", () => {
                console.log(`[Twitch Plus] Theme button clicked: ${key}`);
                grid.querySelectorAll(".tp-theme-btn").forEach(b => b.classList.remove("tp-theme-active"));
                btn.classList.add("tp-theme-active");
                onSettingToggle("splitChatTheme", key);
                // Hide custom editor if switching away from custom
                const editor = wrapper.querySelector(".tp-custom-colors-editor");
                if (editor) editor.style.display = "none";
            });
            grid.appendChild(btn);
        });

        // Custom button
        const customBtn = document.createElement("button");
        customBtn.className = "tp-theme-btn" + (currentTheme === "custom" ? " tp-theme-active" : "");
        customBtn.dataset.theme = "custom";
        customBtn.title = t("theme_custom_title");

        const customSwatch = document.createElement("div");
        customSwatch.className = "tp-theme-swatch tp-theme-swatch-custom";
        // Show a paint palette icon or gradient
        customSwatch.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M8 1a7 7 0 00-2.8 13.42c.2.05.23-.04.23-.04v-1.7c-1.59.35-1.93-.77-1.93-.77a1.52 1.52 0 00-.64-.83c-.52-.36.04-.35.04-.35a1.2 1.2 0 01.88.59 1.22 1.22 0 001.67.47 1.22 1.22 0 01.36-.76C4.33 10.87 3 10.32 3 7.53a2.82 2.82 0 01.75-1.96 2.63 2.63 0 01.07-1.93s.61-.2 2.01.75a6.93 6.93 0 013.66 0C10.89 3.44 11.5 3.64 11.5 3.64a2.63 2.63 0 01.07 1.93 2.82 2.82 0 01.75 1.96c0 2.8-1.34 3.34-2.62 3.52a1.37 1.37 0 01.39 1.06v1.58s.03.09.23.04A7 7 0 008 1z"/></svg>`;
        customBtn.appendChild(customSwatch);

        const customLabel = document.createElement("span");
        customLabel.className = "tp-theme-label";
        customLabel.textContent = t("theme_custom");
        customBtn.appendChild(customLabel);

        customBtn.addEventListener("click", () => {
            grid.querySelectorAll(".tp-theme-btn").forEach(b => b.classList.remove("tp-theme-active"));
            customBtn.classList.add("tp-theme-active");
            onSettingToggle("splitChatTheme", "custom");
            // Show custom editor
            const editor = wrapper.querySelector(".tp-custom-colors-editor");
            if (editor) editor.style.display = "";
        });
        grid.appendChild(customBtn);

        wrapper.appendChild(grid);

        // Custom color editor (hidden unless "custom" is selected)
        const editor = createCustomColorEditor();
        if (currentTheme !== "custom") editor.style.display = "none";
        wrapper.appendChild(editor);

        return wrapper;
    }

    /**
     * Create the custom color editor with add/remove color swatches.
     */
    function createCustomColorEditor() {
        const editor = document.createElement("div");
        editor.className = "tp-custom-colors-editor";

        const label = document.createElement("div");
        label.className = "tp-custom-colors-label";
        label.textContent = t("theme_custom_label");
        editor.appendChild(label);

        const swatchRow = document.createElement("div");
        swatchRow.className = "tp-custom-swatch-row";

        // Get current custom colors or defaults
        let customColors = settings.splitChatCustomColors;
        if (!Array.isArray(customColors) || customColors.length < 2) {
            customColors = ["rgba(24, 24, 28, 0.6)", "rgba(50, 50, 56, 0.5)"];
        }

        function renderSwatches() {
            swatchRow.innerHTML = "";
            customColors.forEach((color, i) => {
                const swatch = document.createElement("div");
                swatch.className = "tp-custom-swatch";
                swatch.style.backgroundColor = color;

                // Color input (hidden, triggered by clicking swatch)
                const colorInput = document.createElement("input");
                colorInput.type = "color";
                colorInput.className = "tp-custom-color-input";
                colorInput.value = rgbaToHex(color);
                colorInput.addEventListener("input", () => {
                    const hex = colorInput.value;
                    customColors[i] = hexToRgba(hex, 0.5);
                    swatch.style.backgroundColor = customColors[i];
                    onSettingToggle("splitChatCustomColors", [...customColors]);
                });
                swatch.appendChild(colorInput);

                swatch.addEventListener("click", (e) => {
                    if (e.target !== colorInput) colorInput.click();
                });

                // Remove button (only if more than 2 colors)
                if (customColors.length > 2) {
                    const removeBtn = document.createElement("button");
                    removeBtn.className = "tp-custom-swatch-remove";
                    removeBtn.textContent = "×";
                    removeBtn.addEventListener("click", (e) => {
                        e.stopPropagation();
                        customColors.splice(i, 1);
                        renderSwatches();
                        onSettingToggle("splitChatCustomColors", [...customColors]);
                    });
                    swatch.appendChild(removeBtn);
                }

                swatchRow.appendChild(swatch);
            });

            // Add button (max 8 colors)
            if (customColors.length < 8) {
                const addBtn = document.createElement("button");
                addBtn.className = "tp-custom-swatch-add";
                addBtn.textContent = "+";
                addBtn.title = t("add_color");
                addBtn.addEventListener("click", () => {
                    customColors.push("rgba(40, 40, 50, 0.5)");
                    renderSwatches();
                    onSettingToggle("splitChatCustomColors", [...customColors]);
                });
                swatchRow.appendChild(addBtn);
            }
        }

        renderSwatches();
        editor.appendChild(swatchRow);

        return editor;
    }

    /**
     * Convert rgba string to hex (approximate, ignores alpha).
     */
    function rgbaToHex(rgba) {
        const match = rgba.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (!match) return "#1e1e1e";
        const r = parseInt(match[1]).toString(16).padStart(2, "0");
        const g = parseInt(match[2]).toString(16).padStart(2, "0");
        const b = parseInt(match[3]).toString(16).padStart(2, "0");
        return `#${r}${g}${b}`;
    }

    /**
     * Convert hex color to rgba string with given alpha.
     */
    function hexToRgba(hex, alpha) {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    /**
     * Create a keyword editor (input + tag list for arrays).
     */
    function createKeywordEditor(label, settingKey, keywords) {
        const container = document.createElement("div");
        container.className = "tp-keyword-editor";
        container.dataset.settingKey = settingKey;

        const title = document.createElement("div");
        title.className = "tp-keyword-title";
        title.textContent = label;
        container.appendChild(title);

        const inputRow = document.createElement("div");
        inputRow.className = "tp-keyword-input-row";

        const input = document.createElement("input");
        input.type = "text";
        input.className = "tp-keyword-input";
        input.placeholder = t("keyword_ph");

        const addBtn = document.createElement("button");
        addBtn.className = "tp-keyword-add-btn";
        addBtn.textContent = "+";

        inputRow.appendChild(input);
        inputRow.appendChild(addBtn);
        container.appendChild(inputRow);

        const tagList = document.createElement("div");
        tagList.className = "tp-keyword-tags";
        container.appendChild(tagList);

        function renderTags() {
            tagList.innerHTML = "";
            const current = settings[settingKey] || [];
            current.forEach((kw, idx) => {
                const tag = document.createElement("span");
                tag.className = "tp-keyword-tag";
                tag.textContent = kw;
                const removeBtn = document.createElement("span");
                removeBtn.className = "tp-keyword-tag-remove";
                removeBtn.textContent = "×";
                removeBtn.addEventListener("click", () => {
                    const updated = [...(settings[settingKey] || [])];
                    updated.splice(idx, 1);
                    onSettingToggle(settingKey, updated);
                    renderTags();
                });
                tag.appendChild(removeBtn);
                tagList.appendChild(tag);
            });
        }

        function addKeyword() {
            const val = input.value.trim();
            if (!val) return;
            const updated = [...(settings[settingKey] || []), val];
            onSettingToggle(settingKey, updated);
            input.value = "";
            renderTags();
        }

        addBtn.addEventListener("click", addKeyword);
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") { e.preventDefault(); addKeyword(); }
        });

        renderTags();
        return container;
    }

    /**
     * Create a nickname editor (username → nickname pairs).
     */
    function createNicknameEditor(label, settingKey, nicknames) {
        const container = document.createElement("div");
        container.className = "tp-keyword-editor";
        container.dataset.settingKey = settingKey;

        const title = document.createElement("div");
        title.className = "tp-keyword-title";
        title.textContent = label;
        container.appendChild(title);

        const inputRow = document.createElement("div");
        inputRow.className = "tp-keyword-input-row";

        const userInput = document.createElement("input");
        userInput.type = "text";
        userInput.className = "tp-keyword-input";
        userInput.placeholder = t("nick_user_ph");
        userInput.style.flex = "1";

        const nickInput = document.createElement("input");
        nickInput.type = "text";
        nickInput.className = "tp-keyword-input";
        nickInput.placeholder = t("nick_name_ph");
        nickInput.style.flex = "1";

        const addBtn = document.createElement("button");
        addBtn.className = "tp-keyword-add-btn";
        addBtn.textContent = "+";

        inputRow.appendChild(userInput);
        inputRow.appendChild(nickInput);
        inputRow.appendChild(addBtn);
        container.appendChild(inputRow);

        const tagList = document.createElement("div");
        tagList.className = "tp-keyword-tags";
        container.appendChild(tagList);

        function renderTags() {
            tagList.innerHTML = "";
            const current = settings[settingKey] || {};
            Object.entries(current).forEach(([user, nick]) => {
                const tag = document.createElement("span");
                tag.className = "tp-keyword-tag";
                tag.textContent = `${user} → ${nick}`;
                const removeBtn = document.createElement("span");
                removeBtn.className = "tp-keyword-tag-remove";
                removeBtn.textContent = "×";
                removeBtn.addEventListener("click", () => {
                    const updated = { ...(settings[settingKey] || {}) };
                    delete updated[user];
                    onSettingToggle(settingKey, updated);
                    renderTags();
                });
                tag.appendChild(removeBtn);
                tagList.appendChild(tag);
            });
        }

        function addNickname() {
            const user = userInput.value.trim().toLowerCase();
            const nick = nickInput.value.trim();
            if (!user || !nick) return;
            const updated = { ...(settings[settingKey] || {}), [user]: nick };
            onSettingToggle(settingKey, updated);
            userInput.value = "";
            nickInput.value = "";
            renderTags();
        }

        addBtn.addEventListener("click", addNickname);
        nickInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") { e.preventDefault(); addNickname(); }
        });

        renderTags();
        return container;
    }

    /**
     * Create a channel profile management section.
     */


    /**
     * Handle a setting toggle change.
     */
    async function onSettingToggle(key, value) {
        // Update local state
        settings[key] = value;

        // Save via background script
        try {
            await browser.runtime.sendMessage({
                action: "updateSettings",
                settings: { [key]: value },
            });
        } catch (e) {
            console.error("[Twitch Plus] Failed to save setting:", e);
        }

        // Update disabled state in panel if master toggle changed
        if (key === "enabled") {
            const panel = document.querySelector(".tp-settings-panel");
            if (panel) updatePanelDisabledState(panel);
        }

        // Apply setting changes live
        applySettingChange(key, value);
    }

    /**
     * Enable/disable non-master toggles based on extension enabled state.
     */
    function updatePanelDisabledState(panel) {
        const isEnabled = settings.enabled !== false;
        // Disable all setting cards and toggle rows (except master toggle in header)
        panel.querySelectorAll(".tp-setting-card, .tp-keyword-editor").forEach((card) => {
            card.classList.toggle("tp-disabled", !isEnabled);
        });
        panel.querySelectorAll(".tp-toggle-row").forEach((row) => {
            if (row.dataset.settingKey === "enabled") return;
            row.classList.toggle("tp-disabled", !isEnabled);
        });
        // Disable sidebar buttons
        panel.querySelectorAll(".tp-sidebar-btn").forEach((btn) => {
            btn.style.opacity = isEnabled ? "" : "0.4";
            btn.style.pointerEvents = isEnabled ? "" : "none";
        });
    }

    /**
     * Apply a setting change immediately to the page.
     */
    function applySettingChange(key, value) {
        const container = findChatContainer();

        switch (key) {
            case "splitChat":
            case "splitChatTheme":
            case "splitChatCustomColors":
                if (container) {
                    if (settings.splitChat !== false) {
                        container.classList.add("tp-split-chat-active");
                        // Apply alternating backgrounds to existing messages
                        const colors = getSplitChatColors();
                        const msgs = container.querySelectorAll(CHAT_LINE_SELECTOR);
                        console.log(`[Twitch Plus] Split chat theme applied: ${settings.splitChatTheme || "default"} (${colors.length} colors, ${msgs.length} msgs)`);
                        let idx = 0;
                        msgs.forEach((msg) => {
                            const ci = idx % colors.length;
                            msg.style.backgroundColor = colors[ci];
                            msg.dataset.tpColorIdx = String(ci);
                            idx++;
                        });
                    } else {
                        container.classList.remove("tp-split-chat-active");
                        // Remove all alternating backgrounds
                        container.querySelectorAll(CHAT_LINE_SELECTOR).forEach((el) => {
                            el.style.backgroundColor = "";
                            delete el.dataset.tpColorIdx;
                        });
                    }
                }
                break;

            case "alternatingUsers":
                if (container) {
                    if (value) {
                        // Apply to existing messages
                        const msgs = container.querySelectorAll(CHAT_LINE_SELECTOR);
                        msgs.forEach((msg) => applyUserColor(msg));
                    } else {
                        // Remove inline background colors
                        const msgs = container.querySelectorAll(CHAT_LINE_SELECTOR);
                        msgs.forEach((msg) => { msg.style.backgroundColor = ""; });
                    }
                }
                break;

            case "autoClaimPoints":
            case "autoClaimDrops":
            case "autoClaimMoments":
                if (settings.autoClaimPoints !== false || settings.autoClaimDrops !== false || settings.autoClaimMoments || settings.autoClaimStreaks !== false) {
                    startAutoClaimPoints();
                } else {
                    stopAutoClaimPoints();
                }
                break;

            case "bttvEmotes":
            case "ffzEmotes":
            case "sevenTvEmotes":
                // Re-fetch emotes with updated provider settings
                if (currentChannelId) {
                    loadEmotes(currentChannelId);
                }
                break;

            case "enabled":
                // Re-fetch emotes (background will respect enabled flag)
                if (currentChannelId) {
                    loadEmotes(currentChannelId);
                }
                if (!value) {
                    stopAutoClaimPoints();
                }
                break;

            case "hideClutter":
                document.body.classList.toggle("tp-hide-clutter", !!value);
                break;

            case "firstTimeChatterHighlight":
                document.body.classList.toggle("tp-first-chatter-highlight", !!value);
                break;

            case "theaterOledBlack":
                document.body.classList.toggle("tp-theater-oled", !!value);
                break;

            case "theaterTransparentChat":
                document.body.classList.toggle("tp-theater-transparent", !!value);
                break;

            case "chatFontFamily":
            case "chatFontSize":
                applyChatFont();
                break;

            case "lurkMode":
                if (value) { enableLurkMode(); } else { disableLurkMode(); }
                break;

            case "anonChat":
                document.dispatchEvent(new CustomEvent("tp-anon-chat", {
                    detail: { enabled: !!value },
                }));
                // Remove any existing prompt and banner when toggling
                document.querySelectorAll(".tp-anon-prompt").forEach(el => el.remove());
                if (!value) removeAnonBanner();
                break;

            case "emoteTabCompletion":
                if (value) {
                    initEmoteCompletion();
                } else {
                    hideCompletionDropdown();
                }
                break;

            case "autoTheaterMode":
                if (value) autoTheaterMode();
                break;

            case "autoReloadPlayer":
                if (value) { startPlayerAutoReload(); } else { stopPlayerAutoReload(); }
                break;

            case "autoQuality":
                document.dispatchEvent(new CustomEvent("tp-set-quality", { detail: { quality: value } }));
                break;

            case "emoteMenuEnabled":
                if (value) { injectEmoteMenuButton(); } else {
                    document.querySelector(".tp-emote-menu-btn")?.remove();
                    closeEmoteMenu();
                }
                break;

            case "pipButton":
                if (value) { injectPipButton(); } else {
                    document.querySelector(".tp-pip-btn")?.remove();
                }
                break;

            case "screenshotButton":
                if (value) { injectScreenshotButton(); } else {
                    document.querySelector(".tp-screenshot-btn")?.remove();
                }
                break;

            case "autoExpandFollowed":
                if (value) { initAutoExpandFollowed(); } else { stopAutoExpandFollowed(); }
                break;

            case "chatSearch":
                if (!value) closeChatSearch();
                break;

            case "hideBots":
                if (value) loadKnownBots();
                break;

            case "chatOnLeft":
                applyChatPosition();
                break;

            case "language":
                tpSetLocale(value);
                // Re-create settings panel to reflect new language
                if (settingsPanelEl) {
                    closeSettingsPanel();
                    setTimeout(() => openSettingsPanel(), 100);
                }
                break;

            case "watchTimeTracker":
                if (value) { initWatchTimeTracker(); } else { stopWatchTimeTracker(); }
                break;

            case "vodRealTimeClock":
                if (value) { initVodClock(); } else { stopVodClock(); }
                break;

            case "spamFilter":
                if (!value) {
                    spamBuffer.clear();
                    comboTracker.clear();
                    if (comboWidgetEl) { comboWidgetEl.remove(); comboWidgetEl = null; }
                }
                break;
        }
    }

    // ---------------------------------------------------------------------------
    // 9. Channel change handler
    // ---------------------------------------------------------------------------

    async function onChannelChange(channel) {
        if (!channel || channel === currentChannel) return;
        const previousChannelId = currentChannelId;
        currentChannel = channel;
        currentChannelId = null;
        nonChannelPageInitPath = null; // reset so VOD/clip re-init works after navigating back
        console.log(`[Twitch Plus] Channel changed: ${channel}`);

        // Fire-and-forget features that don't depend on chat or emotes:
        // These run immediately and use their own internal retry/timing.
        autoTheaterMode();
        startPlayerAutoReload();

        if (settings.autoClaimPoints !== false || settings.autoClaimDrops !== false || settings.autoClaimMoments) {
            startAutoClaimPoints();
        } else {
            stopAutoClaimPoints();
        }

        // Fix channel points rewards popup clipping
        startRewardsPopupFix();

        // Clean up previous channel's session features
        stopWatchTimeTracker();
        stopVodClock();
        stopClipLabelObserver();
        stopPlayerControlsObserver();
        stopEnhancedUserCards();
        stopRewardsPopupFix();
        stopPlayerAutoReload();

        // Wait briefly for React to render the new channel's components
        await new Promise(r => setTimeout(r, 500));

        // Try to get channel ID from the page-world script
        const result = await requestChannelId();
        const resolvedId = result?.channelId || null;

        // Validate the resolved ID is not stale (from the previous channel)
        if (resolvedId && resolvedId !== previousChannelId) {
            currentChannelId = resolvedId;
        } else if (resolvedId && !previousChannelId) {
            // First load or no previous — trust the result
            currentChannelId = resolvedId;
        } else {
            currentChannelId = null;
        }

        if (!currentChannelId) {
            // Fallback: load only global emotes, we'll retry getting channelId later
            console.warn("[Twitch Plus] Could not resolve channel ID (may be stale), loading global emotes only.");
            await loadGlobalEmotesOnly();
        } else {
            await loadEmotes(currentChannelId);
        }

        // Detect username
        username = detectUsername();

        // Start chat observer — use broader selectors
        try {
            await waitForElement(CHAT_CONTAINER_SELECTORS.join(", "), 15000);
            startChatObserver();

            // Apply settings that depend on the chat container being ready.
            // Order matters: alternatingUsers first, then splitChat last so it wins visually.
            applySettingChange("alternatingUsers", settings.alternatingUsers !== false);
            applySettingChange("splitChat", settings.splitChat !== false);
            if (settings.lurkMode) applySettingChange("lurkMode", true);
            if (settings.anonChat) applySettingChange("anonChat", true);
        } catch (e) {
            console.warn("[Twitch Plus] Chat container not found after channel change.");
        }

        // Inject settings button next to chat gear
        injectSettingsButton();

        // Init emote tab-completion
        initEmoteCompletion();

        // New features (v3.0.0)
        injectEmoteMenuButton();
        initEnhancedUserCards();
        initSlowModeCountdown();
        if (settings.hideBots) loadKnownBots();
        // Player buttons: wait for controls to render then inject
        injectPlayerButtonsWithRetry();
        initChannelPreviews();
        initAutoExpandFollowed();
        injectClipDownloadButton();
        if (location.pathname.includes("/clip/")) {
            startClipLabelObserver();
        }
        initWatchTimeTracker();
        initUnwantedFilter();
        applyChatPosition();
        initVodClock();

        // Re-apply auto quality on channel change
        if (settings.autoQuality) {
            setTimeout(() => {
                document.dispatchEvent(new CustomEvent("tp-set-quality", {
                    detail: { quality: settings.autoQuality },
                }));
            }, 3000);
        }

    }

    // Retry channel ID resolution — sometimes the React tree isn't ready immediately
    async function retryChannelId(previousChannelId) {
        if (currentChannelId) return;
        for (let i = 0; i < 8; i++) {
            await new Promise((r) => setTimeout(r, 800));
            if (currentChannelId) return; // resolved by another path
            const result = await requestChannelId();
            const id = result?.channelId;
            if (id && id !== previousChannelId) {
                currentChannelId = id;
                console.log(`[Twitch Plus] Channel ID resolved on retry ${i + 1}: ${currentChannelId}`);
                await loadEmotes(currentChannelId);
                // Re-process existing messages with new emotes
                const chatContainer = findChatContainer();
                if (chatContainer) {
                    const messages = chatContainer.querySelectorAll(CHAT_LINE_SELECTOR);
                    messages.forEach((msg) => {
                        delete msg.dataset.tpProcessed;
                        processMessage(msg);
                    });
                }
                // Refresh emote completion index
                rebuildEmoteIndex();
                // Re-apply auto quality after successful channel resolution
                if (settings.autoQuality) {
                    setTimeout(() => {
                        document.dispatchEvent(new CustomEvent("tp-set-quality", {
                            detail: { quality: settings.autoQuality },
                        }));
                    }, 2000);
                }
                return;
            }
        }
        console.warn("[Twitch Plus] Could not resolve channel ID after retries.");
    }

    // ---------------------------------------------------------------------------
    // 10a. Non-channel page init (VOD / clip pages)
    // ---------------------------------------------------------------------------

    let nonChannelPageInitPath = null; // tracks the last path initNonChannelPage ran for

    /**
     * Resolve channel ID for VOD pages via GQL (returns owner.id from video query).
     */
    function resolveVodOwnerId() {
        return new Promise((resolve) => {
            const videoIdMatch = location.pathname.match(/\/videos?\/(\d+)/);
            if (!videoIdMatch) { resolve(null); return; }
            const videoId = videoIdMatch[1];

            let resolved = false;
            const handler = (e) => {
                if (resolved) return;
                if (e.detail?.videoId !== videoId) return;
                resolved = true;
                document.removeEventListener("tp-vod-data-response", handler);
                resolve(e.detail?.ownerId || null);
            };
            document.addEventListener("tp-vod-data-response", handler);
            document.dispatchEvent(new CustomEvent("tp-request-vod-data", { detail: { videoId } }));

            setTimeout(() => {
                if (resolved) return;
                resolved = true;
                document.removeEventListener("tp-vod-data-response", handler);
                resolve(null);
            }, 5000);
        });
    }

    /**
     * Resolve broadcaster ID for clip pages via GQL.
     */
    function resolveClipBroadcasterId() {
        return new Promise((resolve) => {
            const slugMatch = location.pathname.match(/\/clip\/([^/?]+)/);
            if (!slugMatch) { resolve(null); return; }
            const slug = slugMatch[1];

            let resolved = false;
            const handler = (e) => {
                if (resolved) return;
                if (e.detail?.slug !== slug) return;
                resolved = true;
                document.removeEventListener("tp-clip-data-response", handler);
                resolve(e.detail?.broadcasterId || null);
            };
            document.addEventListener("tp-clip-data-response", handler);
            document.dispatchEvent(new CustomEvent("tp-request-clip-data", { detail: { slug } }));

            setTimeout(() => {
                if (resolved) return;
                resolved = true;
                document.removeEventListener("tp-clip-data-response", handler);
                resolve(null);
            }, 5000);
        });
    }

    async function initNonChannelPage() {
        const isVod = location.pathname.includes("/videos/");
        const isClip = location.pathname.includes("/clip/");
        if (!isVod && !isClip) return;

        // Deduplicate: skip if already initialized for this exact path
        if (nonChannelPageInitPath === location.pathname) return;
        nonChannelPageInitPath = location.pathname;

        console.log(`[Twitch Plus] Initializing non-channel page: ${isVod ? "VOD" : "clip"}`);

        // Clean up any previous session features
        stopVodClock();
        stopPlayerControlsObserver();

        // Player error auto-reload works on VOD/clip pages too
        startPlayerAutoReload();

        // Resolve channel ID via GQL (much more reliable than React fiber on VOD/clip pages)
        let channelId = null;
        if (isVod) {
            channelId = await resolveVodOwnerId();
        } else if (isClip) {
            channelId = await resolveClipBroadcasterId();
        }

        // Fallback: try React fiber extraction
        if (!channelId) {
            console.log("[Twitch Plus] GQL channel ID not available, trying React fiber...");
            const result = await requestChannelId();
            channelId = result?.channelId || null;
        }

        if (channelId) {
            currentChannelId = channelId;
            console.log(`[Twitch Plus] VOD/clip channel ID resolved: ${channelId}`);
            await loadEmotes(channelId);
        } else {
            console.warn("[Twitch Plus] Could not resolve channel ID for VOD/clip. Only global emotes available.");
        }

        // Start chat observer for VOD chat replay / clip chat
        try {
            await waitForElement(CHAT_CONTAINER_SELECTORS.join(", "), 10000);
            startChatObserver();
            console.log("[Twitch Plus] Chat observer started for VOD/clip page.");
        } catch (e) {
            console.log("[Twitch Plus] No chat container found on VOD/clip page (may not have chat replay).");
        }

        // Inject player buttons with retry logic (waits for controls to render)
        await injectPlayerButtonsWithRetry();

        // VOD-specific features
        if (isVod) {
            initVodClock();
        }

        // Clip-specific features
        if (isClip) {
            injectClipDownloadButton();
            startClipLabelObserver();
        }

        // Inject settings button and emote menu if chat is present
        injectSettingsButton();
        injectEmoteMenuButton();
        initEmoteCompletion();

        // Apply auto quality on VOD/clip pages too
        if (settings.autoQuality) {
            setTimeout(() => {
                document.dispatchEvent(new CustomEvent("tp-set-quality", {
                    detail: { quality: settings.autoQuality },
                }));
            }, 3000);
        }

    }

    // ---------------------------------------------------------------------------
    // 10b. Listen for navigation events from the page-world script
    // ---------------------------------------------------------------------------

    document.addEventListener("twitch-plus-navigation", (e) => {
        const { channel, pathname } = e.detail;

        // Check for VOD/clip pages first — these take priority over channel detection
        // because URLs like /username/clip/ClipName contain a username but aren't channel pages
        if (pathname && (pathname.includes("/videos/") || pathname.includes("/clip/"))) {
            if (settingsReady) {
                console.log(`[Twitch Plus] SPA navigation to VOD/clip: ${pathname}`);
                setTimeout(() => initNonChannelPage(), 1500);
            }
            return;
        }

        if (channel) {
            if (!settingsReady) {
                // Settings not loaded yet — queue this channel for when they are
                pendingChannel = channel;
                console.log(`[Twitch Plus] Navigation event queued (settings not ready): ${channel}`);
                return;
            }
            const prevId = currentChannelId;
            onChannelChange(channel);
            // Retry channelId in background (shorter delay since onChannelChange already waits 500ms)
            setTimeout(() => retryChannelId(prevId), 1500);
        }
    });

    // ---------------------------------------------------------------------------
    // 11. Listen for messages from popup and background
    // ---------------------------------------------------------------------------

    browser.runtime.onMessage.addListener((request) => {
        // Open settings panel from extension popup (toolbar icon click)
        if (request.action === "openSettingsPanel") {
            console.log("[Twitch Plus] Content script received openSettingsPanel message");
            try {
                openSettingsPanel();
                console.log("[Twitch Plus] openSettingsPanel() called successfully");
            } catch (e) {
                console.error("[Twitch Plus] openSettingsPanel() threw error:", e);
            }
            return Promise.resolve({ opened: true });
        }

        if (request.action === "settingsUpdated") {
            settings = request.settings || settings;

            // Apply all live changes (alternatingUsers first, splitChat last so it wins)
            applySettingChange("alternatingUsers", settings.alternatingUsers !== false);
            applySettingChange("splitChat", settings.splitChat !== false);
            applySettingChange("autoClaimPoints", settings.autoClaimPoints !== false);
            applySettingChange("lurkMode", settings.lurkMode);
            applySettingChange("emoteTabCompletion", settings.emoteTabCompletion);
            if (settings.autoQuality) applySettingChange("autoQuality", settings.autoQuality);
            applyBodyClasses();
            applyChatFont();

            // Re-fetch emotes if providers changed
            if (currentChannelId) {
                loadEmotes(currentChannelId);
            }

            // Sync in-page panel toggles if open
            syncSettingsPanelToggles();
        }

        // 7TV EventAPI — live emote updates
        if (request.action === "emoteMapUpdate") {
            const { addedEmotes, removedEmoteNames } = request;

            // Remove old emotes
            if (removedEmoteNames?.length > 0) {
                for (const name of removedEmoteNames) {
                    emoteMap.delete(name);
                }
            }

            // Add new emotes
            if (addedEmotes?.length > 0) {
                for (const emote of addedEmotes) {
                    emoteMap.set(emote.name, emote);
                }
            }

            rebuildEmoteIndex();
            console.log(`[Twitch Plus] Emote map updated live: +${addedEmotes?.length || 0} -${removedEmoteNames?.length || 0}`);
        }
    });

    /**
     * Sync the in-page settings panel toggles to match current settings state.
     * Called when settings are changed from the popup.
     */
    function syncSettingsPanelToggles() {
        const panel = document.querySelector(".tp-settings-panel");
        if (!panel) return;

        // Sync checkboxes
        panel.querySelectorAll(".tp-toggle-row").forEach((row) => {
            const key = row.dataset.settingKey;
            const input = row.querySelector("input[type='checkbox']");
            if (!key || !input) return;

            const defaultOn = ["enabled", "bttvEmotes", "ffzEmotes", "sevenTvEmotes", "sevenTvEventApi", "sevenTvCosmetics", "mentionHighlights", "firstTimeChatterHighlight", "spoilerHiding", "emoteTabCompletion", "emoteMenuEnabled", "animatedEmotes", "enhancedUserCards", "youtubePreview", "pipButton", "slowModeCountdown", "channelPreviews", "autoExpandFollowed", "clipDownload", "chatImagePreview", "vodRealTimeClock", "screenshotButton", "splitChat", "alternatingUsers", "autoClaimPoints", "autoClaimDrops"];
            const isOn = defaultOn.includes(key) ? settings[key] !== false : !!settings[key];
            input.checked = isOn;
        });

        // Sync select dropdowns
        panel.querySelectorAll(".tp-toggle-row .tp-select").forEach((select) => {
            const key = select.closest(".tp-toggle-row")?.dataset?.settingKey;
            if (key && settings[key] !== undefined) {
                select.value = settings[key] || "";
            }
        });

        updatePanelDisabledState(panel);
    }

    /**
     * Apply all body-class-based settings on init and settings reload.
     */
    function applyBodyClasses() {
        document.body.classList.toggle("tp-hide-clutter", !!settings.hideClutter);
        document.body.classList.toggle("tp-first-chatter-highlight", !!settings.firstTimeChatterHighlight);
        document.body.classList.toggle("tp-theater-oled", !!settings.theaterOledBlack);
        document.body.classList.toggle("tp-theater-transparent", !!settings.theaterTransparentChat);
    }

    // ---------------------------------------------------------------------------
    // 12. Initialize
    // ---------------------------------------------------------------------------

    async function init() {
        console.log("[Twitch Plus] Content script initializing...");

        // Inject the page-world script
        injectPageScript();

        // Load settings
        try {
            const resp = await browser.runtime.sendMessage({ action: "getSettings" });
            if (resp && resp.settings) {
                settings = resp.settings;
            }
        } catch (e) {
            console.warn("[Twitch Plus] Could not load settings:", e);
        }

        // Initialize locale from settings
        tpSetLocale(settings.language || "auto");

        // Load frequent emotes
        try {
            const freqResp = await browser.runtime.sendMessage({ action: "getFrequentEmotes" });
            frequentEmotes = freqResp?.data || {};
        } catch (e) {}

        // Mark settings as ready — this unblocks navigation events that arrived early
        settingsReady = true;

        // Apply body classes from settings
        applyBodyClasses();

        // Apply chat font
        applyChatFont();

        // Lurk mode
        if (settings.lurkMode) enableLurkMode();

        // Auto quality (delayed to let player load, with retry)
        if (settings.autoQuality) {
            const applyQuality = (delay) => {
                setTimeout(() => {
                    document.dispatchEvent(new CustomEvent("tp-set-quality", {
                        detail: { quality: settings.autoQuality },
                    }));
                }, delay);
            };
            applyQuality(4000);
            // Retry in case player wasn't ready on first attempt
            applyQuality(8000);
        }

        // Autoplay prevention (homepage/directory)
        setupAutoplayPrevention();

        // Detect initial channel from URL or from a queued navigation event
        const path = location.pathname;

        // Check for VOD/clip pages first — these URLs contain a username in
        // parts[0] but are NOT channel pages (e.g. /hadi_ow/clip/ClipName).
        const isVodOrClip = path.includes("/videos/") || path.includes("/clip/");

        if (isVodOrClip) {
            // VOD/clip page — load global emotes + init non-channel features
            await loadGlobalEmotesOnly();
            setTimeout(() => initNonChannelPage(), 1500);
        } else {
            const parts = path.split("/").filter(Boolean);
            const initialChannel = pendingChannel
                || (parts.length > 0 && !EXCLUDED_PATHS.has(parts[0].toLowerCase()) ? parts[0].toLowerCase() : null);
            pendingChannel = null;

            if (initialChannel) {
                // Small delay to let the page load
                setTimeout(() => {
                    onChannelChange(initialChannel);
                    setTimeout(() => retryChannelId(), 4000);
                }, 1500);
            } else {
                // Not on a channel page — load global emotes in case they navigate
                await loadGlobalEmotesOnly();
            }
        }
    }

    init();
})();
