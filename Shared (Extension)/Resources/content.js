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
    let emoteMap = {};           // name -> emoteData
    let settings = {};
    let currentChannel = null;   // channel login name
    let currentChannelId = null; // twitch user ID
    let chatObserver = null;
    let tooltipEl = null;
    let username = null;         // logged-in user's display name
    let userColorIndex = 0;      // rotating index for alternating user bg colors
    const userColorMap = {};     // username -> color index for consistent coloring
    let altRowIndex = 0;         // counter for alternating chat row backgrounds
    let settingsReady = false;   // gate: true once initial settings are loaded
    let pendingChannel = null;   // channel detected before settings were ready

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

    async function loadEmotes(channelId) {
        try {
            const response = await browser.runtime.sendMessage({
                action: "getEmotes",
                channelId: channelId,
            });
            if (response && response.emoteMap) {
                emoteMap = response.emoteMap;
                settings = response.settings || {};
                console.log(
                    `[Twitch Plus] Emote map loaded: ${Object.keys(emoteMap).length} emotes`
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
                emoteMap = response.emoteMap;
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

        processEmotesInMessage(msg);

        // Custom nicknames (before other text processing)
        if (Object.keys(settings.customNicknames || {}).length > 0) {
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

        if (settings.alternatingUsers) {
            applyUserColor(msg);
        }

        if (settings.firstTimeChatterHighlight) {
            highlightFirstTimeChatter(msg);
        }

        // Mod tools
        if (settings.modToolsEnabled) {
            injectModButtons(msg);
        }

        // Alternating row backgrounds — apply inline style like BTTV
        if (settings.splitChat) {
            if (altRowIndex % 2 === 1) {
                // Detect Twitch theme for appropriate alternating color
                const isDarkTheme = document.querySelector(".tw-root--theme-dark") ||
                    document.querySelector("[class*='dark-theme']") ||
                    document.documentElement.classList.contains("tw-root--theme-dark");
                msg.style.backgroundColor = isDarkTheme !== null
                    ? "rgba(255, 255, 255, 0.04)"
                    : "rgba(0, 0, 0, 0.04)";
            }
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
        if (Object.keys(emoteMap).length === 0) return;

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

        // Fallback: if no .text-fragment found, look for the message body container
        // and process direct text-containing spans (Twitch may change markup)
        const msgBody = messageEl.querySelector(
            "[data-a-target='chat-message-text'], " +
            ".chat-line__message-body, " +
            "[class*='message-container']"
        );
        if (msgBody) {
            // Process direct child spans that contain text (but not badges, icons, etc.)
            const spans = msgBody.querySelectorAll("span:not([class*='badge']):not([class*='icon'])");
            for (const span of spans) {
                if (span.children.length === 0 && span.textContent?.trim()) {
                    replaceEmotesInTextNode(span);
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
            if (emoteMap[word]) {
                hasEmote = true;
                break;
            }
        }

        if (!hasEmote) return;

        // Build replacement fragment
        const docFrag = document.createDocumentFragment();
        let lastEmoteContainer = null;

        for (const word of words) {
            const emote = emoteMap[word];

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

        if (settings.autoClaimPoints) {
            const btn = findClaimButton(BONUS_SELECTORS);
            if (btn) {
                btn.click();
                lastClaimTime = Date.now();
                console.log("[Twitch Plus] Auto-claimed channel points.");
            }
        }

        if (settings.autoClaimDrops) {
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

        // Strategy 2: Also use a broader document observer to catch the summary appearing
        // AND a fallback interval for drops/moments which appear elsewhere
        autoClaimInterval = setInterval(() => {
            // If the points summary appeared and we don't have an observer yet, attach one
            if (!autoClaimObserver) {
                const summary = document.querySelector(".community-points-summary");
                if (summary) {
                    autoClaimObserver = new MutationObserver(() => tryClaimAll());
                    autoClaimObserver.observe(summary, { childList: true, subtree: true });
                    console.log("[Twitch Plus] Auto-claim observer attached (delayed).");
                }
            }
            // Fallback polling for all claim types
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

            // Also observe new video elements
            const observer = new MutationObserver(() => pauseVideos());
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

        if (lastWord.length >= 2 && Object.keys(emoteMap).length > 0) {
            const lower = lastWord.toLowerCase();
            const matches = Object.entries(emoteMap)
                .filter(([name]) => name.toLowerCase().startsWith(lower))
                .sort((a, b) => a[0].length - b[0].length)
                .slice(0, 10);

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
    // 9. In-page Settings Button & Panel
    // ---------------------------------------------------------------------------

    let settingsPanelOpen = false;

    // SVG icons for tab navigation
    const TAB_ICONS = {
        emotes: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0zm0 14.5a6.5 6.5 0 1 1 0-13 6.5 6.5 0 0 1 0 13zM5.5 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm5 0a1 1 0 1 1 0-2 1 1 0 0 1 0 2zM4.25 9.5a.75.75 0 0 1 .65-.37h6.2a.75.75 0 0 1 .65 1.12A4.48 4.48 0 0 1 8 12.5a4.48 4.48 0 0 1-3.75-2.25.75.75 0 0 1 0-.75z"/></svg>`,
        chat: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M2 2a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3.5l2.5 2 2.5-2H14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H2zm0 1.5h12a.5.5 0 0 1 .5.5v8a.5.5 0 0 1-.5.5h-4l-2 1.6-2-1.6H2a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5z"/></svg>`,
        player: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M2 3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1H2zm4.5 2.25L10 8l-3.5 2.75V5.25z"/></svg>`,
        auto: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 8 1zm4.95 2.05a.75.75 0 0 1 0 1.06l-1.06 1.06a.75.75 0 1 1-1.06-1.06l1.06-1.06a.75.75 0 0 1 1.06 0zM13.25 8a.75.75 0 0 1 0 1.5h-1.5a.75.75 0 0 1 0-1.5h1.5zM8 12a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 8 12zM4.17 4.17a.75.75 0 0 1 0 1.06L3.11 6.29a.75.75 0 1 1-1.06-1.06l1.06-1.06a.75.75 0 0 1 1.06 0zM4.25 8a.75.75 0 0 1 0 1.5h-1.5a.75.75 0 0 1 0-1.5h1.5zM8 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/></svg>`,
        mod: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1L2 4v4c0 3.5 2.6 6.6 6 7.4 3.4-.8 6-3.9 6-7.4V4L8 1zm0 1.6l4.5 2.25V8c0 2.8-2 5.3-4.5 6.1C5.5 13.3 3.5 10.8 3.5 8V4.85L8 2.6z"/></svg>`,
        ui: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M2 2a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H2zm0 1.5h12a.5.5 0 0 1 .5.5v1H1.5V4a.5.5 0 0 1 .5-.5zM1.5 7h13v5a.5.5 0 0 1-.5.5H2a.5.5 0 0 1-.5-.5V7z"/></svg>`,
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
            <ellipse cx="8.5" cy="11.5" rx="5.5" ry="3.8" fill="#9147ff"/>
            <circle cx="13" cy="7.2" r="3.2" fill="#9147ff"/>
            <ellipse cx="14.2" cy="6.9" rx="1" ry="1.1" fill="#fff"/>
            <ellipse cx="14.4" cy="6.9" rx="0.55" ry="0.65" fill="#18181b"/>
            <path d="M15.8 7.2l2.2.1-1.6.9z" fill="#FFB833"/>
            <path d="M11 5.3Q10.7 3.8 11.5 3" fill="none" stroke="#7B2FBE" stroke-width="0.8" stroke-linecap="round"/>
            <path d="M12 5Q12.2 3.5 13.1 2.8" fill="none" stroke="#7B2FBE" stroke-width="0.8" stroke-linecap="round"/>
            <path d="M13 4.8Q13.6 3.5 14.4 3" fill="none" stroke="#7B2FBE" stroke-width="0.7" stroke-linecap="round"/>
            <path d="M3 10.5Q2 11.5 2 13Q2.5 12.3 3 12Q2.6 13.2 2.8 14Q3.3 13.2 3.8 12.7L4.8 11Z" fill="#7B2FBE"/>
            <path d="M7 15l-.3 1.7-.8.8" fill="none" stroke="#FFB833" stroke-width="0.7" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M6.7 16.7l.5.7" fill="none" stroke="#FFB833" stroke-width="0.7" stroke-linecap="round"/>
            <path d="M10 15l-.3 1.7-.8.8" fill="none" stroke="#FFB833" stroke-width="0.7" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M9.7 16.7l.5.7" fill="none" stroke="#FFB833" stroke-width="0.7" stroke-linecap="round"/>
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
        const observer = new MutationObserver(() => {
            if (!document.querySelector(".tp-settings-btn")) {
                observer.disconnect();
                injectSettingsButton();
            }
        });

        const chatRoot = document.querySelector(".stream-chat") || document.body;
        observer.observe(chatRoot, { childList: true, subtree: true });
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
     * Build the settings panel DOM — tabbed sidebar layout.
     */
    function createSettingsPanel() {
        const panel = document.createElement("div");
        panel.className = "tp-settings-panel";
        panel.addEventListener("click", (e) => e.stopPropagation());

        // ── Header ──
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

        const closeBtn = document.createElement("button");
        closeBtn.className = "tp-panel-close";
        closeBtn.innerHTML = "✕";
        closeBtn.addEventListener("click", () => closeSettingsPanel());
        header.appendChild(closeBtn);

        panel.appendChild(header);

        // ── Tab definitions ──
        const tabs = [
            { id: "emotes", label: "Emotes", icon: TAB_ICONS.emotes },
            { id: "chat", label: "Chat", icon: TAB_ICONS.chat },
            { id: "player", label: "Player", icon: TAB_ICONS.player },
            { id: "auto", label: "Auto", icon: TAB_ICONS.auto },
            { id: "mod", label: "Mod", icon: TAB_ICONS.mod },
            { id: "ui", label: "Interface", icon: TAB_ICONS.ui },
        ];

        // ── Tab bar ──
        const tabBar = document.createElement("div");
        tabBar.className = "tp-tab-bar";

        const tabContents = {};
        let activeTabId = "emotes";

        function switchTab(tabId) {
            activeTabId = tabId;
            tabBar.querySelectorAll(".tp-tab-btn").forEach((btn) => {
                btn.classList.toggle("tp-tab-active", btn.dataset.tab === tabId);
            });
            Object.entries(tabContents).forEach(([id, el]) => {
                el.classList.toggle("tp-tab-visible", id === tabId);
            });
        }

        tabs.forEach((tab) => {
            const btn = document.createElement("button");
            btn.className = "tp-tab-btn" + (tab.id === activeTabId ? " tp-tab-active" : "");
            btn.dataset.tab = tab.id;
            btn.innerHTML = tab.icon + `<span>${tab.label}</span>`;
            btn.addEventListener("click", () => switchTab(tab.id));
            tabBar.appendChild(btn);
        });

        panel.appendChild(tabBar);

        // ── Scrollable content area ──
        const content = document.createElement("div");
        content.className = "tp-settings-panel-content";

        // ── Master toggle (always visible above tabs) ──
        const masterCard = document.createElement("div");
        masterCard.className = "tp-master-toggle";
        masterCard.appendChild(createToggleRow("Extension Enabled", "enabled", settings.enabled !== false, "Master switch for all features"));
        content.appendChild(masterCard);

        // ── EMOTES TAB ──
        const emotesTab = document.createElement("div");
        emotesTab.className = "tp-tab-content tp-tab-visible";

        emotesTab.appendChild(createSectionTitle("Emote Providers"));
        const emotesCard = document.createElement("div");
        emotesCard.className = "tp-setting-card";
        emotesCard.appendChild(createToggleRow("BetterTTV", "bttvEmotes", settings.bttvEmotes !== false, "Load BetterTTV emotes in chat"));
        emotesCard.appendChild(createToggleRow("FrankerFaceZ", "ffzEmotes", settings.ffzEmotes !== false, "Load FrankerFaceZ emotes in chat"));
        emotesCard.appendChild(createToggleRow("7TV", "sevenTvEmotes", settings.sevenTvEmotes !== false, "Load 7TV emotes in chat"));
        emotesTab.appendChild(emotesCard);

        emotesTab.appendChild(createSectionTitle("7TV Advanced"));
        const sevenTvCard = document.createElement("div");
        sevenTvCard.className = "tp-setting-card";
        sevenTvCard.appendChild(createToggleRow("Live Emote Updates", "sevenTvEventApi", settings.sevenTvEventApi !== false, "Sync emote changes in real time via 7TV EventAPI"));
        sevenTvCard.appendChild(createToggleRow("Cosmetics", "sevenTvCosmetics", settings.sevenTvCosmetics !== false, "Show 7TV badges and username paints"));
        emotesTab.appendChild(sevenTvCard);

        content.appendChild(emotesTab);
        tabContents["emotes"] = emotesTab;

        // ── CHAT TAB ──
        const chatTab = document.createElement("div");
        chatTab.className = "tp-tab-content";

        chatTab.appendChild(createSectionTitle("Appearance"));
        const chatAppCard = document.createElement("div");
        chatAppCard.className = "tp-setting-card";
        chatAppCard.appendChild(createToggleRow("Timestamps", "chatTimestamps", !!settings.chatTimestamps, "Show HH:MM before each message"));
        chatAppCard.appendChild(createToggleRow("Alternating Backgrounds", "splitChat", !!settings.splitChat, "Alternate clear/dark rows for readability"));
        chatAppCard.appendChild(createToggleRow("User Colors", "alternatingUsers", !!settings.alternatingUsers, "Color-code message backgrounds per user"));
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
        chatTab.appendChild(chatAppCard);

        chatTab.appendChild(createSectionTitle("Behavior"));
        const chatBehCard = document.createElement("div");
        chatBehCard.className = "tp-setting-card";
        chatBehCard.appendChild(createToggleRow("Show Deleted Messages", "showDeletedMessages", !!settings.showDeletedMessages, "Keep deleted messages visible with strikethrough"));
        chatBehCard.appendChild(createToggleRow("Mention Highlights", "mentionHighlights", settings.mentionHighlights !== false, "Highlight messages that mention your name"));
        chatBehCard.appendChild(createToggleRow("Emote Tab-Completion", "emoteTabCompletion", settings.emoteTabCompletion !== false, "Press Tab to autocomplete emote names"));
        chatBehCard.appendChild(createToggleRow("Lurk Mode", "lurkMode", !!settings.lurkMode, "Grey out chat input to avoid accidental messages"));
        chatTab.appendChild(chatBehCard);

        chatTab.appendChild(createSectionTitle("Filters"));
        chatTab.appendChild(createKeywordEditor("Highlight Keywords", "highlightKeywords", settings.highlightKeywords || []));
        chatTab.appendChild(createKeywordEditor("Hidden Keywords", "hiddenKeywords", settings.hiddenKeywords || []));
        chatTab.appendChild(createNicknameEditor("Custom Nicknames", "customNicknames", settings.customNicknames || {}));

        content.appendChild(chatTab);
        tabContents["chat"] = chatTab;

        // ── PLAYER TAB ──
        const playerTab = document.createElement("div");
        playerTab.className = "tp-tab-content";

        playerTab.appendChild(createSectionTitle("Audio & Video"));
        const avCard = document.createElement("div");
        avCard.className = "tp-setting-card";
        avCard.appendChild(createToggleRow("Audio Compressor", "audioCompressor", !!settings.audioCompressor, "Normalize loud/quiet audio for consistent volume"));
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
        playerTab.appendChild(avCard);

        playerTab.appendChild(createSectionTitle("Theater Mode"));
        const theaterCard = document.createElement("div");
        theaterCard.className = "tp-setting-card";
        theaterCard.appendChild(createToggleRow("Auto Theater Mode", "autoTheaterMode", !!settings.autoTheaterMode, "Automatically enter theater mode on channel pages"));
        theaterCard.appendChild(createToggleRow("OLED Black Background", "theaterOledBlack", !!settings.theaterOledBlack, "Pure black background for OLED screens"));
        theaterCard.appendChild(createToggleRow("Transparent Chat Overlay", "theaterTransparentChat", !!settings.theaterTransparentChat, "Chat floats over the video with a blurred backdrop"));
        playerTab.appendChild(theaterCard);

        content.appendChild(playerTab);
        tabContents["player"] = playerTab;

        // ── AUTO TAB ──
        const autoTab = document.createElement("div");
        autoTab.className = "tp-tab-content";

        autoTab.appendChild(createSectionTitle("Auto-Claim"));
        const autoCard = document.createElement("div");
        autoCard.className = "tp-setting-card";
        autoCard.appendChild(createToggleRow("Channel Points", "autoClaimPoints", !!settings.autoClaimPoints, "Automatically click the bonus channel points button"));
        autoCard.appendChild(createToggleRow("Drops", "autoClaimDrops", !!settings.autoClaimDrops, "Automatically claim available Twitch Drops"));
        autoCard.appendChild(createToggleRow("Moments", "autoClaimMoments", !!settings.autoClaimMoments, "Automatically claim streamer Moments"));
        autoTab.appendChild(autoCard);

        content.appendChild(autoTab);
        tabContents["auto"] = autoTab;

        // ── MOD TAB ──
        const modTab = document.createElement("div");
        modTab.className = "tp-tab-content";

        modTab.appendChild(createSectionTitle("Moderation Tools"));
        const modCard = document.createElement("div");
        modCard.className = "tp-setting-card";
        modCard.appendChild(createToggleRow("Quick Timeout Buttons", "modToolsEnabled", !!settings.modToolsEnabled, "Show 1m/10m/1h timeout buttons on hover"));
        modTab.appendChild(modCard);

        content.appendChild(modTab);
        tabContents["mod"] = modTab;

        // ── UI TAB ──
        const uiTab = document.createElement("div");
        uiTab.className = "tp-tab-content";

        uiTab.appendChild(createSectionTitle("Interface"));
        const uiCard = document.createElement("div");
        uiCard.className = "tp-setting-card";
        uiCard.appendChild(createToggleRow("Hide UI Clutter", "hideClutter", !!settings.hideClutter, "Hide bits, hype chat, prime promos, streaks, and more"));
        uiTab.appendChild(uiCard);

        uiTab.appendChild(createSectionTitle("Channel Profiles"));
        uiTab.appendChild(createProfileSection());

        content.appendChild(uiTab);
        tabContents["ui"] = uiTab;

        panel.appendChild(content);

        // ── Footer ──
        const footer = document.createElement("div");
        footer.className = "tp-panel-footer";
        footer.innerHTML = `<span>Twitch Plus v2.0.0</span>`;
        panel.appendChild(footer);

        // Apply disabled state to non-master toggles if extension is off
        updatePanelDisabledState(panel);

        return panel;
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
    function createProfileSection() {
        const container = document.createElement("div");
        container.className = "tp-keyword-editor";

        const channelLabel = document.createElement("div");
        channelLabel.className = "tp-keyword-title";
        channelLabel.textContent = currentChannel
            ? `Channel: ${currentChannel}`
            : "No channel active";
        container.appendChild(channelLabel);

        const hasProfile = !!(settings.channelProfiles?.[currentChannel]);

        const btnRow = document.createElement("div");
        btnRow.className = "tp-keyword-input-row";

        const saveBtn = document.createElement("button");
        saveBtn.className = "tp-profile-btn";
        saveBtn.textContent = hasProfile ? "Update" : "Save";
        saveBtn.addEventListener("click", async () => {
            if (!currentChannel) return;
            // Save current non-profile settings as this channel's profile
            const profileData = { ...settings };
            delete profileData.channelProfiles;
            delete profileData.enabled;
            try {
                await browser.runtime.sendMessage({
                    action: "saveChannelProfile",
                    channel: currentChannel,
                    profileSettings: profileData,
                });
                saveBtn.textContent = "Saved!";
                setTimeout(() => { saveBtn.textContent = "Update"; }, 1500);
                console.log(`[Twitch Plus] Profile saved for ${currentChannel}`);
            } catch (e) {
                console.error("[Twitch Plus] Failed to save profile:", e);
            }
        });
        btnRow.appendChild(saveBtn);

        if (hasProfile) {
            const deleteBtn = document.createElement("button");
            deleteBtn.className = "tp-profile-btn tp-profile-btn-secondary";
            deleteBtn.textContent = "Delete";
            deleteBtn.addEventListener("click", async () => {
                if (!currentChannel) return;
                try {
                    await browser.runtime.sendMessage({
                        action: "deleteChannelProfile",
                        channel: currentChannel,
                    });
                    deleteBtn.textContent = "Deleted";
                    deleteBtn.disabled = true;
                    console.log(`[Twitch Plus] Profile deleted for ${currentChannel}`);
                } catch (e) {
                    console.error("[Twitch Plus] Failed to delete profile:", e);
                }
            });
            btnRow.appendChild(deleteBtn);
        }

        container.appendChild(btnRow);
        return container;
    }

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
        // Disable all setting cards and toggle rows (except master toggle)
        panel.querySelectorAll(".tp-setting-card, .tp-keyword-editor").forEach((card) => {
            card.classList.toggle("tp-disabled", !isEnabled);
        });
        panel.querySelectorAll(".tp-toggle-row").forEach((row) => {
            if (row.dataset.settingKey === "enabled") return;
            row.classList.toggle("tp-disabled", !isEnabled);
        });
        // Disable tab buttons
        panel.querySelectorAll(".tp-tab-btn").forEach((btn) => {
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
                if (container) {
                    const isDarkTheme = document.querySelector(".tw-root--theme-dark") ||
                        document.querySelector("[class*='dark-theme']") ||
                        document.documentElement.classList.contains("tw-root--theme-dark");
                    if (value) {
                        // Apply alternating backgrounds to existing messages using inline styles
                        altRowIndex = 0;
                        const msgs = container.querySelectorAll(CHAT_LINE_SELECTOR);
                        msgs.forEach((msg) => {
                            if (altRowIndex % 2 === 1) {
                                msg.style.backgroundColor = isDarkTheme !== null
                                    ? "rgba(255, 255, 255, 0.04)"
                                    : "rgba(0, 0, 0, 0.04)";
                            } else {
                                msg.style.backgroundColor = "";
                            }
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
                if (settings.autoClaimPoints || settings.autoClaimDrops || settings.autoClaimMoments) {
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

            case "audioCompressor":
                document.dispatchEvent(new CustomEvent(
                    value ? "tp-enable-compressor" : "tp-disable-compressor"
                ));
                break;

            case "autoQuality":
                document.dispatchEvent(new CustomEvent("tp-set-quality", { detail: { quality: value } }));
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
        console.log(`[Twitch Plus] Channel changed: ${channel}`);

        // Fire-and-forget features that don't depend on chat or emotes:
        // These run immediately and use their own internal retry/timing.
        autoTheaterMode();

        if (settings.autoClaimPoints || settings.autoClaimDrops || settings.autoClaimMoments) {
            startAutoClaimPoints();
        } else {
            stopAutoClaimPoints();
        }

        // Load channel-specific profile if available
        try {
            const profileResp = await browser.runtime.sendMessage({
                action: "getChannelProfile",
                channel: channel,
            });
            if (profileResp?.settings) {
                settings = profileResp.settings;
                applyBodyClasses();
                applyChatFont();
            }
        } catch (e) {
            // Profile load failed — use current settings
        }

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

            // Apply settings that depend on the chat container being ready
            applySettingChange("splitChat", settings.splitChat);
            applySettingChange("alternatingUsers", settings.alternatingUsers);
            if (settings.lurkMode) applySettingChange("lurkMode", true);
        } catch (e) {
            console.warn("[Twitch Plus] Chat container not found after channel change.");
        }

        // Inject settings button next to chat gear
        injectSettingsButton();

        // Init emote tab-completion
        initEmoteCompletion();
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
    // 10. Listen for navigation events from the page-world script
    // ---------------------------------------------------------------------------

    document.addEventListener("twitch-plus-navigation", (e) => {
        const { channel } = e.detail;
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
    // 11. Listen for settings updates from popup
    // ---------------------------------------------------------------------------

    browser.runtime.onMessage.addListener((request) => {
        if (request.action === "settingsUpdated") {
            settings = request.settings || settings;

            // Apply all live changes
            applySettingChange("splitChat", settings.splitChat);
            applySettingChange("alternatingUsers", settings.alternatingUsers);
            applySettingChange("autoClaimPoints", settings.autoClaimPoints);
            applySettingChange("lurkMode", settings.lurkMode);
            applySettingChange("emoteTabCompletion", settings.emoteTabCompletion);
            applySettingChange("audioCompressor", settings.audioCompressor);
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
                    delete emoteMap[name];
                }
            }

            // Add new emotes
            if (addedEmotes?.length > 0) {
                for (const emote of addedEmotes) {
                    emoteMap[emote.name] = emote;
                }
            }

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

            const defaultOn = ["enabled", "bttvEmotes", "ffzEmotes", "sevenTvEmotes", "sevenTvEventApi", "sevenTvCosmetics", "mentionHighlights", "firstTimeChatterHighlight", "spoilerHiding", "emoteTabCompletion"];
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

        // Audio compressor (delayed to let video load)
        if (settings.audioCompressor) {
            setTimeout(() => {
                document.dispatchEvent(new CustomEvent("tp-enable-compressor"));
            }, 3000);
        }

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
        const excluded = new Set([
            "directory", "downloads", "jobs", "turbo", "settings",
            "subscriptions", "inventory", "wallet", "friends",
            "moderator", "search", "following", "videos", "",
        ]);
        const parts = path.split("/").filter(Boolean);
        const initialChannel = pendingChannel
            || (parts.length > 0 && !excluded.has(parts[0].toLowerCase()) ? parts[0].toLowerCase() : null);
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

    init();
})();
