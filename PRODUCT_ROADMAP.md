# Loqii Product Roadmap

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

## Beta Blockers

- Manual verification of Google OAuth callback on a clean Windows machine.
- Live Decart start/stop/reconnect QA with real camera and mic devices.
- Confirm feature flag values from Tzurah-AI match the new Loqii app flag names.
- Verify onboarding can be disabled/enabled for dev accounts from admin.
- Package test build and validate no `.env` or service credentials are included.

## Production Blockers

- Code signing for Windows installer.
- Release channel feed configured for beta and stable.
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
