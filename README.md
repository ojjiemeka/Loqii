# Loqii

Electron desktop source for Loqii by Tzurah, a real-time AI video transformation app powered by Decart.

This repository is for the desktop application only. The production server/admin deploy repository is separate:

- Server/admin repo: `https://github.com/ojjiemeka/Tzurah-AI.git`
- App repo: `https://github.com/ojjiemeka/Loqii.git`

## Run Locally

```bash
npm install
npm run electron:dev
```

## Build

```bash
npm run build
npm run dist:win
```

## Repo Boundary

This app repo may contain:

- Electron app source
- Local app server source
- Renderer HTML/UI source
- app package metadata
- app release docs
- approved app assets

This app repo must not contain:

- `.env` files
- production secrets
- Decart API keys
- Supabase service role keys
- Stripe/Paddle secrets
- `node_modules`
- packaged build output
- production server/admin deploy files

Use `git-update-app.sh` from the working source folder to sync approved app files only.
