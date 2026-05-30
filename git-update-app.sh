#!/usr/bin/env bash
set -euo pipefail

# ================================================================
#  git-update-app.sh - Push only approved Electron app source files
#
#  This is separate from git-update.sh on purpose:
#    - git-update.sh      => server/admin deploy mirror for the VM
#    - git-update-app.sh  => Electron app source repo for packaging
#
#  Windows PowerShell:
#    & "C:\Program Files\Git\bin\bash.exe" .\git-update-app.sh --dry-run
#    & "C:\Program Files\Git\bin\bash.exe" .\git-update-app.sh "commit message"
#
#  Required target:
#    APP_SOURCE_DIR=../loqii-app-source
#    Optional first-time clone:
#    APP_REPO_URL=https://github.com/ojjiemeka/Loqii.git
#
#  Safety:
#    - No git add -A
#    - No .env files
#    - No node_modules
#    - No dist/release/out/build artifacts
#    - Refuses to use the server deploy mirror as the app target
# ================================================================

APP_SOURCE_DIR=${APP_SOURCE_DIR:-"../loqii-app-source"}
APP_REPO_URL=${APP_REPO_URL:-""}

APP_SOURCE_FILES=(
  "README.app.md"
  "app-repo.gitignore"
  "AGENT.md"
  "BRAIN.md"
  "git-update-app.sh"
  "index.html"
  "electron.js"
  "preload.js"
  "server.mjs"
  "db.js"
  "supabase.js"
  "build.js"
  "sdk-entry.js"
  "sessionState.js"
  "sessionIndicators.js"
  "statusBanner.js"
  "promptComposer.js"
  "scenes.js"
  "styles.js"
  "performanceMonitor.js"
  "errorBoundary.js"
  "reconnectManager.js"
  "settingsArchitecture.js"
  "loqiiTheme.js"
  "loqiiModal.js"
  "loqiiDrawer.js"
  "loqiiToast.js"
  "loqiiHelp.js"
  "obs.html"
  "login.html"
  "signup.html"
  "topup.html"
  "dashboard.html"
  "package.json"
  "package-lock.json"
  "COMPONENTS.md"
  "RELEASE_PLAN.md"
  "PRODUCT_ROADMAP.md"
  "CHECKPOINT_RUNTIME_STABLE_2026_05_29.md"
  "docs/screenshots/README.md"
  "docs/screenshots/workspace-light.png"
  "docs/screenshots/onboarding-light.png"
  "docs/screenshots/identity-slots-light.png"
  "assets/icon.ico"
  "assets/tray-icon.png"
  "assets/Tzurah_logo.png"
)

APP_DEST_FILES=()
app_dest_for() {
  case "$1" in
    "README.app.md") echo "README.md" ;;
    "app-repo.gitignore") echo ".gitignore" ;;
    *) echo "$1" ;;
  esac
}

app_source_for() {
  case "$1" in
    "README.app.md")
      if [[ -f "README.app.md" ]]; then echo "README.app.md"; else echo "README.md"; fi
      ;;
    "app-repo.gitignore")
      if [[ -f "app-repo.gitignore" ]]; then echo "app-repo.gitignore"; else echo ".gitignore"; fi
      ;;
    *) echo "$1" ;;
  esac
}

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
  shift
fi

MSG=${1:-"auto: update Electron app source $(date '+%H:%M')"}

echo "Loqii app source sync"
echo "App source directory: $APP_SOURCE_DIR"
echo "Mode: $([[ "$DRY_RUN" == "1" ]] && echo "dry run" || echo "commit + push")"
echo

if [[ ! -f "index.html" || ! -f "electron.js" || ! -f "server.mjs" || ! -f "preload.js" ]]; then
  echo "ERROR: Run from the RTDF-Decart project folder."
  exit 1
fi

if [[ "$APP_SOURCE_DIR" == "../tzurah-server-deploy" || "$APP_SOURCE_DIR" == *"tzurah-server-deploy"* ]]; then
  echo "ERROR: Refusing to use the server/admin deploy mirror as the app source target."
  exit 1
