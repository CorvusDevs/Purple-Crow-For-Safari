/**
 * Twitch Plus — Background Script
 *
 * Handles:
 *  - Fetching emotes from BTTV, FFZ, and 7TV APIs
 *  - Caching emote data in browser.storage.local
 *  - Managing settings
 *  - Responding to content script messages
 */

// ---------------------------------------------------------------------------
// Default settings
// ---------------------------------------------------------------------------
const DEFAULT_SETTINGS = {
    enabled: true,
    // Emote providers
    bttvEmotes: true,
    ffzEmotes: true,
    sevenTvEmotes: true,
    sevenTvEventApi: true,
    sevenTvCosmetics: true,
    // Chat appearance
    chatTimestamps: false,
    showDeletedMessages: true,
    mentionHighlights: true,
    splitChat: false,
    alternatingUsers: false,
    firstTimeChatterHighlight: true,
    spoilerHiding: true,
    chatFontFamily: "",
    chatFontSize: 0,
    // Chat behavior
    highlightKeywords: [],
    hiddenKeywords: [],
    customNicknames: {},
    emoteTabCompletion: true,
    lurkMode: false,
    // Player
    audioCompressor: false,
    autoTheaterMode: false,
    theaterOledBlack: false,
    theaterTransparentChat: false,
    autoQuality: "",
    disableAutoplay: false,
    // Automation
    autoClaimPoints: false,
    autoClaimDrops: false,
    autoClaimMoments: false,
    // Moderation
    modToolsEnabled: false,
    customTimeouts: [60, 600, 3600],
    // UI
    hideClutter: false,
    // Profiles
    channelProfiles: {},
    readableColors: false,
};

let settings = { ...DEFAULT_SETTINGS };

// Cache for emote data: channelId -> { bttv, ffz, sevenTv, timestamp }
const emoteCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Global emotes (fetched once per session)
let globalEmotes = null;
let globalEmotesFetching = false;

// ---------------------------------------------------------------------------
// Settings management
// ---------------------------------------------------------------------------
async function loadSettings() {
    try {
        const result = await browser.storage.local.get("settings");
        if (result.settings) {
            settings = { ...DEFAULT_SETTINGS, ...result.settings };
        }
    } catch (e) {
        console.error("[Twitch Plus] Failed to load settings:", e);
    }
}

async function saveSettings(newSettings) {
    settings = { ...DEFAULT_SETTINGS, ...newSettings };
    await browser.storage.local.set({ settings });
}

// ---------------------------------------------------------------------------
// API fetchers
// ---------------------------------------------------------------------------

/**
 * Fetch with error handling and timeout.
 */
async function safeFetch(url, timeoutMs = 8000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const resp = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return await resp.json();
    } catch (e) {
        clearTimeout(timer);
        console.warn(`[Twitch Plus] Fetch failed: ${url}`, e.message);
        return null;
    }
}

// --- BTTV ---

async function fetchBttvGlobal() {
    const data = await safeFetch("https://api.betterttv.net/3/cached/emotes/global");
    if (!data) return [];
    return data.map((e) => ({
        id: e.id,
        name: e.code,
        url1x: `https://cdn.betterttv.net/emote/${e.id}/1x`,
        url2x: `https://cdn.betterttv.net/emote/${e.id}/2x`,
        url4x: `https://cdn.betterttv.net/emote/${e.id}/3x`,
        animated: e.animated || e.imageType === "gif",
        source: "bttv",
        zeroWidth: false,
    }));
}

async function fetchBttvChannel(channelId) {
    const data = await safeFetch(`https://api.betterttv.net/3/cached/users/twitch/${channelId}`);
    if (!data) return [];
    const all = [...(data.channelEmotes || []), ...(data.sharedEmotes || [])];
    return all.map((e) => ({
        id: e.id,
        name: e.code,
        url1x: `https://cdn.betterttv.net/emote/${e.id}/1x`,
        url2x: `https://cdn.betterttv.net/emote/${e.id}/2x`,
        url4x: `https://cdn.betterttv.net/emote/${e.id}/3x`,
        animated: e.animated || e.imageType === "gif",
        source: "bttv",
        zeroWidth: false,
    }));
}

