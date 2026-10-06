# Changelog

## 0.2.1

- Consolidate controls into the VS Code titlebar and overflow menu; remove the duplicate toolbar and server-port display.
- Give activity, connection setup, and hook review clear user-facing labels and guidance.
- Name each Clawd hook in Codex's review dialog, distinguish observed native events from log fallback, and explain disabled-hook settings.
- Make Resume restore earlier disabled connections and expose accurate startup/failure status.
- Keep notification preferences usable while paused and remove duplicated permission-card details.
- Rebuild Neobjuk poses from shared reference proportions, raised shoulders, and attached limb animation pivots.
- Add Neobjuk's shy/kiss clicks, rainbow and tilted-heart repeat clicks, annoyed reaction, excited drag, idle eye tracking, and six-second previews for all 17 reference poses.
- Replace the README's artwork grids with installed VS Code screenshots and demos of Neobjuk interactions and native Codex activity.

## 0.2.0

- Add Neobjuk (넙죽이) as the third character, with reference-based poses and animated states.
- Add animation previews and reduced-motion/hidden-view handling; fix asset switching and session-specific terminal focus.
- Add native Codex lifecycle and permission hooks without bypassing Codex hook trust.
- Migrate Claude permission hooks to a dynamically routed command bridge and gate recent events by CLI version.
- Remove inferred Codex approvals; preserve bounded log fallback and PID/session metadata.
- Track parallel subagents and correlate approvals with their requests.
- Isolate runtime discovery per VS Code window/workspace and await server readiness.
- Return unattended approval requests to the native agent when Clawd is hidden, paused, or disconnected.
- Make integration installation explicit and provider-specific; add diagnostics and workspace-trust checks.
- Add regression coverage, complete JavaScript syntax checking, cross-platform CI, and an isolated debug launch configuration.
