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
    let altRowIndex = 0;         // counter for alternating chat row backgrounds

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
        ".chat-scrollable-area__message-container",
        "section[data-test-selector='chat-room-component-layout'] .simplebar-content",
        ".chat-list--default .simplebar-content",
        ".chat-list .chat-scrollable-area__message-container",
    ];

    // Multiple selectors for chat message lines
    const CHAT_LINE_SELECTORS = [
        ".chat-line__message",
        "[data-a-target='chat-line-message']",
        ".chat-line__message--emote-button",
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
        if (el.classList.contains("chat-line__message")) return true;
        if (el.getAttribute?.("data-a-target") === "chat-line-message") return true;
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

        // Alternating row backgrounds — apply inline style like BTTV
        if (settings.splitChat !== false) {
            const colors = getSplitChatColors();
            msg.style.backgroundColor = colors[altRowIndex % colors.length];
            altRowIndex++;
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

        // Primary: Twitch wraps text in .text-fragment spans
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

        // Fallback 1: process childNodes of the message text container directly.
        // BTTV uses this approach — Twitch may not always use .text-fragment spans.
        const msgBody = messageEl.querySelector(
            "span[data-a-target='chat-message-text'], " +
            "[data-a-target='chat-message-text'], " +
            ".chat-line__message-body, " +
            "[class*='message-container']"
        );
        if (msgBody) {
            // Walk childNodes: process text nodes and text-containing spans
            const children = [...msgBody.childNodes];
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

            // Add tooltip listeners
            img.addEventListener("mouseenter", showTooltip);
            img.addEventListener("mouseleave", hideTooltip);

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
            const msgText = messageEl.querySelector("[data-a-target=\"chat-message-text\"]");
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
        "button[data-a-target='drops-claim-button']",
        ".claimable-drop button",
    ];

    const MOMENT_SELECTORS = [
        "[data-test-selector='moment-claim-button']",
        "button[aria-label='Claim Now']",
        ".community-moments-claim button",
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
        // Once the observer is attached, increase the polling interval since the observer
        // handles the hot path (points). Interval only catches drops/moments.
        autoClaimInterval = setInterval(() => {
            if (!autoClaimObserver) {
                const summary = document.querySelector(".community-points-summary");
                if (summary) {
                    autoClaimObserver = new MutationObserver(() => tryClaimAll());
                    autoClaimObserver.observe(summary, { childList: true, subtree: true });
                    console.log("[Twitch Plus] Auto-claim observer attached (delayed).");
                    // Slow down polling now that observer handles points
                    clearInterval(autoClaimInterval);
                    autoClaimInterval = setInterval(() => tryClaimAll(), 30000);
                }
            }
            tryClaimAll();
        }, 5000);

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
                indicator.textContent = "Lurk Mode";
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
        btn.title = "Emote Menu";
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

        // Position above the button
        const rect = anchorBtn.getBoundingClientRect();
        menu.style.bottom = `${window.innerHeight - rect.top + 4}px`;
        menu.style.right = `${window.innerWidth - rect.right}px`;

        // Header with search
        const header = document.createElement("div");
        header.className = "tp-emote-menu-header";
        const searchInput = document.createElement("input");
        searchInput.className = "tp-emote-search";
        searchInput.placeholder = "Search emotes...";
        searchInput.type = "text";
        header.appendChild(searchInput);
        const closeBtn = document.createElement("button");
        closeBtn.className = "tp-emote-menu-close";
        closeBtn.innerHTML = "✕";
        closeBtn.addEventListener("click", closeEmoteMenu);
        header.appendChild(closeBtn);
        menu.appendChild(header);

        // Tabs
        const providers = ["All", "BTTV", "FFZ", "7TV"];
        const tabBar = document.createElement("div");
        tabBar.className = "tp-emote-tabs";
        let activeProvider = "All";

        const grid = document.createElement("div");
        grid.className = "tp-emote-grid";

        function renderGrid(filter, providerFilter) {
            grid.innerHTML = "";
            const entries = [...emoteMap.entries()];
            let filtered = entries;
            if (providerFilter && providerFilter !== "All") {
                const pMap = { "BTTV": "bttv", "FFZ": "ffz", "7TV": "7tv" };
                const pKey = pMap[providerFilter];
                filtered = filtered.filter(([, e]) => e.source === pKey);
            }
            if (filter) {
                const lower = filter.toLowerCase();
                filtered = filtered.filter(([name]) => name.toLowerCase().includes(lower));
            }
            if (filtered.length === 0) {
                const empty = document.createElement("div");
                empty.className = "tp-emote-grid-empty";
                empty.textContent = "No emotes found";
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
            "[data-a-target='chat-message-text'], .chat-line__message-body, [class*='message-container']"
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
        btn.title = "Picture-in-Picture";
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
        btn.title = "Screenshot";
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
        input.placeholder = "Search chat...";
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
        btn.innerHTML = `<svg viewBox="0 0 20 20"><path d="M10 2v10.585l3.293-3.292 1.414 1.414L10 15.414l-4.707-4.707 1.414-1.414L10 12.585V2zm-7 14h14v2H3v-2z"/></svg> Download`;

        btn.addEventListener("click", async () => {
            const video = document.querySelector("video");
            if (!video?.src) {
                console.warn("[Twitch Plus] No video source found for clip download.");
                return;
            }
            try {
                btn.textContent = "Downloading…";
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
                btn.innerHTML = `<svg viewBox="0 0 20 20"><path d="M10 2v10.585l3.293-3.292 1.414 1.414L10 15.414l-4.707-4.707 1.414-1.414L10 12.585V2zm-7 14h14v2H3v-2z"/></svg> Download`;
                btn.disabled = false;
            } catch (e) {
                console.error("[Twitch Plus] Clip download failed:", e);
                btn.innerHTML = `<svg viewBox="0 0 20 20"><path d="M10 2v10.585l3.293-3.292 1.414 1.414L10 15.414l-4.707-4.707 1.414-1.414L10 12.585V2zm-7 14h14v2H3v-2z"/></svg> Download`;
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
                vodClockEl.title = "Original broadcast time";

                // Place in the video info area below the player, near share/like buttons
                const infoArea = document.querySelector(
                    "[data-a-target='share-button'], " +
                    "button[aria-label='Share'], " +
                    "[data-a-target='video-info-share-button']"
                );
                if (infoArea) {
                    // Insert before the share button's container
                    const shareParent = infoArea.closest("[class*='Layout']") || infoArea.parentElement;
                    if (shareParent?.parentElement) {
                        shareParent.parentElement.insertBefore(vodClockEl, shareParent);
                    } else {
                        shareParent?.before(vodClockEl);
                    }
                } else {
                    // Fallback: place in player controls
                    const controls = document.querySelector(".player-controls__right-control-group");
                    if (controls) {
                        controls.prepend(vodClockEl);
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
        btn.title = "Twitch Plus Settings";
        btn.innerHTML = `<svg viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
            <!-- Low-poly raven matching app icon -->
            <!-- Body -->
            <path d="M4 13.5Q3.2 11.5 4.5 9.5L7 8L9.5 7.5L12 8.5L13.5 10Q13.8 12 12.5 13.5L10 14.5L7 15Z" fill="#9147ff"/>
            <!-- Wing facets -->
            <path d="M5 11L7 8.5L9 9L10 10.5L9 12.5L6.5 13.5Z" fill="#7B2FBE"/>
            <path d="M7 8.5L9.5 7.8L10.5 9L9 9Z" fill="#A366FF"/>
            <!-- Head -->
            <circle cx="13.5" cy="6.5" r="3" fill="#9147ff"/>
            <!-- Head facets -->
            <path d="M12 6L13.5 4L15.5 5.5L14.5 7.5L12.5 7.5Z" fill="#A366FF" opacity="0.6"/>
            <!-- Eye -->
            <ellipse cx="14.5" cy="6.2" rx="1" ry="1.1" fill="#fff"/>
            <ellipse cx="14.7" cy="6.1" rx="0.5" ry="0.6" fill="#18181b"/>
            <circle cx="14.9" cy="5.9" r="0.2" fill="#fff"/>
            <!-- Beak -->
            <path d="M16.2 6.5L18.5 6.8L16.3 7.8Z" fill="#7B2FBE"/>
            <!-- Tail -->
            <path d="M3 13Q1.8 14 1.5 15.5Q2.5 14.5 3.2 14.2L4 13Z" fill="#7B2FBE" opacity="0.85"/>
            <path d="M3.5 13.5Q2.5 15 2 16Q3 15 3.5 14.5L4.2 13.5Z" fill="#5C1F99" opacity="0.8"/>
            <!-- Feet -->
            <path d="M7.5 14.8L7 16.5L6.2 17.2M7 16.5L7.5 17.2" fill="none" stroke="#7B2FBE" stroke-width="0.7" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M10 14.5L9.5 16.2L8.7 16.9M9.5 16.2L10 16.9" fill="none" stroke="#7B2FBE" stroke-width="0.7" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>`;

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
        title.textContent = "Twitch Plus";
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
            { id: "emotes", label: "Emotes", icon: CATEGORY_ICONS.emotes },
            { id: "chat", label: "Chat", icon: CATEGORY_ICONS.chat },
            { id: "player", label: "Player", icon: CATEGORY_ICONS.player },
            { id: "auto", label: "Auto", icon: CATEGORY_ICONS.auto },
            { id: "more", label: "More", icon: CATEGORY_ICONS.more },
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

        emotesSection.appendChild(createSectionTitle("Emote Providers"));
        const emotesCard = document.createElement("div");
        emotesCard.className = "tp-setting-card";
        emotesCard.appendChild(createToggleRow("BetterTTV", "bttvEmotes", settings.bttvEmotes !== false, "Load BetterTTV emotes in chat"));
        emotesCard.appendChild(createToggleRow("FrankerFaceZ", "ffzEmotes", settings.ffzEmotes !== false, "Load FrankerFaceZ emotes in chat"));
        emotesCard.appendChild(createToggleRow("7TV", "sevenTvEmotes", settings.sevenTvEmotes !== false, "Load 7TV emotes in chat"));
        emotesSection.appendChild(emotesCard);

        emotesSection.appendChild(createSectionTitle("7TV Advanced"));
        const sevenTvCard = document.createElement("div");
        sevenTvCard.className = "tp-setting-card";
        sevenTvCard.appendChild(createToggleRow("Live Emote Updates", "sevenTvEventApi", settings.sevenTvEventApi !== false, "Sync emote changes in real time via 7TV EventAPI"));
        sevenTvCard.appendChild(createToggleRow("Cosmetics", "sevenTvCosmetics", settings.sevenTvCosmetics !== false, "Show 7TV badges and username paints"));
        emotesSection.appendChild(sevenTvCard);

        emotesSection.appendChild(createSectionTitle("Emote Tools"));
        const emoteToolsCard = document.createElement("div");
        emoteToolsCard.className = "tp-setting-card";
        emoteToolsCard.appendChild(createToggleRow("Emote Menu", "emoteMenuEnabled", settings.emoteMenuEnabled !== false, "Show a picker button next to chat input for browsing emotes"));
        emoteToolsCard.appendChild(createToggleRow("Animated Emotes", "animatedEmotes", settings.animatedEmotes !== false, "Play animated emotes (GIF/WebP). Disable for static frames only"));
        emotesSection.appendChild(emoteToolsCard);

        content.appendChild(emotesSection);
        categoryContents["emotes"] = emotesSection;

        // ── CHAT ──
        const chatSection = document.createElement("div");
        chatSection.className = "tp-category-content";

        chatSection.appendChild(createSectionTitle("Appearance"));
        const chatAppCard = document.createElement("div");
        chatAppCard.className = "tp-setting-card";
        chatAppCard.appendChild(createToggleRow("Timestamps", "chatTimestamps", !!settings.chatTimestamps, "Show HH:MM before each message"));
        chatAppCard.appendChild(createToggleRow("Alternating Backgrounds", "splitChat", settings.splitChat !== false, "Alternate clear/dark rows for readability"));
        chatAppCard.appendChild(createSplitChatThemeSelector());
        chatAppCard.appendChild(createToggleRow("User Colors", "alternatingUsers", settings.alternatingUsers !== false, "Color-code message backgrounds per user"));
        chatAppCard.appendChild(createToggleRow("Readable Colors", "readableColors", !!settings.readableColors, "Adjust dark usernames for visibility"));
        chatAppCard.appendChild(createToggleRow("First-Time Chatter Glow", "firstTimeChatterHighlight", settings.firstTimeChatterHighlight !== false, "Highlight messages from first-time chatters"));
        chatAppCard.appendChild(createToggleRow("Spoiler Tags", "spoilerHiding", settings.spoilerHiding !== false, "Hide ||spoiler|| text until clicked"));
        chatAppCard.appendChild(createSelectRow("Chat Font", "chatFontFamily", [
            { label: "Default", value: "" },
            { label: "System UI", value: "system-ui, -apple-system, sans-serif" },
            { label: "Monospace", value: "'SF Mono', 'Menlo', 'Consolas', monospace" },
            { label: "Inter", value: "'Inter', sans-serif" },
            { label: "Comic Neue", value: "'Comic Neue', cursive" },
        ], settings.chatFontFamily || ""));
        chatAppCard.appendChild(createNumberInputRow("Font Size", "chatFontSize", 0, 24, settings.chatFontSize || 0, "0 = default"));
        chatSection.appendChild(chatAppCard);

        chatSection.appendChild(createSectionTitle("Behavior"));
        const chatBehCard = document.createElement("div");
        chatBehCard.className = "tp-setting-card";
        chatBehCard.appendChild(createToggleRow("Show Deleted Messages", "showDeletedMessages", !!settings.showDeletedMessages, "Keep deleted messages visible with strikethrough"));
        chatBehCard.appendChild(createToggleRow("Mention Highlights", "mentionHighlights", settings.mentionHighlights !== false, "Highlight messages that mention your name"));
        chatBehCard.appendChild(createToggleRow("Emote Tab-Completion", "emoteTabCompletion", settings.emoteTabCompletion !== false, "Press Tab to autocomplete emote names"));
        chatBehCard.appendChild(createToggleRow("Lurk Mode", "lurkMode", !!settings.lurkMode, "Grey out chat input to avoid accidental messages"));
        chatSection.appendChild(chatBehCard);

        chatSection.appendChild(createSectionTitle("User Info"));
        const userInfoCard = document.createElement("div");
        userInfoCard.className = "tp-setting-card";
        userInfoCard.appendChild(createToggleRow("Pronouns", "showPronouns", !!settings.showPronouns, "Show user pronouns next to display names (via pronouns.alejo.io)"));
        userInfoCard.appendChild(createToggleRow("Enhanced User Cards", "enhancedUserCards", settings.enhancedUserCards !== false, "Show account age and follow date on user card popups"));
        chatSection.appendChild(userInfoCard);

        chatSection.appendChild(createSectionTitle("Chat Tools"));
        const chatToolsCard = document.createElement("div");
        chatToolsCard.className = "tp-setting-card";
        chatToolsCard.appendChild(createToggleRow("Slow Mode Countdown", "slowModeCountdown", settings.slowModeCountdown !== false, "Show a countdown timer on the send button during slow mode"));
        chatToolsCard.appendChild(createToggleRow("Chat Search", "chatSearch", !!settings.chatSearch, "Enable Ctrl+F search overlay for chat messages"));
        chatToolsCard.appendChild(createToggleRow("YouTube Previews", "youtubePreview", settings.youtubePreview !== false, "Show thumbnail and title when hovering YouTube links in chat"));
        chatToolsCard.appendChild(createToggleRow("Image Previews", "chatImagePreview", settings.chatImagePreview !== false, "Show inline image previews for image URLs posted in chat"));
        chatSection.appendChild(chatToolsCard);

        chatSection.appendChild(createSectionTitle("Spam Filtering"));
        const spamCard = document.createElement("div");
        spamCard.className = "tp-setting-card";
        spamCard.appendChild(createToggleRow("Spam Filter", "spamFilter", !!settings.spamFilter, "Hide repeated messages that exceed the threshold"));
        spamCard.appendChild(createNumberInputRow("Repeat Threshold", "spamThreshold", 2, 50, settings.spamThreshold || 3, "3"));
        spamCard.appendChild(createNumberInputRow("Time Window (sec)", "spamWindow", 5, 120, settings.spamWindow || 10, "10"));
        spamCard.appendChild(createToggleRow("Hide Bot Messages", "hideBots", !!settings.hideBots, "Hide messages from known bots (Nightbot, StreamElements, etc.)"));
        chatSection.appendChild(spamCard);

        chatSection.appendChild(createSectionTitle("Filters"));
        chatSection.appendChild(createKeywordEditor("Highlight Keywords", "highlightKeywords", settings.highlightKeywords || []));
        chatSection.appendChild(createKeywordEditor("Hidden Keywords", "hiddenKeywords", settings.hiddenKeywords || []));
        chatSection.appendChild(createNicknameEditor("Custom Nicknames", "customNicknames", settings.customNicknames || {}));

        content.appendChild(chatSection);
        categoryContents["chat"] = chatSection;

        // ── PLAYER ──
        const playerSection = document.createElement("div");
        playerSection.className = "tp-category-content";

        playerSection.appendChild(createSectionTitle("Player Controls"));
        const playerCtrlCard = document.createElement("div");
        playerCtrlCard.className = "tp-setting-card";
        playerCtrlCard.appendChild(createToggleRow("Picture-in-Picture Button", "pipButton", settings.pipButton !== false, "Add a PiP button to the player controls bar"));
        playerCtrlCard.appendChild(createToggleRow("Screenshot Button", "screenshotButton", settings.screenshotButton !== false, "Add a screenshot capture button to the player controls bar"));
        playerCtrlCard.appendChild(createToggleRow("Clip Download", "clipDownload", settings.clipDownload !== false, "Add a download button on clip pages"));
        playerCtrlCard.appendChild(createToggleRow("VOD Real-Time Clock", "vodRealTimeClock", settings.vodRealTimeClock !== false, "Show the original broadcast time when watching VODs"));
        playerSection.appendChild(playerCtrlCard);

        playerSection.appendChild(createSectionTitle("Audio & Video"));
        const avCard = document.createElement("div");
        avCard.className = "tp-setting-card";
        avCard.appendChild(createSelectRow("Video Quality", "autoQuality", [
            { label: "Default", value: "" },
            { label: "160p", value: "160p" },
            { label: "360p", value: "360p" },
            { label: "480p", value: "480p" },
            { label: "720p", value: "720p" },
            { label: "1080p", value: "1080p" },
            { label: "Source", value: "chunked" },
        ], settings.autoQuality || ""));
        avCard.appendChild(createToggleRow("Disable Autoplay", "disableAutoplay", !!settings.disableAutoplay, "Stop videos from auto-playing on page load"));
        playerSection.appendChild(avCard);

        playerSection.appendChild(createSectionTitle("Theater Mode"));
        const theaterCard = document.createElement("div");
        theaterCard.className = "tp-setting-card";
        theaterCard.appendChild(createToggleRow("Auto Theater Mode", "autoTheaterMode", !!settings.autoTheaterMode, "Automatically enter theater mode on channel pages"));
        theaterCard.appendChild(createToggleRow("OLED Black Background", "theaterOledBlack", !!settings.theaterOledBlack, "Pure black background for OLED screens"));
        theaterCard.appendChild(createToggleRow("Transparent Chat Overlay", "theaterTransparentChat", !!settings.theaterTransparentChat, "Chat floats over the video with a blurred backdrop"));
        playerSection.appendChild(theaterCard);

        content.appendChild(playerSection);
        categoryContents["player"] = playerSection;

        // ── AUTO ──
        const autoSection = document.createElement("div");
        autoSection.className = "tp-category-content";

        autoSection.appendChild(createSectionTitle("Auto-Claim"));
        const autoCard = document.createElement("div");
        autoCard.className = "tp-setting-card";
        autoCard.appendChild(createToggleRow("Channel Points", "autoClaimPoints", settings.autoClaimPoints !== false, "Automatically click the bonus channel points button"));
        autoCard.appendChild(createToggleRow("Drops", "autoClaimDrops", settings.autoClaimDrops !== false, "Automatically claim available Twitch Drops"));
        autoCard.appendChild(createToggleRow("Moments", "autoClaimMoments", !!settings.autoClaimMoments, "Automatically claim streamer Moments"));
        autoSection.appendChild(autoCard);

        content.appendChild(autoSection);
        categoryContents["auto"] = autoSection;

        // ── MORE (merged Mod + UI) ──
        const moreSection = document.createElement("div");
        moreSection.className = "tp-category-content";

        moreSection.appendChild(createSectionTitle("Moderation"));
        const modCard = document.createElement("div");
        modCard.className = "tp-setting-card";
        modCard.appendChild(createToggleRow("Quick Timeout Buttons", "modToolsEnabled", !!settings.modToolsEnabled, "Show 1m/10m/1h timeout buttons on hover"));
        moreSection.appendChild(modCard);

        moreSection.appendChild(createSectionTitle("Interface"));
        const uiCard = document.createElement("div");
        uiCard.className = "tp-setting-card";
        uiCard.appendChild(createToggleRow("Hide UI Clutter", "hideClutter", !!settings.hideClutter, "Hide bits, hype chat, prime promos, streaks, and more"));
        moreSection.appendChild(uiCard);

        moreSection.appendChild(createSectionTitle("Sidebar"));
        const sidebarCard = document.createElement("div");
        sidebarCard.className = "tp-setting-card";
        sidebarCard.appendChild(createToggleRow("Auto-Expand Followed", "autoExpandFollowed", settings.autoExpandFollowed !== false, "Automatically click \"Show More\" to expand the followed channels list"));
        sidebarCard.appendChild(createToggleRow("Channel Previews", "channelPreviews", settings.channelPreviews !== false, "Show live thumbnail preview when hovering sidebar channels"));
        moreSection.appendChild(sidebarCard);

        moreSection.appendChild(createSectionTitle("Extras"));
        const extrasCard = document.createElement("div");
        extrasCard.className = "tp-setting-card";
        extrasCard.appendChild(createToggleRow("Move Chat to Left", "chatOnLeft", !!settings.chatOnLeft, "Position chat on the left side of the player"));
        extrasCard.appendChild(createToggleRow("Watch Time Tracker", "watchTimeTracker", !!settings.watchTimeTracker, "Track how long you watch each channel this session"));
        moreSection.appendChild(extrasCard);

        moreSection.appendChild(createSectionTitle("Content Filters"));
        moreSection.appendChild(createKeywordEditor("Unwanted Games/Channels", "unwantedFilter", settings.unwantedFilter || []));



        // Debug section
        moreSection.appendChild(createSectionTitle("Debug"));
        const debugCard = document.createElement("div");
        debugCard.className = "tp-setting-card";
        const debugBtn = document.createElement("button");
        debugBtn.className = "tp-debug-btn";
        debugBtn.textContent = "Show Debug Overlay";
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
        footer.innerHTML = `<span>Twitch Plus v3.1.3</span>`;
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
                <span>Twitch Plus Debug</span>
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

        Object.entries(SPLIT_CHAT_PRESETS).forEach(([key, preset]) => {
            const btn = document.createElement("button");
            btn.className = "tp-theme-btn" + (key === currentTheme ? " tp-theme-active" : "");
            btn.dataset.theme = key;
            btn.title = preset.label;

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
            label.textContent = preset.label;
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
        customBtn.title = "Custom Colors";

        const customSwatch = document.createElement("div");
        customSwatch.className = "tp-theme-swatch tp-theme-swatch-custom";
        // Show a paint palette icon or gradient
        customSwatch.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M8 1a7 7 0 00-2.8 13.42c.2.05.23-.04.23-.04v-1.7c-1.59.35-1.93-.77-1.93-.77a1.52 1.52 0 00-.64-.83c-.52-.36.04-.35.04-.35a1.2 1.2 0 01.88.59 1.22 1.22 0 001.67.47 1.22 1.22 0 01.36-.76C4.33 10.87 3 10.32 3 7.53a2.82 2.82 0 01.75-1.96 2.63 2.63 0 01.07-1.93s.61-.2 2.01.75a6.93 6.93 0 013.66 0C10.89 3.44 11.5 3.64 11.5 3.64a2.63 2.63 0 01.07 1.93 2.82 2.82 0 01.75 1.96c0 2.8-1.34 3.34-2.62 3.52a1.37 1.37 0 01.39 1.06v1.58s.03.09.23.04A7 7 0 008 1z"/></svg>`;
        customBtn.appendChild(customSwatch);

        const customLabel = document.createElement("span");
        customLabel.className = "tp-theme-label";
        customLabel.textContent = "Custom";
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
        label.textContent = "Custom Colors (min 2)";
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
                addBtn.title = "Add color";
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
        input.placeholder = "Add keyword…";

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
        userInput.placeholder = "Username";
        userInput.style.flex = "1";

        const nickInput = document.createElement("input");
        nickInput.type = "text";
        nickInput.className = "tp-keyword-input";
        nickInput.placeholder = "Nickname";
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
                        // Apply alternating backgrounds to existing messages
                        const colors = getSplitChatColors();
                        altRowIndex = 0;
                        const msgs = container.querySelectorAll(CHAT_LINE_SELECTOR);
                        console.log(`[Twitch Plus] Split chat theme applied: ${settings.splitChatTheme || "default"} (${colors.length} colors, ${msgs.length} msgs)`);
                        msgs.forEach((msg) => {
                            msg.style.backgroundColor = colors[altRowIndex % colors.length];
                            altRowIndex++;
                        });
                    } else {
                        // Remove all alternating backgrounds
                        container.querySelectorAll(CHAT_LINE_SELECTOR).forEach((el) => {
                            el.style.backgroundColor = "";
                        });
                        altRowIndex = 0;
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
                if (settings.autoClaimPoints !== false || settings.autoClaimDrops !== false || settings.autoClaimMoments) {
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
        currentChannel = channel;
        currentChannelId = null;
        nonChannelPageInitPath = null; // reset so VOD/clip re-init works after navigating back
        console.log(`[Twitch Plus] Channel changed: ${channel}`);

        // Fire-and-forget features that don't depend on chat or emotes:
        // These run immediately and use their own internal retry/timing.
        autoTheaterMode();

        if (settings.autoClaimPoints !== false || settings.autoClaimDrops !== false || settings.autoClaimMoments) {
            startAutoClaimPoints();
        } else {
            stopAutoClaimPoints();
        }

        // Clean up previous channel's session features
        stopWatchTimeTracker();
        stopVodClock();
        stopClipLabelObserver();
        stopPlayerControlsObserver();
        stopEnhancedUserCards();

        // Try to get channel ID from the page-world script
        const result = await requestChannelId();
        currentChannelId = result?.channelId || null;

        if (!currentChannelId) {
            // Fallback: load only global emotes, we'll retry getting channelId later
            console.warn("[Twitch Plus] Could not resolve channel ID, loading global emotes only.");
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

    }

    // Retry channel ID resolution — sometimes the React tree isn't ready immediately
    async function retryChannelId() {
        if (currentChannelId) return;
        for (let i = 0; i < 5; i++) {
            await new Promise((r) => setTimeout(r, 2000));
            const result = await requestChannelId();
            if (result?.channelId) {
                currentChannelId = result.channelId;
                console.log(`[Twitch Plus] Channel ID resolved on retry: ${currentChannelId}`);
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
                return;
            }
        }
        console.warn("[Twitch Plus] Could not resolve channel ID after retries.");
    }

    // ---------------------------------------------------------------------------
    // 10a. Non-channel page init (VOD / clip pages)
    // ---------------------------------------------------------------------------

    let nonChannelPageInitPath = null; // tracks the last path initNonChannelPage ran for

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
            onChannelChange(channel);
            // Retry channelId in background
            setTimeout(() => retryChannelId(), 3000);
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

        // Mark settings as ready — this unblocks navigation events that arrived early
        settingsReady = true;

        // Apply body classes from settings
        applyBodyClasses();

        // Apply chat font
        applyChatFont();

        // Lurk mode
        if (settings.lurkMode) enableLurkMode();

        // Auto quality (delayed to let player load)
        if (settings.autoQuality) {
            setTimeout(() => {
                document.dispatchEvent(new CustomEvent("tp-set-quality", {
                    detail: { quality: settings.autoQuality },
                }));
            }, 4000);
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
