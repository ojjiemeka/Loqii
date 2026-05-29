# Loqii Component Map

Permanent debugging rule: treat every change as a small Lego module. Find the component boundary first, change the smallest isolated surface, then test that surface before moving outward.

## Loqii/Tzurah Coding Engine

Codex must read `AGENT.md`, `BRAIN.md`, `COMPONENTS.md`, `PRODUCT_ROADMAP.md`, and `RELEASE_PLAN.md` before non-trivial edits.

Before code, declare:
- Repo scope: `Loqii only`, `Tzurah-AI only`, or `both repos required`.
- Risk class: `trivial`, `low risk`, `medium risk`, `high risk`, or `dangerous`.
- Topology: affected files, state ownership, data flow, async/timing risks, UI surfaces, API/database boundaries, and blast radius.

Four invariants:
- Where does state live?
- Where does feedback or observability live?
- What breaks if this changes?
- When does timing or order matter?

Stop before coding if repo boundary, state ownership, API contract, database migration, billing impact, auth/session flow, or user intent is unclear.

Permanent agent entry rule: before non-trivial edits, read `AGENT.md`, `BRAIN.md`, `COMPONENTS.md`, `PRODUCT_ROADMAP.md`, and `RELEASE_PLAN.md`.

## Loqii/Tzurah Coding Engine

Topology-first checklist:
- Identify affected files.
- Identify state ownership.
- Identify data flow.
- Identify async/timing risks.
- Identify UI surfaces affected.
- Identify backend/API/database boundaries.
- Identify blast radius.

Four invariants:
- Where does state live?
- Where does feedback or observability live?
- What breaks if this changes?
- When does timing or order matter?

Repo boundary gate:
- `Loqii only`: app UI/UX, Electron, OAuth shell, Decart client/session UX, scenes/styles/prompts, local components.
- `Tzurah-AI only`: backend/admin, billing, protected billing, reconciliation, Decart token routing, feature flags, database/API contracts.
- `Both repos required`: explain the contract reason before editing either side.

Risk classes:
- `trivial`: typo/copy-only, no behavior.
- `low risk`: isolated UI/docs helper with clear owner.
- `medium risk`: shared component, async UI, IPC, feature flags, auth-adjacent.
- `high risk`: session lifecycle, OAuth, Decart routing assumptions, billing-adjacent, release/sync scripts.
- `dangerous`: billing/protected billing/reconciliation/database migration/secrets.

High-risk and dangerous work requires topology notes, rollback plan, explicit tests, and no broad refactor.

## Electron App UI

Location: `index.html`

Responsibility:
- Main user workflow: login state, camera/mic controls, identity slots, prompt presets, Decart streaming, OBS output, recording, announcements, and session summaries.

Key functions:
- Start/stop stream flow: `doStart()`, `doStop()`
- Billing sync metadata: credit sync helpers around session timers
- Alerts: `addBellAlert()`, `showModalAlert()`, `showModalConfirm()`, `showModalPrompt()`
- OBS setup: OBS modal and websocket output helpers
- Florence: auto-describe download/worker helpers

Common failure symptoms:
- Start works once but restart fails
- credits do not update or final sync repeats
- modal overlay blocks controls
- OBS output does not connect
- Florence download stalls

Debug checklist:
- Confirm bootstrap config loaded before UI actions.
- Check current session id and sync sequence.
- Verify `doStop()` completed before a new start.
- Test modal helper alone with `window.showModalAlert("test")`.
- Check console for Decart token or WebRTC lifecycle errors.

### Scene And Background Presets

Location: `index.html`

Responsibility:
- Local built-in scene preset model.
- Scene picker UI state and local persistence.
- Prompt routing that preserves the selected identity while changing only the environment/background.

Key functions:
- `buildDecartScenePrompt(identityPrompt, selectedScenePreset)`
- `applyDecartScenePreset(session, preset)`
- `resetDecartScene(session)`

Debug checklist:
- Select a scene before start and confirm it queues for the next session.
- Start a session and confirm the first `set()` includes the selected scene prompt.
- Apply/reset a scene during an active session without interrupting billing/session timers.
- Confirm `window._lastSceneApplication` includes only non-secret environment metadata.

## Admin Dashboard

Location: `admin.html`

Responsibility:
- Admin overview, users, revenue, purchases, sessions, alerts, email, announcements, packs, IP blocks, sub-admins, tests, flags, settings, audit log, and reconciliation diagnostics.

