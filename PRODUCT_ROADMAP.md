# Loqii Product Roadmap

## Coding Engine Requirement

Every non-trivial Loqii change starts by reading `AGENT.md`, `BRAIN.md`, `COMPONENTS.md`, `PRODUCT_ROADMAP.md`, and `RELEASE_PLAN.md`.

The product roadmap must not become a scratchpad. Add only durable product, release, diagnostics, or safety decisions that affect future work.

## Current Stable Runtime Baseline

The current stable runtime baseline is documented in `CHECKPOINT_RUNTIME_STABLE_2026_05_29.md`.

Future product work must not regress the confirmed bootstrap/public config path, Decart client-token flow, dev/prod routing, identity handoff order, authoritative session registration, start/stop/restart recovery, billing sync/deduct behavior, or repo separation.

## Completed Systems

- Split repositories: Loqii app source is separate from Tzurah-AI server/admin deploy.
- Stable desktop shell with fixed toolbar, preview panels, identities, console, prompt workspace, and action bar.
- Central session state modules for guarded start/stop/record/reconnect states.
- Scene, style, prompt composition, performance, reconnect, and error-boundary Lego modules.
- Decart production/dev routing remains owned by backend and exposed to the app only as non-secret metadata.
- Local scene/style controls are bounded and do not resize the shell.

## Phase 8B UX Control Plane

- Reusable modal, drawer, toast, theme, and help modules.
- Advanced diagnostics moved out of the prompt panel into a bounded drawer.
- Help Center added as a bounded drawer.
- Google OAuth moved to system-browser deep-link flow to avoid duplicate app windows.
- App feature flags are normalized client-side with safe defaults.

## Phase 8C Stabilization

- Settings is split into user mode and Developer diagnostics.
- User mode shows only product settings: theme, app/account summary, camera/layout/OBS, audio routing, AI intensity/scene/style behavior, and Help.
- Developer diagnostics are hidden by default and require `enable_dev_tools`, `enable_advanced_diagnostics`, or explicit local dev mode.
- Live metrics must be honest: no static CR/S, no estimated usage presented as real usage, and no debug counters outside Developer.
- Account remains one drawer with Add Credits, Sync Credits, Sign Out, and purchase history.
- Alerts and shared modals inherit the active theme and use semantic alert/theme tokens.

## Coding Engine Roadmap

- Keep `AGENT.md`, `BRAIN.md`, `COMPONENTS.md`, `PRODUCT_ROADMAP.md`, and `RELEASE_PLAN.md` current as the app architecture changes.
- Add lightweight CI checks for native dialog usage, mojibake, debug leakage, and sync whitelist drift.
- Add a release checklist item that verifies every feature/debug panel is flag-gated and hidden by default.
- Keep repo-boundary documentation in both Loqii and Tzurah-AI so app and server work cannot drift into each other accidentally.

## Settings Maturity Roadmap

- Persist user settings for selected devices, layout, AI intensity, scene/style defaults, and help preferences.
- Add first-run camera/audio checks before starting a session.
- Add accessible keyboard focus loops and screen-reader labels for all settings controls.
- Keep settings sections stable and user-facing; experimental controls must ship inside Developer only.

## Dev Diagnostics Roadmap

- Centralize prompt snapshots, Decart metadata, reconnect state, RTT, and performance samples in a diagnostics store.
- Add an exportable diagnostics bundle for support and QA without exposing secrets.
- Add per-flag visibility tests so debug sections cannot regress into user mode.
- Keep backend Decart routing authoritative; renderer diagnostics may display only non-secret routing metadata.

## Feature Flag Control Plane Requirement

- Debug and experimental app UI must be controlled by explicit flags.
- Safe fallback is closed: if a flag is missing or fetch fails, user mode hides diagnostics.
- Required diagnostic flags: `enable_dev_tools`, `enable_advanced_diagnostics`, `enable_performance_metrics`, `enable_prompt_debug`, and `enable_session_debug`.
- Admin/server flags and app fallback names must stay documented together before beta release.

Status: Phase 8D adds the admin-owned app flag control plane and Loqii resolved-flag consumption. Remaining beta work is manual QA of each flag path with normal, dev-account, and allowlisted users.

## Beta Blockers

- Manual verification of Google OAuth callback on a clean Windows machine.
- Live Decart start/stop/reconnect QA with real camera and mic devices.
- Confirm feature flag values from Tzurah-AI match the new Loqii app flag names.
- Verify onboarding can be disabled/enabled for dev accounts from admin.
- Package test build and validate no `.env` or service credentials are included.

## Production Blockers

- Code signing for Windows installer.
- Release channel feed configured for beta and stable.
- Production environment inventory verified for app and server required config.
- Final billing reconciliation health check before public distribution.
- Accessibility pass for modals, drawers, and keyboard focus loops.
- Full update/rollback drill using GitHub Releases.

## Next UX Priorities

- Workspace save/restore: scene, style, prompt, identity slot, and audio/video device preset.
- Guided camera/audio checks before first session.
- Prompt history and favorites drawer with local search.
- OBS quick-check panel that verifies the browser source is receiving frames.
- User-facing Decart environment proof in Developer diagnostics.

## Monetization Opportunities

- Creator credit packs tuned by typical session length.
- Pro tier with saved workspaces, prompt history, and advanced OBS tools.
- Team/dev account mode for agencies and production studios.
- Premium scene/style packs once the local preset system is stable.

## Creator Workflow Ideas

- Quick mode recipes: VTuber, TikTok beauty, podcast host, product demo, avatar guest.
- Scene hotkeys and stream-deck-friendly local commands.
- Before/after capture for thumbnail creation.
- Low-latency mode versus quality mode toggle.
- Session health recap after stop: credits, FPS, reconnects, latency, scene/style used.
