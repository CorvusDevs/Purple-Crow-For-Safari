/**
 * Twitch Plus — Popup Script
 *
 * Manages the popup UI toggles and persists settings via the background script.
 */
(function () {
    "use strict";

    // Map of toggle IDs to setting keys
    const TOGGLES = {
        "toggle-enabled": "enabled",
        // Emote Providers
        "toggle-bttv": "bttvEmotes",
        "toggle-ffz": "ffzEmotes",
        "toggle-7tv": "sevenTvEmotes",
        "toggle-7tv-eventapi": "sevenTvEventApi",
        "toggle-7tv-cosmetics": "sevenTvCosmetics",
        // Chat Appearance
        "toggle-timestamps": "chatTimestamps",
        "toggle-split": "splitChat",
        "toggle-usercolors": "alternatingUsers",
        "toggle-readable-colors": "readableColors",
        "toggle-first-chatter": "firstTimeChatterHighlight",
        "toggle-spoilers": "spoilerHiding",
        // Chat Behavior
        "toggle-mentions": "mentionHighlights",
        "toggle-deleted": "showDeletedMessages",
        "toggle-tab-completion": "emoteTabCompletion",
        "toggle-lurk": "lurkMode",
        // Player
        "toggle-compressor": "audioCompressor",
        "toggle-auto-theater": "autoTheaterMode",
        "toggle-theater-oled": "theaterOledBlack",
        "toggle-theater-transparent": "theaterTransparentChat",
        "toggle-autoplay": "disableAutoplay",
        // Automation
        "toggle-autoclaim": "autoClaimPoints",
        "toggle-autoclaim-drops": "autoClaimDrops",
        "toggle-autoclaim-moments": "autoClaimMoments",
        // Moderation
        "toggle-mod-tools": "modToolsEnabled",
        // Interface
        "toggle-hide-clutter": "hideClutter",
    };

    let currentSettings = {};

    // Load settings from background and update toggles
    async function loadSettings() {
        try {
            const response = await browser.runtime.sendMessage({ action: "getSettings" });
            if (response && response.settings) {
                currentSettings = response.settings;
                updateToggles();
            }
        } catch (e) {
            console.error("[Twitch Plus Popup] Failed to load settings:", e);
        }
    }

    function updateToggles() {
        for (const [id, key] of Object.entries(TOGGLES)) {
            const el = document.getElementById(id);
            if (el) {
                el.checked = !!currentSettings[key];
            }
        }
        updateDisabledState();
    }

    function updateDisabledState() {
        const enabled = currentSettings.enabled !== false;
        // Disable all toggles except the master toggle when extension is disabled
        for (const [id] of Object.entries(TOGGLES)) {
            if (id === "toggle-enabled") continue;
            const row = document.getElementById(id)?.closest(".toggle-row");
            if (row) {
                row.style.opacity = enabled ? "1" : "0.4";
                row.style.pointerEvents = enabled ? "auto" : "none";
            }
        }
    }

    // Save settings
    async function saveSettings() {
        try {
            await browser.runtime.sendMessage({
                action: "updateSettings",
                settings: currentSettings,
            });
            // Notify content scripts of the change
            const tabs = await browser.tabs.query({ url: "*://*.twitch.tv/*" });
            for (const tab of tabs) {
                browser.tabs.sendMessage(tab.id, {
                    action: "settingsUpdated",
                    settings: currentSettings,
                }).catch(() => {});
            }
        } catch (e) {
            console.error("[Twitch Plus Popup] Failed to save settings:", e);
        }
    }

    // Attach listeners to all toggles
    function attachListeners() {
        for (const [id, key] of Object.entries(TOGGLES)) {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener("change", () => {
                    currentSettings[key] = el.checked;
                    if (key === "enabled") {
                        updateDisabledState();
                    }
                    saveSettings();
                });
            }
        }
    }

    // Init
    document.addEventListener("DOMContentLoaded", () => {
        attachListeners();
        loadSettings();
    });
})();