Key functions:
- Tab routing: `switchTab()`
- API helpers: `api()`, `apiPost()`, `adminFetch()`
- Toasts: `toast()`
- Modal component: `showModal()`, `showModalAlert()`, `showModalConfirm()`, `showModalPrompt()`
- Reconciliation UI: `loadReconciliation()`, `renderReconMetrics()`, `renderReconEvents()`
- Email and announcements builders: `loadEmailTab()`, `loadAnnouncements()`

Common failure symptoms:
- A tab renders blank
- confirmation flow does nothing
- reconciliation counts look stale
- a table loads but actions fail

Debug checklist:
- Parse the inline script before deploy.
- Open the tab directly with `switchTab("tabname")`.
- Check whether `adminFetch()` returns a 401 or non-JSON error.
- Test modal helper alone from the console.
- Keep UI fixes scoped to one tab or shared helper.

## Billing And Session Modules

Locations:
- `gcp-server.js`
- `index.html`
- `electron.js`

Responsibility:
- Credit deduction, sync metadata, session pings, session end, ownership validation, stale watchdog handling, admin kill, and shadow billing RPC logging.

Key backend functions:
- `validateBillingSession()`
- `recordBillingShadowSync()`
- `detectDuplicateSyncId()`
- `/credits/deduct`
- `/credits/sync`
- `/session/ping`
- `/session/end`

Common failure symptoms:
- duplicate billing syncs
- killed or old sessions continue billing
- missing final sync warnings
- negative or impossible credit values

Debug checklist:
- Verify `session_id`, `sync_id`, `sync_sequence`, `source`, and `client_ts`.
- Check `sessions.is_active`, `kill_signal`, `last_ping`, and `last_sync_at`.
- Confirm legacy deduction remains authoritative until live RPC switch is approved.
- Never select `profiles.email`.
- Keep numeric guards: finite, non-negative, capped.

## Reconciliation Modules

Location: `gcp-server.js`, UI in `admin.html`

Responsibility:
- Detect billing anomalies, drift, duplicates, stale sessions, missing final syncs, and resolved/an active event lifecycle.

Key functions:
- `logBillingReconciliationEvent()`
- `resolveReconciliationEvents()`
- `getSessionFinalizationStatus()`
- `detectMissingFinalSync()`
- `autoResolveRecentMissingFinalFalsePositives()`
- `/admin/api/reconciliation/summary`
- `/admin/api/reconciliation/:id/resolve`

Common failure symptoms:
- old resolved issues still counted as active
- false-positive `missing_final_sync`
- dashboard shows stale unhealthy status

Debug checklist:
- Query active and resolved rows separately.
- Check whether resolution migration exists.
- Verify `resolved`, `resolved_at`, `resolved_reason`, `auto_resolved`.
- Confirm summary filter is `active`, `resolved`, or `all`.

## Alert And Modal System

Locations:
- `admin.html`
- `index.html`
- `loqiiModal.js`
- `loqiiDrawer.js`
- `loqiiToast.js`
- `loqiiHelp.js`
- `loqiiTheme.js`

Responsibility:
- Replace native browser dialogs with reusable dark-theme promise-based modals.
- Keep app-side modals, drawers, empty states, loading states, Help, and settings surfaces bounded and theme-safe.

Public API:
- `showModalAlert(message, options)`
- `showModalConfirm(message, options)`
- `showModalPrompt(message, options)`

Behavior:
- Escape cancels cancelable modals.
- Enter confirms unless focus is in a textarea.
- Prompt resolves with a string or `null`.
- Confirm resolves with `true` or `false`.
- Alert resolves when acknowledged.

Common failure symptoms:
- Enter key confirms too early
- modal remains after action
- cancel path does not restore UI

Debug checklist:
- Test the modal API in isolation first.
- Confirm overlay dispatches `modal:closed`.
- Check callbacks are promise-safe.
- Avoid native `alert()`, `confirm()`, and `prompt()`.
- Do not add new one-off modal HTML in `index.html`; extend the Loqii UX component modules instead.

## Loqii App UX Control Plane

Locations:
- `loqiiModal.js`
- `loqiiDrawer.js`
- `loqiiToast.js`
- `loqiiTheme.js`
- `loqiiHelp.js`
- `settingsArchitecture.js`

Responsibility:
- Shared UX primitives for modals, confirms, sheets/drawers, toasts, empty/loading states, Help Center, semantic theme aliases, and settings section scaffolds.
- Feature-gated app surfaces such as Help, advanced diagnostics, onboarding, Google OAuth, mock payments, and developer controls.

