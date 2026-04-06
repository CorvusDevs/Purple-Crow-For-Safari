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

        // Method 5: From VOD/clip page — try the video owner/broadcaster info components
        const vodSelectors = [
            "[data-a-target='video-info-card']",
            ".channel-info-content",
            "[data-a-target='user-channel-header-item']",
            ".video-chat",
            ".clips-side-bar",
            ".clips-chat-and-actions",
        ];
        for (const sel of vodSelectors) {
            const el = document.querySelector(sel);
            if (!el) continue;
            const id =
                findReactProp(el, "channelID") ||
                findReactProp(el, "channelId") ||
                findReactProp(el, "channel.id") ||
                findReactProp(el, "broadcaster.id") ||
                findReactProp(el, "broadcasterId") ||
                findReactProp(el, "owner.id") ||
                findReactProp(el, "videoOwner.id") ||
                findReactProp(el, "clip.broadcaster.id");
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

    const EXCLUDED_PATHS = new Set([
        "directory", "downloads", "jobs", "turbo", "settings",
        "subscriptions", "inventory", "wallet", "friends",
        "moderator", "search", "following", "videos", "",
    ]);

    function parseChannelFromPath(pathname) {
        // Twitch channel URLs: /channelname or /channelname/videos etc.
        // VOD/clip pages are NOT channel pages even though they contain a username:
        //   /username/clip/ClipName  → clip page
        //   /videos/123456           → VOD page
        if (pathname.includes("/clip/") || pathname.includes("/videos/")) return null;

        const parts = pathname.split("/").filter(Boolean);
        if (parts.length === 0) return null;
        const first = parts[0].toLowerCase();
        if (EXCLUDED_PATHS.has(first)) return null;
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
    // 4. (Removed) Audio Compressor — not possible in Safari due to WebKit bug
    //    #231656: createMediaElementSource() doesn't route HLS/MSE audio.
    // ---------------------------------------------------------------------------

    // ---------------------------------------------------------------------------
    // 5. Auto Quality Control
    // ---------------------------------------------------------------------------

    /**
     * Quality resolution order for fallback (highest to lowest).
     * "chunked" = Source (raw ingest).
     */
    const QUALITY_ORDER = ["chunked", "1440p", "1080p60", "1080p", "720p60", "720p", "480p", "360p", "160p"];

    /**
     * Match a user quality choice to available player qualities.
     * Returns the best match or the next-highest fallback.
     */
    function findBestQuality(qualities, target) {
        if (!qualities || qualities.length === 0) return null;
        if (target === "chunked") {
            // Source: prefer "chunked" group or first quality (usually source)
            const src = qualities.find(q => q.group === "chunked");
            if (src) return src;
            return qualities[0]; // first is typically highest/source
        }

        // Extract numeric resolution from target (e.g. "1080p" -> 1080, "1440p" -> 1440)
        const targetRes = parseInt(target);

        // Try exact match first
        const exact = qualities.find(q =>
            q.group === target ||
            q.name?.toLowerCase().includes(target.toLowerCase()) ||
            (targetRes && q.name?.match(/(\d+)p/) && parseInt(q.name.match(/(\d+)p/)[1]) === targetRes)
        );
        if (exact) return exact;

        // Fallback: find the next-highest resolution below the target
        // Parse all available qualities with their numeric resolutions
        const parsed = qualities.map(q => {
            const match = q.name?.match(/(\d+)p/);
            return { quality: q, res: match ? parseInt(match[1]) : (q.group === "chunked" ? 9999 : 0) };
        }).sort((a, b) => b.res - a.res);

        // Find the closest resolution that doesn't exceed target (or the highest available)
        if (targetRes) {
            const fallback = parsed.find(p => p.res <= targetRes);
            if (fallback) return fallback.quality;
        }

        // Last resort: highest available quality
        if (parsed.length > 0) return parsed[0].quality;
        return null;
    }

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
                            if (qualities.length > 0) {
                                const target = findBestQuality(qualities, quality);
                                if (target) {
                                    player.setQuality(target.group);
                                    console.log(`[Twitch Plus] Quality set to: ${target.name || target.group} (requested: ${quality})`);
                                    return;
                                }
                                console.warn(`[Twitch Plus] No matching quality for "${quality}". Available:`, qualities.map(q => q.name || q.group));
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
                            const targetRes = parseInt(quality);
                            let matched = false;

                            // First pass: exact match
                            for (const opt of options) {
                                const label = opt.closest("label")?.textContent?.toLowerCase() || "";
                                if (label.includes(quality.replace("p", "")) || (quality === "chunked" && label.includes("source"))) {
                                    opt.click();
                                    console.log(`[Twitch Plus] Quality set via DOM: ${label.trim()}`);
                                    matched = true;
                                    break;
                                }
                            }

                            // Second pass: fallback to next highest
                            if (!matched && targetRes) {
                                const sortedOpts = [...options].map(opt => {
                                    const label = opt.closest("label")?.textContent || "";
                                    const match = label.match(/(\d+)p/);
                                    return { opt, res: match ? parseInt(match[1]) : 0, label };
                                }).sort((a, b) => b.res - a.res);

                                const fallback = sortedOpts.find(o => o.res <= targetRes) || sortedOpts[0];
                                if (fallback) {
                                    fallback.opt.click();
                                    console.log(`[Twitch Plus] Quality fallback via DOM: ${fallback.label.trim()} (requested: ${quality})`);
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
        if (!quality) return;

        let attempts = 0;
        const maxAttempts = 5;

        function trySetQuality() {
            attempts++;
            const video = document.querySelector("video");
            if (!video || !video.readyState) {
                if (attempts < maxAttempts) {
                    console.log(`[Twitch Plus] Player not ready for quality set, retry ${attempts}/${maxAttempts}...`);
                    setTimeout(trySetQuality, 1500);
                    return;
                }
            }
            setVideoQuality(quality);
        }

        // Initial delay to let the player start loading
        setTimeout(trySetQuality, 2000);
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

    // ---------------------------------------------------------------------------
    // 7. Enhanced User Card Data (GQL)
    // ---------------------------------------------------------------------------

    /**
     * Fetch user data via Twitch's GQL API.
     * Requires the auth token from cookies (available in page world).
     */
    document.addEventListener("tp-request-user-data", async (e) => {
        const { login } = e.detail || {};
        if (!login) return;

        const authToken = extractAuthToken();
        const clientId = "kimne78kx3ncx6brgo4mv6wki5h1ko"; // Twitch first-party client ID

        try {
            const resp = await fetch("https://gql.twitch.tv/gql", {
                method: "POST",
                headers: {
                    "Client-Id": clientId,
                    ...(authToken ? { "Authorization": `OAuth ${authToken}` } : {}),
                    "Content-Type": "application/json",
                },
                body: JSON.stringify([
                    {
                        operationName: "ViewerCard",
                        variables: { channelLogin: parseChannelFromPath(location.pathname), targetLogin: login },
                        extensions: {
                            persistedQuery: {
                                version: 1,
                                sha256Hash: "0a269a1a94a7b44e79e52cd23b27e657ab269c08ebf3326b94de0e1a4c1409b4",
                            },
                        },
                    },
                ]),
            });

            if (!resp.ok) throw new Error(`GQL returned ${resp.status}`);
            const json = await resp.json();
            const userData = json?.[0]?.data?.targetUser;
            const relationship = json?.[0]?.data?.targetUser?.relationship;

            document.dispatchEvent(new CustomEvent("tp-user-data-response", {
                detail: {
                    login,
                    createdAt: userData?.createdAt || null,
                    followDate: relationship?.followedAt || null,
                },
            }));
        } catch (err) {
            console.warn("[Twitch Plus] GQL user card fetch failed:", err);
            // Fallback: try simpler query
            try {
                const resp = await fetch("https://gql.twitch.tv/gql", {
                    method: "POST",
                    headers: {
                        "Client-Id": clientId,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        query: `query { user(login: "${login}") { createdAt } }`,
                    }),
                });
                const json = await resp.json();
                document.dispatchEvent(new CustomEvent("tp-user-data-response", {
                    detail: {
                        login,
                        createdAt: json?.data?.user?.createdAt || null,
                        followDate: null,
                    },
                }));
            } catch (e2) {
                console.warn("[Twitch Plus] GQL fallback also failed:", e2);
                document.dispatchEvent(new CustomEvent("tp-user-data-response", {
                    detail: { login, createdAt: null, followDate: null },
                }));
            }
        }
    });

    // ---------------------------------------------------------------------------
    // 8. VOD Metadata Fetcher (GQL)
    // ---------------------------------------------------------------------------

    document.addEventListener("tp-request-vod-data", async (e) => {
        const { videoId } = e.detail || {};
        if (!videoId) return;

        const clientId = "kimne78kx3ncx6brgo4mv6wki5h1ko";
        const authToken = extractAuthToken();

        try {
            const resp = await fetch("https://gql.twitch.tv/gql", {
                method: "POST",
                headers: {
                    "Client-Id": clientId,
                    ...(authToken ? { "Authorization": `OAuth ${authToken}` } : {}),
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    query: `query { video(id: "${videoId}") { createdAt title broadcastType owner { id login displayName } } }`,
                }),
            });
            const json = await resp.json();
            const video = json?.data?.video;
            document.dispatchEvent(new CustomEvent("tp-vod-data-response", {
                detail: {
                    videoId,
                    createdAt: video?.createdAt || null,
                    title: video?.title || null,
                    broadcastType: video?.broadcastType || null,
                    ownerId: video?.owner?.id || null,
                    ownerLogin: video?.owner?.login || null,
                },
            }));
            console.log("[Twitch Plus] VOD data fetched:", video?.createdAt, "owner:", video?.owner?.login);
        } catch (e) {
            console.error("[Twitch Plus] Failed to fetch VOD data:", e);
            document.dispatchEvent(new CustomEvent("tp-vod-data-response", {
                detail: { videoId, createdAt: null },
            }));
        }
    });

    // ---------------------------------------------------------------------------
    // 9. Clip Owner Resolver (GQL)
    // ---------------------------------------------------------------------------

    document.addEventListener("tp-request-clip-data", async (e) => {
        const { slug } = e.detail || {};
        if (!slug) return;

        const clientId = "kimne78kx3ncx6brgo4mv6wki5h1ko";
        const authToken = extractAuthToken();

        try {
            const resp = await fetch("https://gql.twitch.tv/gql", {
                method: "POST",
                headers: {
                    "Client-Id": clientId,
                    ...(authToken ? { "Authorization": `OAuth ${authToken}` } : {}),
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    query: `query { clip(slug: "${slug}") { broadcaster { id login displayName } } }`,
                }),
            });
            const json = await resp.json();
            const clip = json?.data?.clip;
            document.dispatchEvent(new CustomEvent("tp-clip-data-response", {
                detail: {
                    slug,
                    broadcasterId: clip?.broadcaster?.id || null,
                    broadcasterLogin: clip?.broadcaster?.login || null,
                },
            }));
            console.log("[Twitch Plus] Clip data fetched, broadcaster:", clip?.broadcaster?.login);
        } catch (e) {
            console.error("[Twitch Plus] Failed to fetch clip data:", e);
            document.dispatchEvent(new CustomEvent("tp-clip-data-response", {
                detail: { slug, broadcasterId: null },
            }));
        }
    });

    // ---------------------------------------------------------------------------
    // 10. Anonymous Chat Mode — justinfan approach (like BTTV)
    //
    // Instead of blocking JOIN/PART at the WebSocket level (which breaks
    // Twitch's ChatConnectionService), we mutate Twitch's internal chat
    // client username to "justinfan12345" and send QUIT to force a reconnect.
    // The justinfan identity is read-only: messages keep flowing, but the
    // user is invisible in the viewer/chatter list and cannot send messages.
    // ---------------------------------------------------------------------------

    let tpAnonChat = false;
    let tpAnonReconnecting = false;  // True while waiting for reconnect after leaving anon
    let tpRealUsername = null;
    let tpRealPass = null;   // Saved real PASS command (e.g., "PASS oauth:...")
    let tpRealNick = null;   // Saved real NICK (e.g., "pepe_jos3")

    /**
     * Get the React root fiber from the #root DOM element.
     * Twitch uses either _reactRootContainer (legacy) or __reactContainer$ (concurrent).
     */
    function getReactRoot(element) {
        if (!element) return null;
        for (const key in element) {
            if (key.startsWith("_reactRootContainer") || key.startsWith("__reactContainer$")) {
                return element[key];
            }
        }
        return null;
    }

    /**
     * DFS through the React fiber tree via child/sibling links.
     * This matches BTTV's searchReactChildren pattern.
     */
    function searchReactChildren(node, predicate, maxDepth = 150, depth = 0) {
        if (!node || depth > maxDepth) return null;
        try { if (predicate(node)) return node; } catch (_) {}
        return (
            searchReactChildren(node.child, predicate, maxDepth, depth + 1) ||
            searchReactChildren(node.sibling, predicate, maxDepth, depth + 1)
        );
    }

    /**
     * Find Twitch's internal chat service client by searching DOWN from
     * the React root — matching BTTV's getChatServiceClient() approach.
     * The predicate looks for a fiber whose stateNode has both .join and .client.
     */
    let cachedChatClient = null;

    function findChatServiceClient() {
        if (cachedChatClient) {
            // Verify the cached client is still valid
            try {
                if (cachedChatClient.connection && cachedChatClient.configuration) {
                    return cachedChatClient;
                }
            } catch (_) {}
            cachedChatClient = null;
        }

        try {
            const rootEl = document.querySelector("#root");
            const reactRoot = getReactRoot(rootEl);
            const fiberRoot = reactRoot?._internalRoot?.current ?? reactRoot;

            if (!fiberRoot) {
                console.warn("[Twitch Plus] Could not find React root fiber.");
                return null;
            }

            // BTTV's predicate: stateNode has .join (method) and .client
            const node = searchReactChildren(
                fiberRoot,
                (n) => n.stateNode && n.stateNode.join && n.stateNode.client,
                1000
            );

            if (node) {
                cachedChatClient = node.stateNode.client;
                console.log("[Twitch Plus] Found chat service client via React root DFS.");
                return cachedChatClient;
            }
        } catch (e) {
            console.warn("[Twitch Plus] Error searching React tree for chat client:", e);
        }

        // Fallback: try walking UP from chat DOM elements (older Twitch versions)
        const selectors = [
            "section[data-test-selector='chat-room-component-layout']",
            ".stream-chat",
            ".chat-shell",
        ];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (!el) continue;
            let fiber = getReactFiber(el);
            for (let i = 0; i < 50 && fiber; i++) {
                // Check stateNode.props.chatConnectionAPI (BTTV's getChatController pattern)
                const sn = fiber.stateNode;
                if (sn?.props?.chatConnectionAPI?.client) {
                    cachedChatClient = sn.props.chatConnectionAPI.client;
                    console.log("[Twitch Plus] Found chat client via chatConnectionAPI.");
                    return cachedChatClient;
                }
                fiber = fiber.return;
            }
        }

        return null;
    }

    /**
     * Switch chat identity — matches BTTV's approach exactly.
     * ONLY changes client.configuration.username and sends QUIT.
     * Do NOT touch auth fields (authToken, password, etc.) — the Twitch IRC
     * server ignores PASS when NICK starts with "justinfan".
     * Clearing auth fields causes "PASS <empty>" which the server rejects,
     * creating an infinite reconnect loop.
     */
    function switchChatIdentity(anonymous, retries = 0) {
        const client = findChatServiceClient();
        if (!client) {
            if (retries < 5) {
                const delay = 1000 * (retries + 1);
                console.log(`[Twitch Plus] Chat client not found, retrying in ${delay}ms (attempt ${retries + 1}/5)...`);
                setTimeout(() => switchChatIdentity(anonymous, retries + 1), delay);
                return;
            }
            console.warn("[Twitch Plus] Could not find chat service client after retries — using fallback.");
            switchChatIdentityFallback(anonymous);
            return;
        }

        const config = client.configuration;
        if (!config) {
            console.warn("[Twitch Plus] Chat client has no configuration.");
            return;
        }

        // Get the live IRC WebSocket — tpFallbackWS is tracked by our send
        // interceptor and always points to the latest IRC WebSocket.
        const liveWS = (tpFallbackWS && tpFallbackWS.readyState === WebSocket.OPEN)
            ? tpFallbackWS
            : client.connection?.ws;

        if (anonymous) {
            // Save the real username before swapping
            if (config.username && config.username !== "justinfan12345") {
                tpRealUsername = config.username;
            }
            config.username = "justinfan12345";
            console.log("[Twitch Plus] Switched chat to justinfan12345");
            document.dispatchEvent(new CustomEvent("tp-anon-status", {
                detail: { active: true },
            }));
            // Send QUIT to trigger Twitch's auto-reconnect (our WebSocket
            // interceptor will rewrite PASS/NICK/USER to justinfan)
            if (liveWS && liveWS.readyState === WebSocket.OPEN) {
                try { liveWS.send("QUIT"); } catch (_) {}
            }
        } else {
            if (!tpRealUsername) {
                console.warn("[Twitch Plus] No real username saved, cannot rejoin.");
                return;
            }
            config.username = tpRealUsername;
            tpAnonReconnecting = true;
            console.log(`[Twitch Plus] Restored chat to ${tpRealUsername}`);
            document.dispatchEvent(new CustomEvent("tp-anon-status", {
                detail: { active: false },
            }));
            // Close the anonymous IRC WebSocket, then explicitly call the
            // client's reconnect method. Twitch does NOT auto-reconnect after
            // closing an anonymous (justinfan) session, so we must call
            // client.reconnect() directly (discovered via diagnostics).
            if (liveWS && liveWS.readyState === WebSocket.OPEN) {
                liveWS.close();
                console.log("[Twitch Plus] Closed anonymous IRC WebSocket.");
            }

            // Delay to let the close complete, then reconnect. Using 1500ms
            // ensures the WebSocket fully closes before we attempt to reconnect,
            // preventing messages sent during the transition from being lost.
            setTimeout(() => {
                try {
                    if (typeof client.reconnect === "function") {
                        client.reconnect();
                        console.log("[Twitch Plus] Called client.reconnect() — restoring real chat.");
                    } else if (client.connection && typeof client.connection.reconnect === "function") {
                        client.connection.reconnect();
                        console.log("[Twitch Plus] Called client.connection.reconnect() — restoring real chat.");
                    } else if (typeof client.connect === "function") {
                        client.connect();
                        console.log("[Twitch Plus] Called client.connect() — restoring real chat.");
                    } else if (client.connection && typeof client.connection.tryConnect === "function") {
                        client.connection.tryConnect();
                        console.log("[Twitch Plus] Called client.connection.tryConnect() — restoring real chat.");
                    } else {
                        console.error("[Twitch Plus] No reconnect method found — please refresh the page.");
                    }
                } catch (e) {
                    console.error("[Twitch Plus] Reconnect failed:", e);
                }
            }, 1500);
        }

        // Invalidate cached client so next call re-discovers fresh state
        cachedChatClient = null;
    }

    /**
     * Fallback approach when we can't find the chat client via React fiber.
     * Capture the IRC WebSocket and use PART/JOIN directly.
     * Messages will stop in anon mode, but at least the viewer list is cleared.
     */
    let tpFallbackWS = null;
    let tpFallbackChannel = null;

    // Monkey-patch WebSocket to capture the IRC connection (fallback only)
    const OriginalWebSocket = window.WebSocket;
    const origWSSend = OriginalWebSocket.prototype.send;

    OriginalWebSocket.prototype.send = function (data) {
        if (typeof data === "string") {
            // Track the IRC WebSocket and current channel
            if (this._tpIsIRC || (this.url && this.url.includes("irc-ws.chat.twitch.tv"))) {
                if (!this._tpIsIRC) {
                    console.log("[Twitch Plus] New IRC WebSocket detected (first send).");
                }
                this._tpIsIRC = true;
                tpFallbackWS = this;
                const joinMatch = data.match(/^JOIN\s+#(\S+)/i);
                if (joinMatch) {
                    tpFallbackChannel = joinMatch[1];
                }
            }

            // Save real credentials when NOT in anon mode (for manual reconnect)
            if (this._tpIsIRC && !tpAnonChat) {
                const authCmd = data.split(" ")[0].toUpperCase();
                if (authCmd === "PASS") {
                    tpRealPass = data;
                    console.log("[Twitch Plus] IRC auth: PASS <saved>");
                } else if (authCmd === "NICK") {
                    const nick = data.split(" ")[1];
                    if (nick && nick !== "justinfan12345") tpRealNick = nick;
                    console.log("[Twitch Plus] IRC auth: NICK", nick);
                } else if (authCmd === "JOIN") {
                    console.log("[Twitch Plus] IRC auth:", data.substring(0, 80));
                    // Reconnect after leaving anon mode is complete
                    if (tpAnonReconnecting) {
                        tpAnonReconnecting = false;
                        console.log("[Twitch Plus] Anon reconnect complete — real identity joined channel.");
                        document.dispatchEvent(new CustomEvent("tp-anon-rejoined"));
                    }
                }
            }

            // Anonymous mode — rewrite IRC handshake commands at the WebSocket level.
            // This is bulletproof: no matter what Twitch's internal client reads from
            // (config, closures, session objects), the actual bytes on the wire will
            // use the justinfan identity. The server ignores PASS for justinfan nicks.
            if (tpAnonChat && this._tpIsIRC) {
                const cmd = data.split(" ")[0].toUpperCase();

                // Rewrite PASS to the justinfan convention (server ignores it)
                if (cmd === "PASS") {
                    console.log("[Twitch Plus] IRC rewrite: PASS → SCHMOOPIIE (anon)");
                    return origWSSend.call(this, "PASS SCHMOOPIIE");
                }

                // Rewrite NICK to justinfan12345
                if (cmd === "NICK") {
                    console.log("[Twitch Plus] IRC rewrite: NICK → justinfan12345 (anon)");
                    return origWSSend.call(this, "NICK justinfan12345");
                }

                // Rewrite USER to justinfan12345
                if (cmd === "USER") {
                    console.log("[Twitch Plus] IRC rewrite: USER → justinfan12345 (anon)");
                    return origWSSend.call(this, "USER justinfan12345 8 * :justinfan12345");
                }

                // Block PRIVMSG (safety net)
                if (cmd === "PRIVMSG") {
                    console.log("[Twitch Plus] Blocked PRIVMSG (anon mode)");
                    document.dispatchEvent(new CustomEvent("tp-anon-msg-blocked"));
                    return;
                }

                // Log other commands (skip PING/PONG noise)
                if (cmd !== "PONG" && cmd !== "PING") {
                    console.log("[Twitch Plus] IRC send (anon):", data.substring(0, 120));
                }
            }
        }
        return origWSSend.call(this, data);
    };

    // Preserve WebSocket constructor for Twitch's other uses
    const origWSConstructor = window.WebSocket;

    function switchChatIdentityFallback(anonymous) {
        if (!tpFallbackWS || tpFallbackWS.readyState !== WebSocket.OPEN) {
            console.warn("[Twitch Plus] No fallback IRC WebSocket available.");
            return;
        }
        if (anonymous && tpFallbackChannel) {
            origWSSend.call(tpFallbackWS, `PART #${tpFallbackChannel}`);
            console.log(`[Twitch Plus] Fallback: PART #${tpFallbackChannel}`);
        } else if (!anonymous && tpFallbackChannel) {
            origWSSend.call(tpFallbackWS, `JOIN #${tpFallbackChannel}`);
            console.log(`[Twitch Plus] Fallback: JOIN #${tpFallbackChannel}`);
        }
    }

    // Listen for anon mode toggle from content script
    document.addEventListener("tp-anon-chat", (e) => {
        const { enabled } = e.detail || {};
        tpAnonChat = !!enabled;
        console.log(`[Twitch Plus] Anonymous chat mode: ${tpAnonChat ? "ON" : "OFF"}`);
        switchChatIdentity(tpAnonChat);
    });

    console.log("[Twitch Plus] Page-world script loaded.");
})();