// --- FFZ ---

async function fetchFfzGlobal() {
    const data = await safeFetch("https://api.frankerfacez.com/v1/set/global");
    if (!data || !data.sets) return [];
    const emotes = [];
    for (const setId of data.default_sets || []) {
        const set = data.sets[String(setId)];
        if (!set || !set.emoticons) continue;
        for (const e of set.emoticons) {
            emotes.push({
                id: e.id,
                name: e.name,
                url1x: `https://cdn.frankerfacez.com/emote/${e.id}/1`,
                url2x: `https://cdn.frankerfacez.com/emote/${e.id}/2`,
                url4x: `https://cdn.frankerfacez.com/emote/${e.id}/4`,
                animated: !!e.animated,
                source: "ffz",
                zeroWidth: false,
            });
        }
    }
    return emotes;
}

async function fetchFfzChannel(channelId) {
    const data = await safeFetch(`https://api.frankerfacez.com/v1/room/id/${channelId}`);
    if (!data || !data.sets) return [];
    const emotes = [];
    for (const set of Object.values(data.sets)) {
        if (!set.emoticons) continue;
        for (const e of set.emoticons) {
            emotes.push({
                id: e.id,
                name: e.name,
                url1x: `https://cdn.frankerfacez.com/emote/${e.id}/1`,
                url2x: `https://cdn.frankerfacez.com/emote/${e.id}/2`,
                url4x: `https://cdn.frankerfacez.com/emote/${e.id}/4`,
                animated: !!e.animated,
                source: "ffz",
                zeroWidth: false,
            });
        }
    }
    return emotes;
}

// --- 7TV ---

async function fetchSevenTvGlobal() {
    const data = await safeFetch("https://7tv.io/v3/emote-sets/global");
    if (!data || !data.emotes) return [];
    return data.emotes.map((e) => mapSevenTvEmote(e));
}

let lastSevenTvEmoteSetId = null;

async function fetchSevenTvChannel(channelId) {
    const data = await safeFetch(`https://7tv.io/v3/users/twitch/${channelId}`);
    if (!data || !data.emote_set || !data.emote_set.emotes) return [];
    // Store emote set ID for EventAPI subscription
    lastSevenTvEmoteSetId = data.emote_set.id || null;
    return data.emote_set.emotes.map((e) => mapSevenTvEmote(e));
}

function mapSevenTvEmote(e) {
    const emoteData = e.data || e;
    const host = emoteData.host || {};
    const baseUrl = host.url || "";
    // Pick webp files
    const files = host.files || [];
    const get = (name) => {
        const f = files.find((x) => x.name === name);
        return f ? `https:${baseUrl}/${f.name}` : null;
    };
    return {
        id: emoteData.id || e.id,
        name: e.name || emoteData.name,
        url1x: get("1x.webp") || get("1x.avif") || `https:${baseUrl}/1x.webp`,
        url2x: get("2x.webp") || get("2x.avif") || `https:${baseUrl}/2x.webp`,
        url4x: get("4x.webp") || get("4x.avif") || `https:${baseUrl}/4x.webp`,
        animated: !!emoteData.animated,
        source: "7tv",
        // 7TV zero-width flag: flags & 1
        zeroWidth: !!((emoteData.flags || 0) & 1),
    };
}

// ---------------------------------------------------------------------------
// Fetch all global emotes (once per session)
// ---------------------------------------------------------------------------
async function fetchGlobalEmotes() {
    if (globalEmotes) return globalEmotes;
    if (globalEmotesFetching) {
        // Wait for the in-flight fetch
        return new Promise((resolve) => {
            const check = setInterval(() => {
                if (globalEmotes) {
                    clearInterval(check);
                    resolve(globalEmotes);
                }
            }, 200);
        });
    }
    globalEmotesFetching = true;

    const [bttv, ffz, sevenTv] = await Promise.all([
        settings.bttvEmotes ? fetchBttvGlobal() : [],
        settings.ffzEmotes ? fetchFfzGlobal() : [],
        settings.sevenTvEmotes ? fetchSevenTvGlobal() : [],
    ]);

    globalEmotes = { bttv, ffz, sevenTv };
    globalEmotesFetching = false;
    console.log(
        `[Twitch Plus] Global emotes loaded: BTTV=${bttv.length}, FFZ=${ffz.length}, 7TV=${sevenTv.length}`
    );
    return globalEmotes;
}