fi

echo "Approved app source files:"
for file in "${APP_SOURCE_FILES[@]}"; do
  source_file=$(app_source_for "$file")
  dest=$(app_dest_for "$file")
  APP_DEST_FILES+=("$dest")
  if [[ "$source_file" == "$dest" ]]; then
    echo "  - $source_file"
  elif [[ "$file" == "$dest" ]]; then
    echo "  - $file"
  else
    echo "  - $source_file -> $dest"
  fi
done
echo

echo "Checking source files:"
for file in "${APP_SOURCE_FILES[@]}"; do
  source_file=$(app_source_for "$file")
  if [[ ! -f "$source_file" ]]; then
    echo "ERROR: Missing approved app source file: $source_file"
    exit 1
  fi
  echo "  ok $source_file"
done
echo

if [[ ! -d "$APP_SOURCE_DIR/.git" ]]; then
  if [[ -n "$APP_REPO_URL" ]]; then
    if [[ "$DRY_RUN" == "1" ]]; then
      echo "Dry run: would clone app repo from $APP_REPO_URL into $APP_SOURCE_DIR"
      echo "Dry run passed source/whitelist checks. No files copied because target repo is absent."
      exit 0
    fi
    echo "Cloning app source repo..."
    git clone "$APP_REPO_URL" "$APP_SOURCE_DIR"
  else
    if [[ "$DRY_RUN" == "1" ]]; then
      echo "Dry run target check: app source git checkout not found at $APP_SOURCE_DIR"
      echo "Set APP_SOURCE_DIR to an existing app repo, or set APP_REPO_URL for first-time clone."
      echo "Dry run passed source/whitelist checks. No files were copied or staged."
      exit 0
    fi
    echo "ERROR: App source git checkout not found at $APP_SOURCE_DIR"
    echo "Set APP_SOURCE_DIR to an existing app repo, or set APP_REPO_URL for first-time clone."
    echo "No files were copied or staged."
    exit 2
  fi
fi

SOURCE_ROOT=$(pwd -P)
TARGET_ROOT=$(cd "$APP_SOURCE_DIR" && pwd -P)
IN_PLACE=0
if [[ "$SOURCE_ROOT" == "$TARGET_ROOT" ]]; then
  IN_PLACE=1
  echo "In-place app repo detected; using the current checkout as source and target."
  echo
fi

REMOTE_URL=$(git -C "$APP_SOURCE_DIR" remote get-url origin 2>/dev/null || true)
if [[ -z "$REMOTE_URL" ]]; then
  echo "ERROR: App source repo has no origin remote."
    echo "Expected: https://github.com/ojjiemeka/Loqii.git"
  exit 1
fi
if [[ "$REMOTE_URL" == *"Tzurah-AI"* ]]; then
  echo "ERROR: Refusing to sync app source into the server/admin repo remote: $REMOTE_URL"
  exit 1
fi
if [[ "$REMOTE_URL" != *"Loqii"* ]]; then
  echo "ERROR: Refusing to sync app source into unexpected remote: $REMOTE_URL"
  echo "Expected repo name: Loqii"
  exit 1
fi

if git -C "$APP_SOURCE_DIR" rev-parse --verify HEAD >/dev/null 2>&1; then
  HAS_HEAD=1
else
  HAS_HEAD=0
fi

if [[ "$DRY_RUN" == "1" ]]; then
  echo "Dry run: skipping git pull."
elif [[ "$HAS_HEAD" == "0" ]]; then
  echo "App source repo has no commits yet; skipping pull and preparing first main-branch commit."
  git -C "$APP_SOURCE_DIR" checkout -B main >/dev/null 2>&1 || git -C "$APP_SOURCE_DIR" branch -M main >/dev/null 2>&1 || true
else
  echo "Pulling latest app source repo..."
  git -C "$APP_SOURCE_DIR" pull origin main --rebase --quiet
fi

