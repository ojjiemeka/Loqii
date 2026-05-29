/**
 * electron.js  Electron main process  (CommonJS)
 *
 * Architecture:
 *   Auth       Supabase (email/password + Google OAuth via deep link)
 *   Payments   Stripe via GCP server (rtdf://payment/success deep link)
 *   Local DB   SQLite cache (db.js) for tokens + credit balance
 *
 * Window flow:
 *   Not logged in  login.html (480640, loadFile)
 *   Logged in      index.html (1440900, loadURL via local Express)
 *   Account        unified drawer in index.html
 *   Add Credits    themed modal in index.html
 */

"use strict";

require("dotenv").config();

const {
  app, BrowserWindow, Tray, Menu, nativeImage,
  ipcMain, shell, safeStorage, dialog,
} = require("electron");
const fs = require("fs");
const path            = require("path");
let autoUpdater       = null;

//  Local modules 
const db       = require("./db.js");
const supabase = require("./supabase.js");

// Reduce non-fatal Chromium/WebRTC DNS noise without suppressing app console logs.
app.commandLine.appendSwitch("log-level", "2");

function runtimeEnvironment() {
  const raw = String(process.env.LOQII_ENV || process.env.TZURAH_ENV || process.env.NODE_ENV || (app.isPackaged ? "production" : "development")).toLowerCase();
  return ["production", "staging", "development"].includes(raw) ? raw : "development";
}

function isDevelopment() { return runtimeEnvironment() === "development"; }
function isStaging() { return runtimeEnvironment() === "staging"; }
function isProduction() { return runtimeEnvironment() === "production"; }

function envValue(name, { required = false, devDefault = null } = {}) {
  const value = process.env[name];
  if (value && String(value).trim()) return String(value).trim();
  if (isDevelopment() && devDefault != null) return devDefault;
  if (required) throw new Error(`Missing required config: ${name}`);
  return "";
}

function ensureDevelopmentSecret(name, devValue, generated) {
  if (process.env[name] && String(process.env[name]).trim()) return;
  if (!isDevelopment()) return;
  process.env[name] = devValue;
  generated.push(name);
}

function validateElectronConfig() {
  const missing = [];
  const generated = [];
  ensureDevelopmentSecret("BOOTSTRAP_SECRET", "dev-bootstrap-secret", generated);
  ensureDevelopmentSecret("INTERNAL_SECRET", "dev-internal-secret", generated);
  ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"].forEach((name) => {
    if (!process.env[name]) missing.push(name);
  });
  if (!isDevelopment()) {
    ["BOOTSTRAP_SECRET", "INTERNAL_SECRET"].forEach((name) => {
      if (!process.env[name]) missing.push(name);
    });
  }
  const gcpServerUrl = envValue("GCP_SERVER_URL", {
    required: !isDevelopment(),
    devDefault: "http://localhost:4000",
  });
  if (!/^https?:\/\//i.test(gcpServerUrl)) missing.push("GCP_SERVER_URL(valid URL)");
  if (isProduction() && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(gcpServerUrl)) {
    missing.push("GCP_SERVER_URL(non-local production URL)");
  }
  if (generated.length) console.log("[CONFIG] Using development-only generated internal secrets");
  if (missing.length) return { ok: false, missing, gcpServerUrl, environment: runtimeEnvironment() };
  return { ok: true, missing: [], gcpServerUrl, environment: runtimeEnvironment() };
}

const startupConfig = validateElectronConfig();

// Service-role client  bypasses RLS, used only in main process for balance reads.
// NOTE: Renderer uses bootstrap config (fetched via server.mjs /api/config), not these env vars.
// These are ONLY for main-process IPC operations (auth, credit reads)  never sent to renderer.
const { createClient: createSupabaseClient } = require("@supabase/supabase-js");
const supabaseAdmin = startupConfig.ok
  ? createSupabaseClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false, autoRefreshToken: false } }
    )
  : null;

//  Config 
const PORT           = parseInt(process.env.EXPRESS_PORT || "3000", 10);
const GCP_SERVER_URL = startupConfig.gcpServerUrl;
const isDev          = isDevelopment();
const devBypass      = isDevelopment() && (process.env.LOQII_DEV_BYPASS === "1" || process.argv.includes("--dev"));
app.setName("Loqii");

//  State 
let mainWin      = null;
let tray         = null;
let expressServer = null;
let serverModule  = null;
let shutdownPromise = null;
let isQuitting    = false;

// Pending Google OAuth resolve function (set while waiting for deep link)
let pendingOAuthResolve = null;
let pendingOAuthReject  = null;

// External navigation policy:
// - Local app UI is owned by the embedded localhost server.
// - OAuth may open Supabase/Google hosted URLs in the system browser.
// - Payments may open Stripe Checkout in the system browser.
// - tzurah:// and loqii:// are owned by this Electron app for legacy OAuth returns.
const EXTERNAL_URL_ALLOWLIST = [
  "https://tzurah.ai",
  "https://www.tzurah.ai",
  "https://admin.tzurah.ai",
  "https://accounts.google.com",
  "https://*.google.com",
  "https://*.supabase.co",
  "https://checkout.stripe.com",
  "mailto:support@tzurah.ai",
];