// ---------------------------------------------------------------------------
// Fetch channel emotes (cached per channel)
// ---------------------------------------------------------------------------
async function fetchChannelEmotes(channelId) {
    if (!channelId) return { bttv: [], ffz: [], sevenTv: [] };

    const cached = emoteCache.get(channelId);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return cached;
    }

    const [bttv, ffz, sevenTv] = await Promise.all([
        settings.bttvEmotes ? fetchBttvChannel(channelId) : [],
        settings.ffzEmotes ? fetchFfzChannel(channelId) : [],
        settings.sevenTvEmotes ? fetchSevenTvChannel(channelId) : [],
    ]);

    const result = { bttv, ffz, sevenTv, timestamp: Date.now() };
    emoteCache.set(channelId, result);
    console.log(
        `[Twitch Plus] Channel ${channelId} emotes loaded: BTTV=${bttv.length}, FFZ=${ffz.length}, 7TV=${sevenTv.length}`
    );
    return result;
}

// ---------------------------------------------------------------------------
// Build a flat emote map: { name -> emoteData }
// ---------------------------------------------------------------------------
function buildEmoteMap(globalData, channelData) {
    const map = {};

    // Channel emotes take priority over global (added first, overwrite later if needed)
    // Actually, channel should override global, so add global first then channel
    function addEmotes(list) {
        for (const e of list) {
            map[e.name] = e;
        }
    }

    if (globalData) {
        addEmotes(globalData.bttv);
        addEmotes(globalData.ffz);
        addEmotes(globalData.sevenTv);
    }
    if (channelData) {
        addEmotes(channelData.bttv);
        addEmotes(channelData.ffz);
        addEmotes(channelData.sevenTv);
    }

    return map;
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------
browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "getSettings") {
        return Promise.resolve({ settings });
    }

    if (request.action === "updateSettings") {
        return saveSettings(request.settings).then(() => {
            // Invalidate global emote cache so provider toggles take effect
            globalEmotes = null;
            emoteCache.clear();
            return { settings };
        });
    }

    if (request.action === "getEmotes") {
        const channelId = request.channelId;
        return (async () => {
            lastSevenTvEmoteSetId = null;
            const globalData = await fetchGlobalEmotes();
            const channelData = await fetchChannelEmotes(channelId);
            const emoteMap = buildEmoteMap(globalData, channelData);
            return { emoteMap, settings, sevenTvEmoteSetId: lastSevenTvEmoteSetId };
        })();
    }

    if (request.action === "getGlobalEmotes") {
        return fetchGlobalEmotes().then((data) => {
            const map = buildEmoteMap(data, null);
            return { emoteMap: map, settings };
        });
    }

    // --- 7TV EventAPI ---
    if (request.action === "subscribe7tv") {
        const { emoteSetId, channelId } = request;
        subscribe7tv(emoteSetId, channelId);
        return Promise.resolve({ ok: true });
    }

    if (request.action === "unsubscribe7tv") {
        unsubscribe7tv();
        return Promise.resolve({ ok: true });
    }

    // --- 7TV Cosmetics ---
    if (request.action === "get7tvCosmetics") {
        return fetchSevenTvCosmetics(request.twitchUserId);
    }

    // --- Channel Profiles ---
    if (request.action === "getChannelProfile") {
        const channel = request.channel;
        const profile = settings.channelProfiles?.[channel] || null;
        if (profile) {
            const merged = { ...settings, ...profile };
            return Promise.resolve({ settings: merged });
        }
        return Promise.resolve({ settings });
    }

    if (request.action === "saveChannelProfile") {
        const { channel, profileSettings } = request;
        if (!settings.channelProfiles) settings.channelProfiles = {};
        settings.channelProfiles[channel] = profileSettings;
        return saveSettings({ channelProfiles: settings.channelProfiles }).then(() => {
            return { ok: true };
        });
    }

    if (request.action === "deleteChannelProfile") {
        const { channel } = request;
        if (settings.channelProfiles?.[channel]) {
            delete settings.channelProfiles[channel];
            return saveSettings({ channelProfiles: settings.channelProfiles }).then(() => {
                return { ok: true };
            });
        }
        return Promise.resolve({ ok: true });
    }
});

