# Reference Roadmap - 2026-08-24

Outcome: Adopt reliable improvements found in current 7TV, BTTV, FFZ, Kick, and uKick references.
Scope: Strict host validation, Kick keyword-hide parity, local muted-content feasibility, Kick quality feasibility, and 7TV coexistence.
Excluded: Screenshots, release metadata, App Store actions, remote blocklists, danmaku, external store links, broadcaster Ads APIs, and volume boost.
Authority: Local source, tests, documentation, build, and non-disruptive Safari extension reinstall are approved. Publishing and submission are not.
Evidence: Exact-host unit coverage, keyword-filter unit coverage, syntax checks, project test suite, signed Release build, installed artifact hash, and live build stamp.
Stop condition: Do not implement a host-dependent feature until its current gap, contract, and DOM shape have direct receipts.
Tool route: Local references, Safari probe in task-owned tabs only, WebKit source, Node tests, Xcode build, then in-place app replacement without restarting Safari.
Model effort: Medium.
Risks: Host DOM drift, virtualized feeds, cross-origin media routing, cached Safari content scripts, and Twitch/Kick parity drift.
First checkpoint: Ship strict URL recognition and Kick keyword hiding from validated chat payloads before virtualized rows are created.

## Priorities

1. Replace substring URL checks with parsed, exact hostname validation for Twitch and Kick.
2. Make hidden keyword filtering work on Kick using the existing chat-row text extraction.
3. Extend the existing local unwanted-content list to mute channels, categories, and tags on both browsing surfaces after structural probes pass.
4. Probe a stable Kick player quality contract before extending preferred quality.
5. Audit chat enhancements when the official 7TV extension replaces Twitch chat markup.

## Volume boost decision

Safari implements `AudioContext`, `createMediaElementSource`, and `GainNode`, so amplification is technically possible. WebKit intentionally outputs silence when a media element taints the document origin, and streaming sites can change their media pipeline at any time. Purple Crow will not add volume boost without a stable, cross-platform live contract and a clear clipping-safe user experience.

## Correctness audit receipts

- Browse observers rebind after SPA navigation, stop outside browse surfaces, and remain dormant when the muted list is empty.
- Muted-link matching rejects cross-platform and non-HTTP links, and malformed percent encoding cannot abort a filtering pass.
- Kick resolves the current viewer using 7TV's authenticated-user contract. Keyword suppression fails closed until identity is known and never hides the viewer's own sender ID.
- Twitch and Kick debug envelopes identify their current source build rather than carrying stale diagnostic labels.