function originMatches(pattern, target) {
  if (pattern.startsWith("mailto:")) return target.href.startsWith(pattern);
  const parsed = new URL(pattern.replace("*.", "placeholder."));
  if (pattern.includes("*.")) {
    const suffix = pattern.split("*.")[1];
    return target.protocol === parsed.protocol && target.hostname.endsWith(`.${suffix}`);
  }
  return target.origin === parsed.origin;
}

function isAllowedExternalUrl(url) {
  try {
    const target = new URL(url);
    return EXTERNAL_URL_ALLOWLIST.some((pattern) => originMatches(pattern, target));
  } catch {
    return false;
  }
}

function safeOpenExternal(url) {
  if (!isAllowedExternalUrl(url)) {
    console.warn("[SECURITY] Blocked external URL");
    return Promise.resolve(false);
  }
  return shell.openExternal(url);
}

function safeOAuthDescription(payload = {}) {
  if (payload.error_code === "user_banned") return "This account is banned.";
  return payload.error_description || payload.error || "Google sign-in failed. Please try again.";
}

function rendererOAuthPayload(payload = {}) {
  const ok = !(payload.error || payload.error_code);
  return {
    ok,
    user: ok && payload.user ? {
      user_id: payload.user.user_id || null,
      email: payload.user.email || null,
      display_name: payload.user.display_name || "",
    } : null,
    error: payload.error || null,
    error_code: payload.error_code || null,
    error_description: ok ? null : safeOAuthDescription(payload),
  };
}

function sendOAuthResultToAuthWindow(payload = {}) {
  const safePayload = rendererOAuthPayload(payload);
  BrowserWindow.getAllWindows().forEach((w) => {
    if (!w.isDestroyed()) w.webContents.send("oauth-result", safePayload);
  });
  if (mainWin && !mainWin.isDestroyed()) {
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.focus();
  }
}

function settlePendingOAuth(payload = {}) {
  if (payload.error || payload.error_code) {
    sendOAuthResultToAuthWindow(payload);
    if (pendingOAuthReject) {
      const err = new Error(safeOAuthDescription(payload));
      err.error_code = payload.error_code || payload.error || "oauth_error";
      err.error_description = safeOAuthDescription(payload);
      pendingOAuthReject(err);
    }
    return;
  }

  if (payload.access_token || payload.code) {
    if (pendingOAuthResolve) {
      pendingOAuthResolve({
        access_token: payload.access_token || "",
        refresh_token: payload.refresh_token || "",
        code: payload.code || "",
      });
    }
  }
}

function oauthPayloadFromParams(params) {
  return {
    error: params.get("error") || null,
    error_code: params.get("error_code") || null,
    error_description: params.get("error_description") || null,
    access_token: params.get("access_token") || null,
    refresh_token: params.get("refresh_token") || null,
    code: params.get("code") || null,
  };
}

function mergeOAuthPayloads(...payloads) {
  return payloads.reduce((merged, payload) => ({
    error: merged.error || payload.error || null,
    error_code: merged.error_code || payload.error_code || null,
    error_description: merged.error_description || payload.error_description || null,
    access_token: merged.access_token || payload.access_token || null,
    refresh_token: merged.refresh_token || payload.refresh_token || null,
    code: merged.code || payload.code || null,
  }), {});
}

function getAutoUpdater() {
  if (isDev) return null;
  if (!autoUpdater) {
    try {
      ({ autoUpdater } = require("electron-updater"));
    } catch (err) {
      console.warn("[UPDATER] Could not load electron-updater:", err.message);
      return null;
    }
  }
  return autoUpdater;
}

//  Protocol registration 
// Must be called before app.whenReady() on Windows
app.setAsDefaultProtocolClient("tzurah");
app.setAsDefaultProtocolClient("loqii");

//  Single-instance lock + deep-link handler (Windows) 
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

app.on("second-instance", (_event, argv) => {
  // On Windows, deep links arrive as a command-line argument in the
  // second instance's argv array.
  const deepUrl = argv.find((a) => a.startsWith("tzurah://") || a.startsWith("loqii://"));
  if (deepUrl) handleDeepLink(deepUrl);
  if (mainWin && !mainWin.isDestroyed()) {
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.focus();
  }
});