// ---------------------------------------------------------------------------
// 7TV EventAPI WebSocket
// ---------------------------------------------------------------------------

let sevenTvSocket = null;
let sevenTvHeartbeatTimer = null;
let sevenTvReconnectTimer = null;
let currentEmoteSetId = null;
let currentSubscribedChannelId = null;

function connect7tvEventApi() {
    if (sevenTvSocket && sevenTvSocket.readyState <= 1) return; // CONNECTING or OPEN

    try {
        sevenTvSocket = new WebSocket("wss://events.7tv.io/v3");
    } catch (e) {
        console.error("[Twitch Plus] Failed to connect to 7TV EventAPI:", e);
        scheduleReconnect();
        return;
    }

    sevenTvSocket.onopen = () => {
        console.log("[Twitch Plus] 7TV EventAPI connected.");
    };

    sevenTvSocket.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            handle7tvMessage(msg);
        } catch (e) {
            console.warn("[Twitch Plus] Failed to parse 7TV message:", e);
        }
    };

    sevenTvSocket.onclose = () => {
        console.log("[Twitch Plus] 7TV EventAPI disconnected.");
        clearHeartbeat();
        scheduleReconnect();
    };

    sevenTvSocket.onerror = (e) => {
        console.warn("[Twitch Plus] 7TV EventAPI error:", e);
    };
}

function handle7tvMessage(msg) {
    switch (msg.op) {
        case 1: // Hello — server sends heartbeat interval
            const interval = msg.d?.heartbeat_interval || 45000;
            startHeartbeat(interval);
            // Re-subscribe if we have a pending subscription
            if (currentEmoteSetId) {
                sendSubscribe(currentEmoteSetId);
            }
            break;

        case 2: // Heartbeat ACK — nothing to do
            break;

        case 4: // Reconnect
            console.log("[Twitch Plus] 7TV EventAPI requested reconnect.");
            sevenTvSocket?.close();
            break;

        case 5: // Dispatch
            if (msg.d?.type === "emote_set.update") {
                handleEmoteSetUpdate(msg.d.body);
            }
            break;
    }
}

function startHeartbeat(intervalMs) {
    clearHeartbeat();
    sevenTvHeartbeatTimer = setInterval(() => {
        if (sevenTvSocket?.readyState === WebSocket.OPEN) {
            sevenTvSocket.send(JSON.stringify({ op: 2, d: null }));
        }
    }, intervalMs);
}

function clearHeartbeat() {
    if (sevenTvHeartbeatTimer) {
        clearInterval(sevenTvHeartbeatTimer);
        sevenTvHeartbeatTimer = null;
    }
}

function scheduleReconnect() {
    if (sevenTvReconnectTimer) return;
    sevenTvReconnectTimer = setTimeout(() => {
        sevenTvReconnectTimer = null;
        if (currentEmoteSetId) {
            connect7tvEventApi();
        }
    }, 5000);
}

function sendSubscribe(emoteSetId) {
    if (!sevenTvSocket || sevenTvSocket.readyState !== WebSocket.OPEN) return;
    sevenTvSocket.send(JSON.stringify({
        op: 35,
        d: {
            type: "emote_set.update",
            condition: { object_id: emoteSetId },
        },
    }));
    console.log(`[Twitch Plus] Subscribed to 7TV emote set: ${emoteSetId}`);
}