Debug checklist:
- Confirm drawers have bounded height and internal scroll.
- Confirm Escape closes cancelable drawers/modals.
- Confirm dark mode text uses semantic tokens rather than hardcoded black text.
- Confirm modal overlay roots receive `theme-light`/`theme-dark` plus Loqii theme classes so header, body, and footer inherit one token set.
- Required onboarding must pass `persistent`, `closeOnBackdrop: false`, and `closeOnEscape: false`; dismissal must come only from explicit Skip/Get Started actions.
- If feature flag fetch fails, experimental features should default off while core login/start/stop remains usable.

### App Feature Flag Consumption

Owner:
- Resolved flag fetch: `server.mjs` `/api/app-config` proxy.
- Runtime state/helpers: `index.html` `refreshFeatureFlags()`, `isFeatureEnabled()`, and `window._featureFlags`.
- Auth screen consumption: `login.html` and `signup.html` read resolved bootstrap flags for Google OAuth.

Rules:
- Loqii consumes resolved booleans from Tzurah-AI; it does not decide allowlist/dev-account membership locally.
- Feature fetch failure fails closed for diagnostics, mock payments, and experimental controls while leaving login/start/stop usable.
- New app features must check `isFeatureEnabled(key)` instead of reading scattered raw flag objects.
- No user-facing debug, prompt/session internals, fake metrics, or test payment paths appear without an explicit resolved flag.

Permanent user/dev mode rules:
- No developer scaffolding is visible in user mode.
- No fake, static, or placeholder metrics are shown as live product data.
- No raw debug text, Decart routing metadata, prompt layers, retry timers, or feature flag snapshots appear outside a Developer section.
- All modals use `LoqiiModal` or `LoqiiConfirm`; all drawers use `LoqiiDrawer`.
- Modal persistence uses shared `LoqiiModal` options: `persistent`, `closeOnBackdrop`, `closeOnEscape`, and `showCloseButton`.
- All new text and surfaces use semantic theme tokens, not hardcoded black/white styling.
- Light and dark mode must be manually checked for every new modal, drawer, alert, and settings section.
- Account remains a single drawer surface; do not add a second account window or nested account modal.
- Add Credits remains the shared themed flow; do not reintroduce standalone Buy Credits modal styling.
- New diagnostics, debug panels, and internal metrics must be feature-flagged and hidden by default.
- User-facing empty states use clear product language such as `No data yet`, `Not available yet`, or `Start a session to view this`; raw `unknown`, `none`, `--`, `null`, and `undefined` are developer-only.

Modal/drawer theme audit:
- Migrated: unified Account drawer, unified Add Credits modal, Settings drawer, Help drawer, top-up fallback window, account dashboard fallback window, dashboard sign-out confirm, native camera/audio selects.
- Already shared: keyboard shortcuts, onboarding, generic alerts/confirms/prompts, mock top-up flow.
- Still legacy but reachable: session summary, admin kill summary, OBS setup, Florence download. These use Loqii palette variables but keep specialized fixed layouts.
- Conditional reachability: admin kill summary requires a server kill signal; Florence download requires the auto-describe flag.

## Server And API Modules

Location: `gcp-server.js`

Responsibility:
- Admin auth/RBAC, Supabase admin access, Decart token proxy, payments, credit packs, email, announcements, settings, tests, and audit logs.

Key helpers:
- `adminAuth`
- `can()`
- `logAction()`
- `getSettingValue()`
- Supabase admin client

Common failure symptoms:
- admin route returns 401
- RBAC action hidden or blocked
- endpoint returns table/column missing
- dashboard action appears successful but no audit entry

Debug checklist:
- Run `node --check gcp-server.js`.
- Check route permission with `can(role, permission)`.
- Use Supabase v2 `{ data, error }` style.
- Log admin actions for mutations.

## Local Decart Token Proxy

Location: `server.mjs`

Responsibility:
- Proxy user-authenticated Decart token requests from Electron to the GCP server.
- Preserve non-secret Decart routing metadata for diagnostics.
- Never store or expose Decart API keys beyond the token response needed by the SDK.
- Validate local proxy runtime config before production boot.
- Fetch public pre-login config from backend `/api/public-config` without privileged secrets.
- Use privileged `/api/bootstrap` with `x-app-secret` only for server-owned startup config that requires trust.
- Normal development startup skips privileged bootstrap unless `LOQII_USE_PRIVILEGED_BOOTSTRAP=true`.
- Fail closed when privileged bootstrap is required and unavailable in production/staging.
- In development, missing or rejected `BOOTSTRAP_SECRET` does not retry-spam; the app uses public config when available, then safe local defaults only as a last resort.