// macOS / Linux: deep links arrive via the open-url event
app.on("open-url", (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

//  Deep link router 
function handleDeepLink(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { return; }

  // tzurah://auth/callback#access_token=...&refresh_token=...
  // Supabase OAuth redirects with tokens in the hash fragment.
  if (parsed.hostname === "auth" && parsed.pathname.includes("callback")) {
    const queryParams = new URLSearchParams(parsed.search.startsWith("?") ? parsed.search.slice(1) : parsed.search);
    const hashParams  = new URLSearchParams(parsed.hash.startsWith("#") ? parsed.hash.slice(1) : parsed.hash);
    settlePendingOAuth(mergeOAuthPayloads(
      oauthPayloadFromParams(queryParams),
      oauthPayloadFromParams(hashParams)
    ));
    return;
  }

  // tzurah://payment/success?session_id=...
  if (parsed.hostname === "payment" && parsed.pathname.includes("success")) {
    refreshCreditsFromServer().catch(() => {});
    BrowserWindow.getAllWindows().forEach((w) => {
      if (!w.isDestroyed()) w.webContents.send("payment:success");
    });
    return;
  }

  // tzurah://payment/cancel is handled by the browser checkout flow.
}

//  Token helpers (safeStorage encryption) 
function encryptToken(raw) {
  if (!raw) return null;
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(raw).toString("base64");
  }
  return raw; // fallback: plaintext (safeStorage unavailable)
}

function decryptToken(stored) {
  if (!stored) return null;
  // Plain JWT (dev mode tokens, or safeStorage-unavailable fallback)  return as-is
  if (stored.startsWith("eyJ")) return stored;
  if (safeStorage.isEncryptionAvailable()) {
    try { return safeStorage.decryptString(Buffer.from(stored, "base64")); }
    catch { return null; } // corrupt stored value  treat as missing
  }
  return stored;
}

//  Supabase session helpers 

/**
 * Attempts to restore the Supabase session from the local DB.
 *
 * Strategy:
 *  1. If access token is structurally valid and not expired  setSession().
 *  2. If that fails (or token is expired)  refreshSession() with refresh_token.
 *  3. If refresh also fails  return null (caller clears session + shows login).
 *
 * Never throws. Never logs scary error messages to the console.
 */
async function restoreSupabaseSession() {
  const local = db.getSession();
  if (!local || !local.access_token) return null;

  const accessToken  = decryptToken(local.access_token);
  const refreshToken = decryptToken(local.refresh_token);

  //  Fast path: access token looks valid 
  if (db.validateToken(accessToken)) {
    try {
      const { data, error } = await supabase.auth.setSession({
        access_token:  accessToken,
        refresh_token: refreshToken,
      });
      if (!error && data.session) {
        // Supabase may have silently refreshed the token
        if (data.session.access_token !== accessToken) {
          db.saveSession({
            ...local,
            access_token:  encryptToken(data.session.access_token),
            refresh_token: encryptToken(data.session.refresh_token),
            last_synced:   Date.now(),
          });
        }
        return data.session;
      }
    } catch { /* fall through to refresh path */ }
  }

  //  Refresh path: access token invalid/expired 
  if (!refreshToken) return null;
  try {
    const { data, error } = await supabase.auth.refreshSession({ refresh_token: refreshToken });
    if (error || !data.session) return null;
    db.saveSession({
      ...local,
      access_token:  encryptToken(data.session.access_token),
      refresh_token: encryptToken(data.session.refresh_token),
      last_synced:   Date.now(),
    });
    return data.session;
  } catch {
    return null; // refresh failed  caller will clear session
  }
}

/**
 * Returns a fresh, valid Supabase access token (decrypted).
 * Proactively refreshes if the stored token expires within 5 minutes.
 * @returns {Promise<string|null>}
 */
async function getFreshAccessToken() {
  const local = db.getSession();
  if (!local || !local.access_token) return null;

  const accessToken  = decryptToken(local.access_token);
  const refreshToken = decryptToken(local.refresh_token);

  // Token has > 5 minutes remaining  use it as-is
  if (db.validateToken(accessToken, 5 * 60)) return accessToken;

  // Token expired or close to expiry  proactively refresh
  if (!refreshToken) return accessToken; // last resort
  try {
    const { data, error } = await supabase.auth.refreshSession({ refresh_token: refreshToken });
    if (error || !data.session) return accessToken;
    db.saveSession({
      ...local,
      access_token:  encryptToken(data.session.access_token),
      refresh_token: encryptToken(data.session.refresh_token),
      last_synced:   Date.now(),
    });
    return data.session.access_token;
  } catch {
    return accessToken; // return whatever we have
  }
}

/** Fetches fresh credit balance from Supabase and updates local DB. */
async function refreshCreditsFromServer() {
  const local = db.getSession();
  if (!local) return;

  const { data: profile } = await supabase
    .from("profiles")
    .select("credits")
    .eq("id", local.user_id)
    .single();

  if (profile && typeof profile.credits === "number") {
    db.setCredits(profile.credits);
    BrowserWindow.getAllWindows().forEach((w) => {
      if (!w.isDestroyed()) w.webContents.send("credits:updated", profile.credits);
    });
  }
}

/** Calls /api/ensure-profile so new OAuth users get a profiles row. */
async function ensureProfileForUser(accessToken) {
  if (!accessToken) return;
  try {
    await fetch(`${GCP_SERVER_URL}/api/ensure-profile`, {
      method:  "POST",
      headers: { "Authorization": `Bearer ${accessToken}` },
    });
  } catch (e) {
    console.log("[PROFILE] ensure-profile failed:", e.message);
  }
}

//  Window factories 

function ensureMainWin() {
  if (mainWin && !mainWin.isDestroyed()) return;
  mainWin = new BrowserWindow({
    width:           480,
    height:          640,
    minWidth:        400,
    minHeight:       500,
    frame:           false,
    titleBarStyle:   "hidden",
    backgroundColor: "#011627",
    icon:            path.join(__dirname, "assets", "Tzurah_logo.png"),
    webPreferences: {
      preload:          path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration:  false,
      webSecurity:      true,
      sandbox:          true,
    },
    show: false,
  });
  mainWin.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    gracefulShutdown("main-window-close").catch((err) => {
      console.error("[SHUTDOWN] Main window close failed:", err.message);
      app.exit(1);
    });
  });
  mainWin.on("closed",    () => { mainWin = null; });
  mainWin.on("maximize",   () => { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send("window:maximized"); });
  mainWin.on("unmaximize", () => { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send("window:unmaximized"); });
  mainWin.webContents.on("will-navigate", (event, url) => {
    const allowedLocal = url.startsWith(`http://localhost:${PORT}`) || url.startsWith("file://");
    if (!allowedLocal) {
      event.preventDefault();
      safeOpenExternal(url);
    }
  });
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    safeOpenExternal(url);
    return { action: "deny" };
  });
}