function subscribe7tv(emoteSetId, channelId) {
    if (!settings.sevenTvEventApi) return;

    // Unsubscribe from previous if different
    if (currentEmoteSetId && currentEmoteSetId !== emoteSetId) {
        unsubscribe7tv();
    }

    currentEmoteSetId = emoteSetId;
    currentSubscribedChannelId = channelId;
    connect7tvEventApi();
}

function unsubscribe7tv() {
    currentEmoteSetId = null;
    currentSubscribedChannelId = null;
    if (sevenTvSocket && sevenTvSocket.readyState === WebSocket.OPEN) {
        sevenTvSocket.close();
    }
    clearHeartbeat();
}

async function handleEmoteSetUpdate(body) {
    // body contains pushed/pulled/updated emote arrays
    const pushed = body?.pushed || [];
    const pulled = body?.pulled || [];

    // Build a delta to send to content scripts
    const addedEmotes = [];
    const removedEmoteNames = [];

    for (const entry of pushed) {
        const emote = entry?.value;
        if (emote?.name && emote?.data) {
            const mapped = mapSevenTvEmote(emote);
            if (mapped) addedEmotes.push(mapped);
        }
    }

    for (const entry of pulled) {
        const emote = entry?.old_value;
        if (emote?.name) {
            removedEmoteNames.push(emote.name);
        }
    }

    if (addedEmotes.length > 0 || removedEmoteNames.length > 0) {
        console.log(`[Twitch Plus] 7TV live update: +${addedEmotes.length} -${removedEmoteNames.length}`);

        // Broadcast to all Twitch tabs
        const tabs = await browser.tabs.query({ url: "*://*.twitch.tv/*" });
        for (const tab of tabs) {
            browser.tabs.sendMessage(tab.id, {
                action: "emoteMapUpdate",
                addedEmotes,
                removedEmoteNames,
            }).catch(() => {});
        }
    }
}

// ---------------------------------------------------------------------------
// 7TV Cosmetics Fetcher
// ---------------------------------------------------------------------------

const cosmeticsCache = new Map();
const COSMETICS_TTL = 10 * 60 * 1000; // 10 minutes

async function fetchSevenTvCosmetics(twitchUserId) {
    if (!twitchUserId) return { cosmetics: null };

    // Check cache
    const cached = cosmeticsCache.get(twitchUserId);
    if (cached && Date.now() - cached.timestamp < COSMETICS_TTL) {
        return { cosmetics: cached.data };
    }

    try {
        const data = await safeFetch(`https://7tv.io/v3/users/twitch/${twitchUserId}`);
        if (!data) return { cosmetics: null };

        const cosmetics = {
            paint: null,
            badges: [],
        };

        // Extract paint (username gradient)
        if (data.style?.paint) {
            const paint = data.style.paint;
            if (paint.stops?.length > 0) {
                const gradientStops = paint.stops
                    .map((s) => `#${s.color.toString(16).padStart(6, "0")} ${s.at * 100}%`)
                    .join(", ");
                cosmetics.paint = {
                    gradient: `linear-gradient(${paint.angle || 0}deg, ${gradientStops})`,
                    animated: !!paint.animation,
                };
            }
        }

        // Extract badges
        if (data.style?.badge) {
            const badge = data.style.badge;
            if (badge.host?.files?.length > 0) {
                const baseUrl = `https:${badge.host.url}`;
                const file = badge.host.files.find((f) => f.name === "1x.webp")
                    || badge.host.files[0];
                if (file) {
                    cosmetics.badges.push({
                        name: badge.tooltip || badge.name || "7TV Badge",
                        url: `${baseUrl}/${file.name}`,
                    });
                }
            }
        }

        cosmeticsCache.set(twitchUserId, { data: cosmetics, timestamp: Date.now() });
        return { cosmetics };
    } catch (e) {
        console.warn("[Twitch Plus] Failed to fetch 7TV cosmetics:", e);
        return { cosmetics: null };
    }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
loadSettings().then(() => {
    console.log("[Twitch Plus] Background script loaded. Settings:", settings);
});
