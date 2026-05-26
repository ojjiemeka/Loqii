/**
 * preload.js — Electron preload script  (CommonJS)
 *
 * Exposes a typed, narrow IPC surface to the renderer via contextBridge.
 * The renderer accesses everything through window.tzurah — no direct Node.js
 * or Electron access from browser-side code.
 */

"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("tzurah", {

  // ── Auth ────────────────────────────────────────────────────────

  /** Sign up with email + password. Returns { ok, user?, confirmRequired?, error? } */
  signup: (email, password, displayName) =>
    ipcRenderer.invoke("auth:signup", email, password, displayName),

  /** Sign in with email + password. Returns { ok, user?, error? } */
  login: (email, password) =>
    ipcRenderer.invoke("auth:login", email, password),

  /** Opens Google OAuth in the system browser, resolves when deep link returns.
   *  Returns { ok, user?, error? } */
  googleAuth: () =>
    ipcRenderer.invoke("auth:google"),

  /** Signs out and returns to the login screen. */
  logout: () =>
    ipcRenderer.invoke("auth:logout"),

  /** Returns the local session cache (no tokens). Null if not logged in. */
  getSession: () =>
    ipcRenderer.invoke("auth:getSession"),

  /** Returns a fresh Supabase access token (auto-refreshed). Null if not logged in. */
  getAccessToken: () =>
    ipcRenderer.invoke("auth:getAccessToken"),

  // ── Credits ─────────────────────────────────────────────────────

  /** Fetches authoritative credit balance from Supabase. Returns { credits }. */
  getBalance: () =>
    ipcRenderer.invoke("credits:getBalance"),

  /** Deducts credits locally then syncs to GCP. Returns { remaining }.
   *  @param {number} credits   Credits to deduct (seconds × 0.1).
   *  @param {number} seconds   Session duration in seconds for the usage log. */
  deductCredits: (credits, seconds, metadata = null) =>
    ipcRenderer.invoke("credits:deduct", credits, seconds, metadata),

  /** Uploads unsynced local usage logs to GCP. Returns { ok }. */
  syncUsage: (metadata = null) =>
    ipcRenderer.invoke("credits:sync", metadata),

  /** Fetches last 10 purchases from Supabase. Returns { purchases }. */
  getPurchases: () =>
    ipcRenderer.invoke("credits:getPurchases"),

  // ── Stripe ──────────────────────────────────────────────────────

  /** Opens a Stripe Checkout session in the system browser.
   *  @param {string} pack  One of: starter|basic|standard|pro|ultra|max */
  checkout: (pack) =>
    ipcRenderer.invoke("stripe:checkout", pack),

  /** Mock purchase for testing — adds credits without Stripe.
   *  Only works when mock_payments feature flag is enabled on the server.
   *  @param {string} packId  UUID of the credit_packs row */
  mockPurchase: (packId) =>
    ipcRenderer.invoke("credits:mockPurchase", packId),

  // ── Windows ─────────────────────────────────────────────────────

  /** Opens the top-up (credit purchase) modal window. */
  openTopup: () =>
    ipcRenderer.invoke("app:openTopup"),

  /** Opens the account dashboard modal window. */
  openDashboard: () =>
    ipcRenderer.invoke("app:openDashboard"),

  /** Minimizes the main window. */
  minimize: () =>
    ipcRenderer.invoke("app:minimize"),

  /** Closes the main window. */
  closeApp: () =>
    ipcRenderer.invoke("app:close"),

  /** Toggles maximize / restore. */
  maximize: () =>
    ipcRenderer.invoke("app:maximize"),

  /** Opens a URL in the OS default browser. */
  openExternal: (url) =>
    ipcRenderer.invoke("shell:openExternal", url),

  // ── App info ────────────────────────────────────────────────────

  /** Returns { version, platform, isDev, devBypass }. */
  appInfo: () =>
    ipcRenderer.invoke("app:info"),

  /** Relaunches the Electron app. */
  relaunch: () =>
    ipcRenderer.invoke("app:relaunch"),

  // ── Recording ────────────────────────────────────────────────────

  /** Opens save dialog and writes recording blob to disk. */
  saveRecording: (dataArray, filename) =>
    ipcRenderer.invoke("recording:save", dataArray, filename),

  // ── Preferences ──────────────────────────────────────────────────

  /** Get a persisted local preference. Returns defaultValue if not set. */
  getPreference: (key, defaultValue) =>
    ipcRenderer.invoke("prefs:get", key, defaultValue),

  /** Set a persisted local preference. */
  setPreference: (key, value) =>
    ipcRenderer.invoke("prefs:set", key, value),

  // ── Dev bypass — remove before shipping ─────────────────────────

  /** Seeds a dev session and loads the main app without real auth. */
  devBypass: () =>
    ipcRenderer.invoke("auth:devBypass"),

  // ── Event subscriptions ─────────────────────────────────────────

  /**
   * Subscribe to events pushed from the main process.
   * Returns an unsubscribe function.
   *
   * Supported channels:
   *   "credits:updated"  → cb(newBalance: number)
   *   "payment:success"  → cb()
   *   "app:update-ready" → cb()
   */
  on: (channel, cb) => {
    const allowed = ["credits:updated", "payment:success", "app:update-ready", "window:maximized", "window:unmaximized", "oauth-result"];
    if (!allowed.includes(channel)) return () => {};
    const handler = (_event, ...args) => cb(...args);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