function showLoginScreen() {
  ensureMainWin();
  mainWin.setSize(480, 640);
  mainWin.setMinimumSize(400, 500);
  mainWin.setResizable(false);
  mainWin.center();
  mainWin.loadFile(path.join(__dirname, "login.html"));
  mainWin.once("ready-to-show", () => mainWin.show());
}

function showMainApp() {
  ensureMainWin();
  mainWin.setSize(1440, 900);
  mainWin.setMinimumSize(900, 600);
  mainWin.setResizable(true);
  mainWin.center();
  mainWin.loadURL(`http://localhost:${PORT}`);
  mainWin.once("ready-to-show", () => mainWin.show());
}

function runMainAppSurface(commandName) {
  if (!db.getSession()) {
    showLoginScreen();
    return;
  }

  const command = `window.${commandName}?.()`;
  const isLoadedMainApp = mainWin && !mainWin.isDestroyed() &&
    mainWin.webContents.getURL().startsWith(`http://localhost:${PORT}`);

  const execute = () => {
    if (!mainWin || mainWin.isDestroyed()) return;
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.show();
    mainWin.focus();
    mainWin.webContents.executeJavaScript(command).catch((err) => {
      console.warn(`[UI] Could not run ${commandName}:`, err.message);
    });
  };

  if (!isLoadedMainApp) {
    showMainApp();
    mainWin.webContents.once("did-finish-load", () => setTimeout(execute, 100));
    return;
  }

  execute();
}

function openTopup() {
  runMainAppSurface("loqiiOpenAddCredits");
}

function openDashboard() {
  runMainAppSurface("loqiiOpenAccount");
}

async function showRestoredSessionOrLogin() {
  const local = db.getSession();
  if (local && local.access_token) {
    const session = await restoreSupabaseSession();
    if (session) {
      showMainApp();
      setTimeout(() => refreshCreditsFromServer().catch(() => {}), 2000);
      return true;
    }
    db.clearSession();
  }
  showLoginScreen();
  return false;
}

//  System tray 
function createTray() {
  const iconPath = path.join(__dirname, "assets", "tray-icon.png");
  tray = new Tray(nativeImage.createFromPath(iconPath));
  tray.setToolTip("Loqii  AI Face Swap");
  buildTrayMenu();
  tray.on("double-click", () => {
    if (mainWin && !mainWin.isDestroyed()) mainWin.show();
    else showMainApp();
  });
}

function buildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Loqii", click: () => { if (mainWin && !mainWin.isDestroyed()) mainWin.show(); else showMainApp(); } },
    { type: "separator" },
    { label: "Account",         click: openDashboard },
    { label: "Add Credits",     click: openTopup },
    { type: "separator" },
    { label: "Quit Loqii",     click: () => app.quit() },
  ]));
}

//  App menu 
function buildAppMenu() {
  const js = (code) => { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.executeJavaScript(code); };
  const template = [
    { label: "File", submenu: [
      { label: "New Session",   accelerator: "CmdOrCtrl+N", click: () => js("if(!isConnected) btnStart.click()") },
      { type: "separator" },
      { label: "Save Recording", accelerator: "CmdOrCtrl+S", click: () => js("if(isRecording) stopRecording()") },
      { type: "separator" },
      { label: "Exit", accelerator: process.platform === "darwin" ? "Cmd+Q" : "Alt+F4", click: () => app.quit() },
    ]},
    { label: "View", submenu: [
      { label: "Landscape Mode", type: "radio", checked: true,  click: () => js("if(isPortraitMode) togglePortraitMode()") },
      { label: "Portrait Mode",  type: "radio", checked: false, click: () => js("if(!isPortraitMode) togglePortraitMode()") },
      { type: "separator" },
      { label: "Show FPS Counter", type: "checkbox", checked: true,
        click: (item) => js(`const f=document.getElementById('fps-counter');if(f)f.style.display='${"{item.checked ? '' : 'none'}"}'`) },
      { type: "separator" },
      { role: "reload", label: "Reload App" },
      { role: "toggleDevTools", label: "Developer Tools" },
    ]},
    { label: "Session", submenu: [
      { label: "Start",            accelerator: "Space",            click: () => js("if(!isConnected) btnStart.click()") },
      { label: "Stop",             accelerator: "Escape",           click: () => js("if(isConnected) doStop()") },
      { label: "Apply Changes",    accelerator: "CmdOrCtrl+R",      click: () => js("if(isConnected) btnApply.click()") },
      { type: "separator" },
      { label: "Toggle Recording", accelerator: "CmdOrCtrl+Shift+R", click: () => js("if(isRecording) stopRecording(); else if(isConnected) startRecording()") },
    ]},
    { label: "Identities", submenu: [
      ...[1,2,3,4,5].map(i => ({ label: `Identity ${i}`, accelerator: String(i), click: () => js(`selectSlot(${i-1})`) })),
      { type: "separator" },
      { label: "Clear Active Slot", accelerator: "Delete", click: () => js("clearSlot(activeSlotIndex)") },
    ]},
    { label: "Account", submenu: [
      { label: "My Account",   accelerator: "CmdOrCtrl+D", click: openDashboard },
      { label: "Add Credits",  accelerator: "CmdOrCtrl+B", click: openTopup },
      { type: "separator" },
      { label: "Sign Out", click: () => js("window.tzurah?.logout()") },
    ]},
    { label: "Help", submenu: [
      { label: "Getting Started",   click: () => js("showOnboarding(true)") },
      { label: "Keyboard Shortcuts", accelerator: "Shift+/", click: () => js("showKeyboardShortcuts()") },
      { type: "separator" },
      { label: "Contact Support", click: () => safeOpenExternal("mailto:support@tzurah.ai") },
      { label: "Check for Updates", click: () => getAutoUpdater()?.checkForUpdatesAndNotify() },
    ]},
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

//  Local Express server 
async function startExpress() {
  serverModule = await import("./server.mjs");
  if (serverModule?.setOAuthCallbackHandler) {
    serverModule.setOAuthCallbackHandler((payload) => {
      console.log("[OAUTH] Local callback received:", payload?.error_code || payload?.error || payload?.code ? "result" : "empty");
      settlePendingOAuth(payload || {});
    });
  }
  expressServer = await serverModule.startServer(PORT);
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => {
      console.warn(`[SHUTDOWN] ${label} timed out after ${ms}ms`);
      resolve();
    }, ms)),
  ]);
}