if [[ "$IN_PLACE" != "1" && -n "$(git -C "$APP_SOURCE_DIR" status --porcelain)" ]]; then
  echo "ERROR: App source repo has existing changes. Commit/stash/clean it before syncing."
  git -C "$APP_SOURCE_DIR" status --short
  exit 1
fi

echo "Copying approved app source files:"
for file in "${APP_SOURCE_FILES[@]}"; do
  source_file=$(app_source_for "$file")
  dest=$(app_dest_for "$file")
  if [[ "$IN_PLACE" == "1" ]]; then
    echo "  in-place $source_file -> $dest"
    continue
  fi
  mkdir -p "$APP_SOURCE_DIR/$(dirname "$dest")"
  cp "$source_file" "$APP_SOURCE_DIR/$dest"
  echo "  copy $source_file -> $APP_SOURCE_DIR/$dest"
done
echo

cd "$APP_SOURCE_DIR"
git reset --quiet

echo "Staging approved app source files:"
for file in "${APP_DEST_FILES[@]}"; do
  git add -- "$file"
  echo "  stage $file"
done
echo

STAGED_FILES=$(git diff --cached --name-only)

if [[ -z "$STAGED_FILES" ]]; then
  echo "No app source changes to commit."
  exit 0
fi

echo "Staged files:"
echo "$STAGED_FILES" | sed 's/^/  - /'
echo

WHITELIST_PATTERN="^(\.gitignore|README\.md|AGENT\.md|BRAIN\.md|git-update-app\.sh|index\.html|electron\.js|preload\.js|server\.mjs|db\.js|supabase\.js|build\.js|sdk-entry\.js|sessionState\.js|sessionIndicators\.js|statusBanner\.js|promptComposer\.js|scenes\.js|styles\.js|performanceMonitor\.js|errorBoundary\.js|reconnectManager\.js|settingsArchitecture\.js|loqiiTheme\.js|loqiiModal\.js|loqiiDrawer\.js|loqiiToast\.js|loqiiHelp\.js|obs\.html|login\.html|signup\.html|topup\.html|dashboard\.html|package\.json|package-lock\.json|COMPONENTS\.md|RELEASE_PLAN\.md|PRODUCT_ROADMAP\.md|CHECKPOINT_RUNTIME_STABLE_2026_05_29\.md|docs/screenshots/(README\.md|workspace-light\.png|onboarding-light\.png|identity-slots-light\.png)|assets/(icon\.ico|tray-icon\.png|Tzurah_logo\.png))$"
BAD_FILES=$(echo "$STAGED_FILES" | grep -Ev "$WHITELIST_PATTERN" || true)
if [[ -n "$BAD_FILES" ]]; then
  echo "ERROR: Refusing to commit files outside the app source whitelist:"
  echo "$BAD_FILES" | sed 's/^/  - /'
  git reset --quiet
  exit 1
fi

SECRET_FILES=$(echo "$STAGED_FILES" | grep -E '(^|/)(\.env|\.env\..*|node_modules|dist|release|out|logs|\.cache)(/|$)' || true)
if [[ -n "$SECRET_FILES" ]]; then
  echo "ERROR: Refusing to commit blocked secret/build/cache paths:"
  echo "$SECRET_FILES" | sed 's/^/  - /'
  git reset --quiet
  exit 1
fi

if [[ "$DRY_RUN" == "1" ]]; then
  git reset --quiet
  if [[ "$IN_PLACE" == "1" ]]; then
    echo "Dry run passed. In-place source files were left unchanged."
  else
    echo "Dry run passed. Restoring copied files so the app source repo stays clean."
    if [[ "$HAS_HEAD" == "1" ]]; then
      git restore --source=HEAD --worktree -- "${APP_DEST_FILES[@]}" 2>/dev/null || true
    else
      rm -f -- "${APP_DEST_FILES[@]}"
    fi
  fi
  exit 0
fi

git commit -m "$MSG" --quiet

if git push origin main --quiet; then
  echo "Pushed app source: $MSG"
else
  echo "ERROR: App source push failed. Check git credentials/network."
  exit 1
fi
