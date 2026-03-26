/**
 * Twitch Plus — Page-World Script
 *
 * This script runs in the PAGE context (not the extension's isolated world).
 * It can access Twitch's own JS objects, React internals, and the auth token.
 *
 * Communication with the content script happens via CustomEvents on document.
 */
(function () {
    "use strict";

    // Avoid double injection
    if (window.__twitchPlusInjected) return;
    window.__twitchPlusInjected = true;

    // ---------------------------------------------------------------------------
    // 1. Extract the current channel's Twitch user ID from React fiber tree
    // ---------------------------------------------------------------------------

    /**
     * Walk up the React fiber tree from a DOM element looking for a component
     * whose props contain the given key path.
     */
    function getReactFiber(element) {
        if (!element) return null;
        const key = Object.keys(element).find(
            (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")
        );
        return key ? element[key] : null;
    }

    function findReactProp(element, propPath, maxDepth = 25) {
        let fiber = getReactFiber(element);
        let depth = 0;
        while (fiber && depth < maxDepth) {
            const props = fiber.memoizedProps || fiber.pendingProps;
            if (props) {
                const val = propPath.split(".").reduce((obj, key) => obj && obj[key], props);
                if (val !== undefined && val !== null) return val;
            }
            // Also check stateNode
            if (fiber.stateNode && fiber.stateNode !== element) {
                const stateProps = fiber.stateNode.props;
                if (stateProps) {
                    const val = propPath.split(".").reduce((obj, key) => obj && obj[key], stateProps);
                    if (val !== undefined && val !== null) return val;
                }
            }
            fiber = fiber.return;
            depth++;
        }
        return null;
    }

    /**
     * Try to extract the channel ID from the page's React tree.
     * We look at common container elements Twitch uses.
     */
    function extractChannelId() {
        // Method 1: From the chat room component (BTTV-style selector)
        const chatRoom = document.querySelector("section[data-test-selector='chat-room-component-layout']");
        if (chatRoom) {
            const id =
                findReactProp(chatRoom, "channelID") ||
                findReactProp(chatRoom, "channelId") ||
                findReactProp(chatRoom, "channel.id");
            if (id) return id;
        }

        // Method 2: From the chat shell/stream-chat containers
        const chatContainers = [
            ".chat-shell",
            ".stream-chat",
            "[data-a-target='chat-scroller']",
            ".chat-room",
        ];
        for (const sel of chatContainers) {
            const el = document.querySelector(sel);
            if (!el) continue;
            const id =
                findReactProp(el, "channelID") ||
                findReactProp(el, "channelId") ||
                findReactProp(el, "channel.id") ||
                findReactProp(el, "contentID");
            if (id) return id;
        }

        // Method 3: From the video player
        const playerSelectors = [
            "[data-a-target='video-player']",
            ".video-player",
            "div[data-a-target='player-overlay-click-handler']",
        ];
        for (const sel of playerSelectors) {
            const el = document.querySelector(sel);
            if (!el) continue;
            const id = findReactProp(el, "channelID") || findReactProp(el, "channelId");
            if (id) return id;
        }

        // Method 4: From the page root (broadest — slowest)
        const root = document.querySelector("#root");
        if (root) {
            const id = findReactProp(root, "channelID") || findReactProp(root, "channelId");
            if (id) return id;
        }

        return null;
    }

    /**
     * Try to extract the auth token from cookies.
     */
    function extractAuthToken() {
        const match = document.cookie.match(/auth-token=([^;]+)/);
        return match ? match[1] : null;
    }

    // ---------------------------------------------------------------------------
    // 2. Navigation detection — Twitch is an SPA
    // ---------------------------------------------------------------------------

    let lastPathname = location.pathname;

    function notifyNavigation() {
        const channel = parseChannelFromPath(location.pathname);
        document.dispatchEvent(
            new CustomEvent("twitch-plus-navigation", {
                detail: { pathname: location.pathname, channel },
            })
        );
    }

    function parseChannelFromPath(pathname) {
        // Twitch channel URLs: /channelname or /channelname/videos etc.
        // Exclude known non-channel paths
        const excluded = new Set([
            "directory", "downloads", "jobs", "turbo", "settings",
            "subscriptions", "inventory", "wallet", "friends",
            "moderator", "search", "following", "videos", "",
        ]);
        const parts = pathname.split("/").filter(Boolean);
        if (parts.length === 0) return null;
        const first = parts[0].toLowerCase();
        if (excluded.has(first)) return null;
        return first;
    }

    // Intercept history.pushState / replaceState
    const origPushState = history.pushState;
    const origReplaceState = history.replaceState;

    history.pushState = function (...args) {
        origPushState.apply(this, args);
        if (location.pathname !== lastPathname) {
            lastPathname = location.pathname;
            notifyNavigation();
        }
    };

    history.replaceState = function (...args) {
        origReplaceState.apply(this, args);
        if (location.pathname !== lastPathname) {
            lastPathname = location.pathname;
            notifyNavigation();
        }
    };

    window.addEventListener("popstate", () => {
        if (location.pathname !== lastPathname) {
            lastPathname = location.pathname;
            notifyNavigation();
        }
    });

    // ---------------------------------------------------------------------------
    // 3. Respond to channel ID requests from the content script
    // ---------------------------------------------------------------------------

    document.addEventListener("twitch-plus-request-channel-id", () => {
        const channelId = extractChannelId();
        const authToken = extractAuthToken();
        document.dispatchEvent(
            new CustomEvent("twitch-plus-channel-id", {
                detail: { channelId, authToken },
            })
        );
    });

    // Fire an initial navigation event so content.js can pick up the current page
    setTimeout(() => {
        notifyNavigation();
    }, 500);

    // ---------------------------------------------------------------------------
    // 4. Audio Compressor
    // ---------------------------------------------------------------------------

    let compressorCtx = null;
    let compressorNode = null;
    let sourceNode = null;
    let compressorEnabled = false;

    function enableAudioCompressor() {
        if (compressorEnabled) return;
        const video = document.querySelector("video");
        if (!video) {
            console.warn("[Twitch Plus] No video element found for audio compressor.");
            return;
        }

        try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) {
                console.warn("[Twitch Plus] AudioContext not supported.");
                return;
            }

            // Only create source once per video element
            if (!video.__tpAudioSource) {
                compressorCtx = new AudioCtx();
                sourceNode = compressorCtx.createMediaElementSource(video);
                video.__tpAudioSource = sourceNode;
                video.__tpAudioCtx = compressorCtx;
            } else {
                sourceNode = video.__tpAudioSource;
                compressorCtx = video.__tpAudioCtx;
            }

            compressorNode = compressorCtx.createDynamicsCompressor();

            // Conservative defaults for stream audio normalization
            compressorNode.threshold.setValueAtTime(-50, compressorCtx.currentTime);
            compressorNode.knee.setValueAtTime(40, compressorCtx.currentTime);
            compressorNode.ratio.setValueAtTime(12, compressorCtx.currentTime);
            compressorNode.attack.setValueAtTime(0, compressorCtx.currentTime);
            compressorNode.release.setValueAtTime(0.25, compressorCtx.currentTime);

            // Route: source -> compressor -> destination
            sourceNode.disconnect();
            sourceNode.connect(compressorNode);
            compressorNode.connect(compressorCtx.destination);

            // Resume context if suspended (Safari autoplay policy)
            if (compressorCtx.state === "suspended") {
                compressorCtx.resume();
            }

            compressorEnabled = true;
            console.log("[Twitch Plus] Audio compressor enabled.");
        } catch (e) {
            console.error("[Twitch Plus] Failed to enable audio compressor:", e);
        }
    }

    function disableAudioCompressor() {
        if (!compressorEnabled || !sourceNode || !compressorCtx) return;

        try {
            sourceNode.disconnect();
            if (compressorNode) compressorNode.disconnect();
            sourceNode.connect(compressorCtx.destination);
            compressorEnabled = false;
            console.log("[Twitch Plus] Audio compressor disabled (bypass).");
        } catch (e) {
            console.error("[Twitch Plus] Failed to disable audio compressor:", e);
        }
    }

    document.addEventListener("tp-enable-compressor", () => enableAudioCompressor());
    document.addEventListener("tp-disable-compressor", () => disableAudioCompressor());

    // ---------------------------------------------------------------------------
    // 5. Auto Quality Control
    // ---------------------------------------------------------------------------

    function setVideoQuality(quality) {
        if (!quality) return;

        // Try via React player instance
        try {
            const playerEl = document.querySelector(".video-player__container video")
                || document.querySelector("video");
            if (playerEl) {
                const fiber = getReactFiber(playerEl.closest("[data-a-target=\"video-player\"]") || playerEl.parentElement);
                if (fiber) {
                    let node = fiber;
                    for (let i = 0; i < 30; i++) {
                        const player = node?.memoizedProps?.mediaPlayerInstance
                            || node?.stateNode?.props?.mediaPlayerInstance
                            || node?.memoizedState?.player;
                        if (player && typeof player.setQuality === "function") {
                            const qualities = player.getQualities?.() || [];
                            const target = qualities.find((q) =>
                                q.group === quality || q.name?.toLowerCase().includes(quality.toLowerCase())
                            );
                            if (target) {
                                player.setQuality(target.group);
                                console.log(`[Twitch Plus] Quality set to: ${target.name || quality}`);
                                return;
                            }
                        }
                        node = node.return;
                        if (!node) break;
                    }
                }
            }
        } catch (e) {
            console.warn("[Twitch Plus] React player quality method failed:", e);
        }

        // Fallback: DOM-click through quality menu
        try {
            const settingsBtn = document.querySelector('[data-a-target="player-settings-button"]');
            if (settingsBtn) {
                settingsBtn.click();
                setTimeout(() => {
                    const qualityBtn = document.querySelector('[data-a-target="player-settings-menu-item-quality"]');
                    if (qualityBtn) {
                        qualityBtn.click();
                        setTimeout(() => {
                            const options = document.querySelectorAll('[data-a-target="player-settings-submenu-quality-option"] input');
                            for (const opt of options) {
                                const label = opt.closest("label")?.textContent?.toLowerCase() || "";
                                if (label.includes(quality.replace("p", "")) || (quality === "chunked" && label.includes("source"))) {
                                    opt.click();
                                    console.log(`[Twitch Plus] Quality set via DOM: ${label.trim()}`);
                                    break;
                                }
                            }
                            // Close the settings menu
                            settingsBtn.click();
                        }, 200);
                    }
                }, 200);
            }
        } catch (e) {
            console.warn("[Twitch Plus] DOM quality fallback failed:", e);
        }
    }

    document.addEventListener("tp-set-quality", (e) => {
        const { quality } = e.detail || {};
        if (quality) {
            // Delay slightly to let the player initialize
            setTimeout(() => setVideoQuality(quality), 2000);
        }
    });

    // ---------------------------------------------------------------------------
    // 6. Disable Autoplay on non-channel pages
    // ---------------------------------------------------------------------------

    const path = location.pathname;
    const isNonChannelPage = path === "/" || path === "" || path.startsWith("/directory");
    if (isNonChannelPage) {
        // Intercept HTMLMediaElement.play on homepage/directory
        const originalPlay = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function () {
            // Allow play if user explicitly interacted (check for our flag)
            if (this.dataset.tpUserPlayed) {
                return originalPlay.call(this);
            }
            // Block autoplay on homepage
            console.log("[Twitch Plus] Blocked autoplay on non-channel page.");
            return Promise.resolve();
        };
    }

    console.log("[Twitch Plus] Page-world script loaded.");
})();