async function stopRendererSessionForShutdown() {
  const win = mainWin;
  if (!win || win.isDestroyed()) return;
  try {
    await withTimeout(
      win.webContents.executeJavaScript(`
        (async () => {
          try {
            if (typeof doStop === "function" && (window.isConnected || typeof isConnected !== "undefined" && isConnected || window.realtimeClient || typeof realtimeClient !== "undefined" && realtimeClient)) {
              await doStop({ suppressSummary: true, source: "app_shutdown" });
            } else {
              if (typeof stopOBSStream === "function") stopOBSStream();
              if (typeof stopMicMonitoring === "function") stopMicMonitoring();
              if (typeof stopRecording === "function" && typeof isRecording !== "undefined" && isRecording) stopRecording();
              if (typeof realtimeClient !== "undefined" && realtimeClient) {
                try { realtimeClient.disconnect(); } catch (_) {}
                realtimeClient = null;
              }
              if (typeof webcamStream !== "undefined" && webcamStream) {
                webcamStream.getTracks().forEach(t => t.stop());
                webcamStream = null;
              }
            }
          } catch (err) {
            console.error("[SHUTDOWN] Renderer cleanup failed:", err?.message || err);
          }
          true;
        })();
      `, true),
      5000,
      "renderer cleanup"
    );
  } catch (err) {
    console.warn("[SHUTDOWN] Renderer cleanup skipped:", err.message);
  }
}

async function closeLocalServer() {
  if (!expressServer) return;
  const server = expressServer;
  expressServer = null;
  try {
    if (serverModule?.shutdownServer) {
      await withTimeout(serverModule.shutdownServer(server), 3000, "local server shutdown");
    } else if (server.listening) {
      await withTimeout(new Promise((resolve) => server.close(() => resolve())), 3000, "local server close");
    }
  } catch (err) {
    console.warn("[SHUTDOWN] Local server close failed:", err.message);
  }
}

async function gracefulShutdown(reason = "app-quit") {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    console.log(`[SHUTDOWN] Starting graceful shutdown: ${reason}`);
    const forceTimer = setTimeout(() => {
      console.error("[SHUTDOWN] Force exiting after timeout");
      app.exit(0);
    }, 8000);
    forceTimer.unref?.();

    await stopRendererSessionForShutdown();

    if (tray) {
      try { tray.destroy(); } catch {}
      tray = null;
    }

    await closeLocalServer();

    clearTimeout(forceTimer);
    isQuitting = true;
    console.log("[SHUTDOWN] Complete");
    app.exit(0);
  })();
  return shutdownPromise;
}

//  IPC: Auth 

