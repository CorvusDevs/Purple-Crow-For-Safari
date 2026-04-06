/**
 * Twitch Plus — Popup Script
 *
 * Lightweight bridge: the "Open Settings" button sends a message directly
 * to the active Twitch tab's content script to open the in-page settings panel.
 */
(function () {
    "use strict";

    async function openSettingsPanel() {
        const status = document.getElementById("status");
        const btn = document.getElementById("open-settings");

        try {
            // Strategy 1: send directly to the active tab (most reliable in Safari)
            const tabs = await browser.tabs.query({ active: true, currentWindow: true });
            const twitchTab = tabs.find(t => t.url && t.url.includes("twitch.tv"));

            if (twitchTab) {
                console.log("[Twitch Plus Popup] Sending openSettingsPanel directly to tab:", twitchTab.id);
                try {
                    await browser.tabs.sendMessage(twitchTab.id, { action: "openSettingsPanel" });
                    window.close();
                    return;
                } catch (directErr) {
                    console.warn("[Twitch Plus Popup] Direct tab message failed:", directErr);
                }
            }

            // Strategy 2: relay through background script
            console.log("[Twitch Plus Popup] Falling back to background relay...");
            const response = await browser.runtime.sendMessage({ action: "openSettingsPanel" });

            if (response && response.opened) {
                window.close();
                return;
            }

            if (status) {
                status.textContent = response?.error || t("popup_navigate");
            }
            if (btn) {
                btn.disabled = true;
            }
        } catch (e) {
            console.error("[Twitch Plus Popup] Failed to open settings panel:", e);
            if (status) {
                status.textContent = t("popup_navigate");
            }
            if (btn) {
                btn.disabled = true;
            }
        }
    }

    document.addEventListener("DOMContentLoaded", async () => {
        // Load language setting and set locale
        try {
            const resp = await browser.runtime.sendMessage({ action: "getSettings" });
            if (resp && resp.settings) {
                tpSetLocale(resp.settings.language || "auto");
            }
        } catch (e) {
            tpSetLocale("auto");
        }

        // Localize popup text
        const titleEl = document.querySelector("h1");
        if (titleEl) titleEl.textContent = t("popup_title");

        const btn = document.getElementById("open-settings");
        if (btn) {
            // Set localized button text (remove any stale text nodes first)
            [...btn.childNodes].forEach(n => {
                if (n.nodeType === Node.TEXT_NODE) n.remove();
            });
            btn.appendChild(document.createTextNode(" " + t("popup_open_settings")));
            btn.addEventListener("click", () => openSettingsPanel());
        }
    });
})();
