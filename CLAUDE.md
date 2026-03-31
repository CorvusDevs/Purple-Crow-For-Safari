# Project Guidelines — Twitch Plus For Safari

## Project Overview
Safari Web Extension for macOS/iOS. The extension code lives in `Shared (Extension)/Resources/` (manifest.json, background.js, content.js, popup). The native app targets are thin wrappers that host the extension.

## Error Handling & Empty States

- **Always handle errors gracefully and visually.** Never let a failed permission check, missing resource, or unexpected state result in a frozen UI or silent failure. Show the user a clear, friendly message with guidance on how to resolve it.

- **Failures should be shown gracefully, not hidden.** Use visible error states with short messages and actionable guidance. Avoid swallowing errors silently.

- **Never allow silent failures on user-initiated actions.** Any action the user triggers must handle errors visibly. On failure: roll back any optimistic UI update and show a visible error message.

## Localization

- **Localize every user-facing string.** Use `_locales/` message files for extension UI and `String(localized:)` for any Swift code. Never use bare string literals in user-facing contexts.

- **All text-matching fixes must be multi-language.** When modifying, replacing, or removing text strings from third-party UI (e.g. Twitch's native buttons, labels, or menus), never match against a single language. The user's browser locale may be any language. Use locale-agnostic patterns (regex with character classes for accented variants like `versi[oó]n`, semantic selectors, or DOM structure) instead of hardcoded English strings.

## Screenshots & Image Attachments

- **macOS screenshot filenames contain Unicode non-breaking spaces** (narrow no-break space `U+202F` and no-break space `U+00A0`) that cause the `Read` tool to fail with "File does not exist". Never attempt to read the path directly. Instead, always use this pattern:
  ```
  Bash: cp "/path/to/Attachments/"*.png /tmp/screenshot.png
  Read: /tmp/screenshot.png
  ```
  Use a glob (`*.png`) to copy to `/tmp`, then read from there. This must be the first and only approach — do not attempt `Read` on the original path.

## Workflow

- **Never assume the user hasn't rebuilt.** When the user reports a bug, they have already rebuilt and rerun the app. Never suggest "try rebuilding" or blame stale builds. The error is real — investigate the actual root cause immediately.

- **CRITICAL: Never delete or remove features, code paths, views, or significant functionality without the user explicitly telling you to or approving a suggestion to do so.** When a feature is broken or non-functional, the default action is ALWAYS to fix it — never to remove it. Even if a fix seems impossible (e.g. a platform limitation), propose a workaround and ask the user before removing anything.

- **Read all related files before making changes.** When fixing a system, read the full chain of related files. Understanding the complete data flow prevents fixes that break something downstream.

## Verification

- **Build after changes.** After modifying code, always run `BuildProject` to verify zero compilation errors.

- **Check code issues for fast feedback.** When making changes to a single Swift file, use `XcodeRefreshCodeIssuesInFile` for rapid validation before doing a full build. This catches type errors, missing imports, and API misuse in seconds.

## Debugging

- **Use Safari Web Inspector for debugging.** Background script: Safari > Develop > Web Extension Background Pages. Content script: Safari > Develop > [page]. Popup: click extension icon, then right-click > Inspect Element.

- **Add debug logging when a problem persists.** When a bug is reported and the root cause isn't immediately clear, add targeted `console.log()` / `console.error()` calls to the relevant code path before attempting a fix.

- **Keep debug logging during active development.** Do not proactively remove debug tools or logging after fixing a bug. Only remove them in two cases: (1) the user says the project is finishing up and you suggest cleanup, or (2) the code being debugged was removed, fundamentally changed, or became dead code — making the logging obsolete.

- **CRITICAL: Never remove debug, profiling, or logging features without explicit user approval.** Debug infrastructure (profiling tools, performance reporters, console.log/warn/error statements, debug flags) must never be deleted or disabled without first asking the user for confirmation. These tools are essential for diagnosing future issues. You may propose cleanup, but must wait for approval before acting.

## Commits

- **Always update the changelog when committing.** Every commit message should follow the pattern `vX.Y.Z — Summary` and include a bulleted list of what changed. Also update `CHANGELOG.md` at the project root with the same version entry so there is a single file tracking all releases.
- **Update the changelog for significant commits.** When a commit includes new features, major bug fixes, or architectural changes, add an entry to `CHANGELOG.md`. Small tweaks (typos, formatting) don't need a changelog entry.
- **Never include Claude attribution in commits.** Do not add "Co-Authored-By: Claude" or any Claude/AI attribution to commit messages. Do not add Claude as a contributor on any GitHub repository. All commits should appear as solely authored by the user.