ipcMain.handle("auth:signup", async (_e, email, password, displayName) => {
  try {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name: displayName || email.split("@")[0] } },
    });
    if (error) return { error: error.message };

    // Supabase may require email confirmation  session may be null
    if (data.session) {
      db.saveSession({
        user_id:           data.user.id,
        email:             data.user.email,
        display_name:      data.user.user_metadata?.full_name || displayName || "",
        avatar_url:        data.user.user_metadata?.avatar_url || null,
        credits_remaining: 6,  // matches the default in the profiles trigger
        access_token:      encryptToken(data.session.access_token),
        refresh_token:     encryptToken(data.session.refresh_token),
        last_synced:       Date.now(),
      });
      showMainApp();
      return { ok: true, user: db.getSession() };
    }

    // Email confirmation required
    return { ok: true, confirmRequired: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle("auth:login", async (_e, email, password) => {
  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { error: error.message };

    // Fetch profile to get current credits
    const { data: profile } = await supabase
      .from("profiles")
      .select("credits, display_name, avatar_url, total_credits_used")
      .eq("id", data.user.id)
      .single();

    db.saveSession({
      user_id:            data.user.id,
      email:              data.user.email,
      display_name:       profile?.display_name || data.user.user_metadata?.full_name || "",
      avatar_url:         profile?.avatar_url   || data.user.user_metadata?.avatar_url || null,
      credits_remaining:  profile?.credits      ?? 0,
      total_credits_used: profile?.total_credits_used ?? 0,
      access_token:       encryptToken(data.session.access_token),
      refresh_token:      encryptToken(data.session.refresh_token),
      last_synced:        Date.now(),
    });

    showMainApp();
    return { ok: true, user: db.getSession() };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle("auth:google", async () => {
  try {
    const oauthRedirectTo = `http://localhost:${PORT}/oauth/callback`;
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo:          oauthRedirectTo,
        skipBrowserRedirect: true,
      },
    });
    if (error || !data.url) return { error: error?.message || "Failed to get OAuth URL" };

    // Open OAuth in the system browser and resolve through the existing
    // localhost callback bridge. tzurah:// and loqii:// deep links remain
    // supported for older Supabase redirect allowlist entries.
    const tokens = await new Promise((resolve, reject) => {
      let settled = false;
      pendingOAuthResolve = (tokens) => {
        if (settled) return;
        settled = true;
        pendingOAuthResolve = null;
        pendingOAuthReject = null;
        resolve(tokens);
      };
      pendingOAuthReject = (err) => {
        if (settled) return;
        settled = true;
        pendingOAuthResolve = null;
        pendingOAuthReject = null;
        reject(err);
      };
      safeOpenExternal(data.url).catch((err) => pendingOAuthReject(err));

      setTimeout(() => {
        if (!settled) {
          settled = true;
          pendingOAuthResolve = null;
          pendingOAuthReject = null;
          reject(new Error("Google sign-in timed out. Please try again."));
        }
      }, 300_000);
    });

    // Exchange OAuth result with Supabase. Tokens never leave the main process.
    const { data: sessionData, error: sessionErr } = tokens.code
      ? await supabase.auth.exchangeCodeForSession(tokens.code)
      : await supabase.auth.setSession({
          access_token:  tokens.access_token,
          refresh_token: tokens.refresh_token,
        });
    if (sessionErr) return { error: sessionErr.message };
    if (!sessionData?.session) return { error: "Google sign-in did not return a session." };

    const user = sessionData.session.user;

    const { data: profile } = await supabase
      .from("profiles")
      .select("credits, display_name, avatar_url, total_credits_used")
      .eq("id", user.id)
      .single();

    const sessionSummary = {
      user_id:            user.id,
      email:              user.email,
      display_name:       profile?.display_name || user.user_metadata?.full_name || "",
      avatar_url:         profile?.avatar_url   || user.user_metadata?.avatar_url || null,
      credits_remaining:  profile?.credits      ?? 0,
      total_credits_used: profile?.total_credits_used ?? 0,
    };

    db.saveSession({
      ...sessionSummary,
      access_token:       encryptToken(sessionData.session.access_token),
      refresh_token:      encryptToken(sessionData.session.refresh_token),
      last_synced:        Date.now(),
    });

    // Ensure Supabase profile row exists for new OAuth users
    ensureProfileForUser(sessionData.session.access_token).catch(() => {});

    sendOAuthResultToAuthWindow({ ok: true, user: sessionSummary });
    showMainApp();
    return { ok: true, user: db.getSession() };
  } catch (err) {
    if (err.message === "cancelled") return { cancelled: true };
    return {
      error: err.error_description || err.message,
      error_code: err.error_code || null,
      error_description: err.error_description || err.message,
    };
  }
});

ipcMain.handle("auth:logout", async () => {
  await supabase.auth.signOut().catch(() => {});
  db.clearSession();
  showLoginScreen();
  buildTrayMenu();
  return { ok: true };
});

ipcMain.handle("auth:getSession", () => {
  const s = db.getSession();
  if (!s) return null;
  // Strip encrypted tokens before sending to renderer
  const { access_token, refresh_token, ...safe } = s;
  return safe;
});

// Returns a fresh (auto-refreshed) access token for API calls that require user auth.
ipcMain.handle("auth:getAccessToken", async () => {
  try {
    const token = await getFreshAccessToken();
    console.log("[IPC] getAccessToken:", token ? "present" : "NULL");
    return token;
  } catch (err) {
    console.error("[IPC] getAccessToken failed:", err.message);
    return null;
  }
});

//  IPC: Credits 

ipcMain.handle("credits:getBalance", async () => {
  const local = db.getSession();
  if (!local) return { credits: 0 };

  try {
    const { data: profile, error } = await supabaseAdmin
      .from("profiles")
      .select("credits")
      .eq("id", local.user_id)
      .single();

    if (error) {
      console.warn("[BALANCE] Supabase fetch error:", error.message, " using local cache");
    } else if (profile && typeof profile.credits === "number") {
      console.log("[BALANCE] Supabase:", profile.credits, "local cache:", local.credits_remaining);
      db.setCredits(profile.credits);
      return { credits: profile.credits };
    }
  } catch (err) {
    console.warn("[BALANCE] Network error:", err.message, " using local cache");
  }

  return { credits: local.credits_remaining };
});

