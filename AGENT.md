# Loqii App Agent Instructions

Codex must read `AGENT.md`, `BRAIN.md`, `COMPONENTS.md`, `PRODUCT_ROADMAP.md`, and `RELEASE_PLAN.md` before non-trivial edits.

## Loqii/Tzurah Coding Engine

Future prompts should begin with this instruction for app work:
`Read AGENT.md, BRAIN.md, COMPONENTS.md, PRODUCT_ROADMAP.md, and RELEASE_PLAN.md before editing. Declare repo scope, risk class, topology, tests, and sync path.`

### Repo Boundary Gate

Declare one scope before editing:
- `Loqii only`: Electron app UI, local renderer/main-process UX, OAuth desktop shell, Decart client/session UX, scenes, styles, prompts, and local app components.
- `Tzurah-AI only`: backend, admin panel, billing, protected billing, reconciliation, Decart token routing, feature flags, database/API contracts.
- `Both repos required`: allowed only when the task explicitly requires an app/server contract change. Explain why before editing.

App changes stay in Loqii. Server/admin changes stay in Tzurah-AI. Do not cross repos because a dependency is nearby.

### Topology First

Before code, map:
- affected files
- state owner
- data flow
- async/timing risks
- UI surfaces affected
- backend/API/database boundary
- blast radius

State the topology briefly to the user before editing unless the change is trivial.

### Four Invariants

For every non-trivial change, answer:
- Where does state live?
- Where does feedback or observability live?
- What breaks if this changes?
- When does timing or order matter?

### Risk Classification

Classify work as `trivial`, `low risk`, `medium risk`, `high risk`, or `dangerous`.

High-risk and dangerous work require extra mapping, rollback notes, explicit tests, and no broad refactors.

Billing, auth, session lifecycle, Decart routing, protected billing, reconciliation, and repo-sync logic start at high risk unless the change is purely documentation.

### App Red Lines

Do not break:
- Start/Stop/session safety
- Supabase auth or Google OAuth
- Decart token routing assumptions
- credits display and Add Credits flow
- Account as a single drawer surface

Never show normal users:
- raw debug values
- Decart internals
- prompt debug
- session debug
- fake/static metrics
- `unknown`, `none`, `null`, `undefined`, or `--` scaffolding

Developer diagnostics must be feature-flagged.

### UI System

All app modals use `LoqiiModal` or `LoqiiConfirm`.
All app drawers use `LoqiiDrawer`.
All transient messages use `LoqiiToast` or the shared status system.
All new UI uses semantic theme tokens.
Do not create one-off modal, drawer, card, or button styling.

### Dependency Safety

Do not add dependencies unless necessary. Before adding one, document why native code is insufficient, check package age/version, pin the exact version, and update the lockfile intentionally.

Do not install packages published less than 7 days ago unless the user explicitly overrides that risk.

### Memory And Checkpoints

Update `BRAIN.md` only with durable high-signal lessons. Do not add session logs.

After major successful phases, update:
- `COMPONENTS.md` for component boundaries and permanent rules.
- `PRODUCT_ROADMAP.md` for roadmap/control-plane implications.
- `RELEASE_PLAN.md` when release, packaging, sync, or rollback behavior changes.

### Test Gate

Run relevant checks before final response:
- `node --check` for touched JS
- parse changed inline/module scripts
- native dialog scan
- mojibake scan
- light/dark contrast scan when UI changes
- layout guard when UI changes
- debug leakage scan when UI/settings change
- `git-update-app.sh --dry-run` before app sync

### Sync

Never use `git add -A`.
Use `git-update-app.sh` for app source sync.
Do not push app source through the server/admin deploy script.

### Final Report

Every final report includes:
- files changed
- repo touched
- topology mapped
- risks found
- tests run
- manual QA needed
- sync result
- deferred risks

### Stop Conditions

Stop and ask before coding if state ownership, API contract, repo boundary, database migration, billing impact, auth/session flow, or user intent is unclear.
