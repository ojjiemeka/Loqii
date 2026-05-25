# Loqii Release And Update Plan

This plan defines the update architecture before packaging or shipping a production installer.

## Repository And Sync Boundaries

Current structure:
- `RTDF-Decart` is the local working folder for both Electron app and server/admin source, but it is not itself a Git checkout.
- `../tzurah-server-deploy` is the existing Git checkout for the production server/admin deploy repository: `https://github.com/ojjiemeka/Tzurah-AI.git`.
- The Electron app source repository must be separate: `https://github.com/ojjiemeka/Loqii.git`.
- The Electron app source checkout should live at `../loqii-app-source`.

Two sync paths are required:
- Server/admin deploy sync: `git-update.sh`, targeting `../tzurah-server-deploy`.
- Electron app source sync: `git-update-app.sh`, targeting `APP_SOURCE_DIR` or `../loqii-app-source`.

Do not mix these paths. The server/admin deploy repository must not become the app source repository.

## App Source Sync Workflow

1. Create or clone a dedicated Electron app source repository.
2. Set the target explicitly:
   ```bash
   APP_SOURCE_DIR=../loqii-app-source
   ```
3. For first-time setup only, provide:
   ```bash
   APP_REPO_URL=https://github.com/ojjiemeka/Loqii.git
   ```
4. Dry run before every sync:
   ```bash
   bash git-update-app.sh --dry-run
   ```
5. Commit and push approved app source files:
   ```bash
   bash git-update-app.sh "rename app to Loqii and sync app source"
   ```

Approved app source sync files:
- `README.app.md` copied as `README.md`
- `app-repo.gitignore` copied as `.gitignore`
- `git-update-app.sh`
- `index.html`
- `electron.js`
- `preload.js`
- `server.mjs`
- `db.js`
- `supabase.js`
- `build.js`
- `sdk-entry.js`
- `obs.html`
- `login.html`
- `signup.html`
- `topup.html`
- `dashboard.html`
- `package.json`
- `package-lock.json`
- `COMPONENTS.md`
- `RELEASE_PLAN.md`
- `PRODUCT_ROADMAP.md`
- app UX Lego modules: `loqiiModal.js`, `loqiiDrawer.js`, `loqiiToast.js`, `loqiiTheme.js`, `loqiiHelp.js`
- realtime Lego modules: `sessionState.js`, `sessionIndicators.js`, `statusBanner.js`, `promptComposer.js`, `scenes.js`, `styles.js`, `performanceMonitor.js`, `errorBoundary.js`, `reconnectManager.js`, `settingsArchitecture.js`
- `assets/icon.ico`
- `assets/tray-icon.png`
- `assets/Tzurah_logo.png`

Never sync:
- `.env`
- `.env.production`
- Decart keys or Supabase service keys
- `node_modules`
- logs
- local cache
- packaged `dist`, `release`, or `out` artifacts
- server/admin deploy files unless an app release explicitly needs shared docs

## Release Channels

### Dev
- Purpose: local engineering builds and internal smoke tests.
- Version suffix: `x.y.z-dev.n`.
- Distribution: direct local artifact only.
- Update behavior: no automatic updates.
- Required checks: app opens, login works, Decart token route works, start/stop session works.

### Beta
- Purpose: allowlisted test users and operator validation.
- Version suffix: `x.y.z-beta.n`.
- Distribution: private Loqii Beta GitHub Release or private download link.
- Update behavior: beta update feed only.
- Required checks: billing remains legacy-authoritative except approved test-user protected billing, Decart dev/prod routing proof, rollback path verified.

### Stable
- Purpose: production users.
- Version suffix: `x.y.z`.
- Distribution: signed Loqii installer from the stable release feed.
- Update behavior: stable update feed only.
- Required checks: full regression, production Decart routing confirmed, billing reconciliation healthy, no unresolved critical billing events from current code.

## Packaging Plan

- Use `electron-builder` for Windows `.exe` packaging.
- Keep `index.html`, `electron.js`, `preload.js`, `server.mjs`, static assets, and `public/sdk-bundle.js` in the app package.
- Keep GCP/server deployment separate from desktop app packaging.
- Do not package `.env` production secrets into the desktop build.
- Run `npm install` and `npm run build` from the app source checkout before packaging so generated SDK bundle output is produced from source.

## Beta Build Workflow

1. Sync app source with `git-update-app.sh`.
2. Install dependencies in the app source checkout.
3. Run `npm run build`.
4. Run app smoke tests with `npm run electron:dev`.
5. Build beta artifact with `npm run dist:win`.
6. Publish only to the beta channel or private beta release.

## Stable Build Workflow

1. Promote a verified beta commit.
2. Confirm server/admin deploy state is compatible.
3. Confirm Decart production routing for normal users.
4. Confirm billing reconciliation is healthy or known historical failures are resolved.
5. Build signed stable artifacts.
6. Publish only to the stable update feed.

## Code Signing

- Stable Windows builds require code signing before broad release.
- Beta builds may be unsigned only for internal testers who understand Windows SmartScreen prompts.
- Signing certificate access must be restricted to release operators.

## Update Server Choice

Preferred first implementation:
- GitHub Releases with channel-specific feeds.

Future option:
- Dedicated update service if release targeting, staged rollout, or rollback control outgrows GitHub Releases.

## Versioning

- Use semantic versioning: `major.minor.patch`.
- Use prerelease identifiers for dev and beta channels.
- Every release artifact must include commit hash and build timestamp in release notes.

## Rollback Plan

- Keep the previous stable installer available.
- Disable the current update feed entry if a bad stable build ships.
- Server-side rollback remains separate: protected billing force-legacy override and Decart production routing must remain independent of desktop updates.
- Desktop rollback must never require changing server billing flags.

## Preconditions Before Shipping `.exe`

- App login, credits, Decart token, and start/stop lifecycle verified.
- Google OAuth verified through system-browser deep link without duplicate Electron windows, or disabled by app feature flag.
- Help, onboarding, diagnostics, scene/style engines, light mode, mock payments, and developer tools verified behind admin-controlled app flags.
- Billing reconciliation dashboard healthy or degraded only with understood resolved historical events.
- Normal users proven to route to production Decart.
- Dev/test users proven to route to dev Decart only when explicitly allowed.
- Auto-update feed tested on a non-production channel.
- Installer signing, uninstall, and upgrade paths tested on a clean Windows machine.