ipcMain.handle("credits:deduct", async (_e, credits, seconds, metadata = null) => {
  // Deduct locally first for instant UI feedback
  const localBalance = db.deductCredits(credits);
  db.logUsage(seconds, credits);

  BrowserWindow.getAllWindows().forEach((w) => {
    if (!w.isDestroyed()) w.webContents.send("credits:updated", localBalance);
  });

  // Sync to GCP server  awaited so Supabase stays consistent
  try {
    const accessToken = await getFreshAccessToken();
    if (!accessToken) {
      console.warn("[DEDUCT] No access token  skipping server sync, local balance:", localBalance);
      return { remaining: localBalance };
    }

    console.log("[DEDUCT] Syncing to server  credits:", credits, "seconds:", seconds, "token:", accessToken ? "present" : "missing");

    const local = db.getSession();
    const billingMetadata = metadata && typeof metadata === "object" ? metadata : {};
    const body = {
      credits,
      session_seconds: seconds,
      user_id: billingMetadata.user_id || local?.user_id || null,
      session_id: billingMetadata.session_id || null,
      sync_id: billingMetadata.sync_id || null,
      sync_sequence: Number.isInteger(billingMetadata.sync_sequence) ? billingMetadata.sync_sequence : null,
      source: billingMetadata.source || null,
      duration_secs: Number.isFinite(Number(billingMetadata.duration_secs)) ? Number(billingMetadata.duration_secs) : seconds,
      client_ts: billingMetadata.client_ts || null,
    };
    console.log("[DEDUCT] Billing metadata:", {
      sync_id: body.sync_id || "legacy",
      sync_sequence: body.sync_sequence,
      source: body.source || "legacy",
      duration_secs: body.duration_secs,
    });

    const resp = await fetch(`${GCP_SERVER_URL}/credits/deduct`, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    });

    console.log("[DEDUCT] Server response:", resp.status);

    if (resp.ok) {
      const data = await resp.json();
      console.log("[DEDUCT] Server confirmed remaining:", data.credits_remaining);
      if (typeof data.credits_remaining === "number") {
        db.setCredits(data.credits_remaining);
        BrowserWindow.getAllWindows().forEach((w) => {
          if (!w.isDestroyed()) w.webContents.send("credits:updated", data.credits_remaining);
        });
        return { remaining: data.credits_remaining };
      }
    } else {
      const errText = await resp.text().catch(() => "");
      console.error("[DEDUCT] Server error", resp.status, ":", errText);
    }
  } catch (err) {
    console.error("[DEDUCT] Network error:", err.message, " local balance:", localBalance);
  }

  return { remaining: localBalance };
});

ipcMain.handle("credits:sync", async (_e, metadata = null) => {
  const unsynced = db.getUnsyncedUsage();
  if (!unsynced.length) return { ok: true };

  const local = db.getSession();
  if (!local) return { ok: false };

  try {
    const accessToken = await getFreshAccessToken();
    if (!accessToken) return { ok: false };
    const billingMetadata = metadata && typeof metadata === "object" ? metadata : {};
    const resp = await fetch(`${GCP_SERVER_URL}/credits/sync`, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        usage_logs: unsynced,
        user_id: billingMetadata.user_id || local?.user_id || null,
        session_id: billingMetadata.session_id || null,
        sync_id: billingMetadata.sync_id || null,
        sync_sequence: Number.isInteger(billingMetadata.sync_sequence) ? billingMetadata.sync_sequence : null,
        source: billingMetadata.source || null,
        duration_secs: Number.isFinite(Number(billingMetadata.duration_secs)) ? Number(billingMetadata.duration_secs) : null,
        client_ts: billingMetadata.client_ts || null,
      }),
    });
    if (resp.ok) {
      const data = await resp.json();
      db.markSynced(unsynced.map((u) => u.id));
      if (typeof data.credits_remaining === "number") {
        db.setCredits(data.credits_remaining);
      }
      return { ok: true };
    }
  } catch {
    // Offline  will retry next time
  }
  return { ok: false };
});

ipcMain.handle("credits:getPurchases", async () => {
  const local = db.getSession();
  if (!local) return { purchases: [] };

  try {
    await restoreSupabaseSession();
    const { data, error } = await supabase
      .from("purchases")
      .select("*")
      .eq("user_id", local.user_id)
      .order("created_at", { ascending: false })
      .limit(10);

    if (error) return { purchases: [] };
    return { purchases: data || [] };
  } catch {
    return { purchases: [] };
  }
});

//  IPC: Stripe 

ipcMain.handle("stripe:checkout", async (_e, pack) => {
  const local = db.getSession();
  if (!local) return { error: "Not logged in" };

  try {
    const accessToken = await getFreshAccessToken();
    if (!accessToken) return { error: "Unable to get valid session token" };
    const resp = await fetch(`${GCP_SERVER_URL}/stripe/create-checkout`, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ pack }),
    });
    const data = await resp.json();
    if (!resp.ok) return { error: data.error || "Checkout failed" };
    await safeOpenExternal(data.url);
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