Debug checklist:
- Normal users must continue to receive production Decart routing from GCP.
- Dev/test routing decisions remain owned by `gcp-server.js`.
- Decart realtime uses authenticated short-lived client tokens from `/decart/token` or `/api/decart/client-token`.
- Permanent Decart `dct_...` keys must never be returned by Loqii routes or logged.
- `BOOTSTRAP_SECRET`, `INTERNAL_SECRET`, and `GCP_SERVER_URL` are environment-owned; do not add literal fallback secrets.
- Renderer code consumes `/api/config` and `/api/app-config`; it does not own production config truth.
- Degraded development config must never fake Decart tokens, billing, session ping, or credit sync endpoints.

## Auth Session Ownership

Locations:
- `electron.js`
- `db.js`
- `preload.js`
- `index.html`

Rules:
- Supabase session persistence is owned by Electron main process plus the SQLite cache in `db.js`.
- Renderer pages never own raw access or refresh tokens; they request fresh access tokens through preload IPC only when calling user-authenticated APIs.
- Startup restore is owned by `electron.js:restoreSupabaseSession()` and `showRestoredSessionOrLogin()`.
- Login-vs-main-app routing is owned by Electron window factories in `electron.js`.
- Explicit sign out is owned by `auth:logout`; it calls Supabase sign-out, clears SQLite session cache, rebuilds the login surface, and refreshes tray state.
- Feature flags refresh after restore from renderer `/api/app-config`; balance refresh after restore is triggered from Electron main process.

## Production Config Ownership

Locations:
- `electron.js`
- `server.mjs`

Rules:
- Electron validates app runtime config before starting UI.
- `server.mjs` validates bootstrap/internal secrets and fetched backend config before production listening.
- Missing production config shows a safe user error and exits.
- Detailed config diagnostics are logs-only and must not include secret values.
- Development fallbacks must be explicit, local-only, and never used by packaged production.
- Renderer may read `decart_environment_used` and `decart_reason`, but never receives raw production/dev keys separately.

## Update And Release Plumbing

Location: `RELEASE_PLAN.md`

Responsibility:
- Define dev, beta, and stable release channels before shipping an installer.
- Keep packaging, code signing, GitHub Releases/update feed, and rollback work explicit.
- Prevent product-facing app updates from being mixed into the deploy-only server sync path.

## Sync And Release Boundaries

Source workspace:
- `RTDF-Decart` is the working folder used for local Electron app and server/admin development.
- It is not currently a Git checkout.

Server/admin deploy mirror:
- `../tzurah-server-deploy`
- Git remote: `https://github.com/ojjiemeka/Tzurah-AI.git`
- Sync script: `git-update.sh`
- Purpose: VM/GCP backend and admin dashboard deployment only.
- Must not receive Electron app source files such as `index.html`, `electron.js`, `preload.js`, or `server.mjs`.

Electron app source mirror:
- Expected path: `../loqii-app-source` or `APP_SOURCE_DIR`.
- Git remote: `https://github.com/ojjiemeka/Loqii.git`
- Optional first-time clone source: `APP_REPO_URL`.
- Sync script: `git-update-app.sh`
- Purpose: app source control, beta packaging, and future installer/update releases.
- Must not receive `.env`, `.env.production`, `node_modules`, logs, local cache, or packaged build artifacts.

Debug checklist:
- Run `git-update.sh --dry-run` before server/admin deploy syncs.
- Run `git-update-app.sh --dry-run` before app source syncs.
- If the app source checkout is missing, configure it explicitly instead of using the server deploy mirror.
- `git-update-app.sh` must refuse remotes containing `Tzurah-AI` and any remote that is not `Loqii`.

Branding boundary:
- App/user-facing product name: `Loqii`.
- About/co-branding line: `Loqii by Tzurah`.
- Company/platform/admin/server naming may remain Tzurah where it describes backend operations.

## File Boundary

Local app files, never pushed through server/admin deploy sync:
- `electron.js`
- `preload.js`
- `index.html`
- `server.mjs`
- `db.js`
- `florence-worker.js`

App source files may be synced only through `git-update-app.sh` to the app source repository.

Deploy-safe files:
- `gcp-server.js`
- `admin.html`
- `admin-login.html`

Project docs:
- `AGENT.md`
- `SKILL.md`
- `COMPONENTS.md`

If docs are added to deploy sync, whitelist only docs explicitly and keep local-only app files blocked.