//  IPC: Mock Purchase 
ipcMain.handle("credits:mockPurchase", async (_e, packId) => {
  const local = db.getSession();
  if (!local) return { error: "Not logged in" };
  try {
    const accessToken = await getFreshAccessToken();
    if (!accessToken) return { error: "Unable to get valid session token" };
    const resp = await fetch(`${GCP_SERVER_URL}/mock/purchase`, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ pack_id: packId }),
    });
    const data = await resp.json();
    if (!resp.ok) return { error: data.error || "Mock purchase failed" };
    // Update local balance immediately
    if (typeof data.new_balance === "number") {
      db.setCredits(data.new_balance);
      BrowserWindow.getAllWindows().forEach((w) => {
        if (!w.isDestroyed()) w.webContents.send("credits:updated", data.new_balance);
      });
    }
    return data;
  } catch (err) {
    return { error: err.message };
  }
});

//  IPC: Windows 

ipcMain.handle("app:openTopup",     () => openTopup());
ipcMain.handle("app:openDashboard", () => openDashboard());
ipcMain.handle("app:minimize",      () => { if (mainWin && !mainWin.isDestroyed()) mainWin.minimize(); });
ipcMain.handle("app:close",         () => { if (mainWin && !mainWin.isDestroyed()) mainWin.close(); });
ipcMain.handle("app:maximize",      () => {
  if (!mainWin || mainWin.isDestroyed()) return;
  if (mainWin.isMaximized()) mainWin.unmaximize(); else mainWin.maximize();
});

ipcMain.handle("app:info", () => ({
  version:  app.getVersion(),
  platform: process.platform,
  isDev,
  devBypass,
}));

ipcMain.handle("app:relaunch", () => {
  app.relaunch();
  app.exit(0);
});

ipcMain.handle("shell:openExternal", (_e, url) => safeOpenExternal(url));

//  IPC: Recording 

ipcMain.handle("recording:save", async (_e, dataArray, filename) => {
  const win = mainWin;
  if (!win || win.isDestroyed()) return { error: "No window" };
  const { filePath, canceled } = await dialog.showSaveDialog(win, {
    title:       "Save Recording",
    defaultPath: filename || "loqii-recording.webm",
    filters:     [{ name: "WebM Video", extensions: ["webm"] }],
  });
  if (canceled || !filePath) return { cancelled: true };
  try {
    fs.writeFileSync(filePath, Buffer.from(dataArray));
    return { saved: true, path: filePath };
  } catch (err) {
    return { error: err.message };
  }
});

//  IPC: Preferences 

ipcMain.handle("prefs:get", (_e, key, defaultValue) => db.getPreference(key, defaultValue ?? null));
ipcMain.handle("prefs:set", (_e, key, value) => { db.setPreference(key, value); return { ok: true }; });

// DEV BYPASS  remove before shipping
ipcMain.handle("auth:devBypass", () => {
  if (!devBypass) return { error: "Not in dev mode" };
  db.seedDevSession();
  showMainApp();
  return { ok: true };
});

//  Auto-updater 
function setupAutoUpdater() {
  if (isDev) return;
  const updater = getAutoUpdater();
  if (!updater) return;
  updater.checkForUpdatesAndNotify();
  updater.on("update-downloaded", () => {
    BrowserWindow.getAllWindows().forEach((w) => {
      if (!w.isDestroyed()) w.webContents.send("app:update-ready");
    });
  });
}

//  App lifecycle 
app.whenReady().then(async () => {
  if (!startupConfig.ok) {
    console.error("[STARTUP] Configuration unavailable:", startupConfig.missing.join(", "));
    dialog.showMessageBoxSync({
      type: "error",
      title: "Configuration unavailable",
      message: "Loqii cannot start because required configuration is unavailable.",
      detail: isDevelopment() ? `Missing: ${startupConfig.missing.join(", ")}` : "Contact support if this persists.",
      buttons: ["Exit"],
    });
    app.exit(1);
    return;
  }
  console.log("[STARTUP] Loqii environment:", startupConfig.environment);
  console.log("[STARTUP] Config valid:", startupConfig.ok ? "yes" : "no");
  console.log("[STARTUP] Dev bypass:", devBypass ? "enabled" : "disabled");
  // Start local Express server (serves index.html + authenticated Decart client-token proxy)
  try {
    await startExpress();
  } catch (err) {
    console.error("[STARTUP] Local service failed:", err?.code || err?.message || err);
    dialog.showMessageBoxSync({
      type: "error",
      title: "Service temporarily unavailable",
      message: "Loqii cannot start because local services are unavailable.",
      detail: isDevelopment() ? String(err?.message || err) : "Contact support if this persists.",
      buttons: ["Exit"],
    });
    app.exit(1);
    return;
  }

  // Give Express a moment to bind
  await new Promise((r) => setTimeout(r, 400));

  createTray();
  buildAppMenu();
  setupAutoUpdater();
  await showRestoredSessionOrLogin();
});

app.on("window-all-closed", () => {
  gracefulShutdown("window-all-closed").catch((err) => {
    console.error("[SHUTDOWN] window-all-closed failed:", err.message);
    app.exit(1);
  });
});

app.on("activate", () => {
  // macOS: re-create window if dock icon clicked and no windows are open
  if (BrowserWindow.getAllWindows().length === 0) {
    showRestoredSessionOrLogin().catch(() => showLoginScreen());
  }
});

app.on("before-quit", (event) => {
  if (isQuitting) return;
  event.preventDefault();
  gracefulShutdown("before-quit").catch((err) => {
    console.error("[SHUTDOWN] before-quit failed:", err.message);
    app.exit(1);
  });
});

