/**
 * db.js — Local SQLite cache  (CommonJS)
 *
 * Stores Supabase session tokens + a local credit cache so the UI
 * stays responsive even if the GCP server is briefly unreachable.
 *
 * All writes are synchronous (better-sqlite3).
 * Called only from the Electron main process — never from the renderer.
 */

"use strict";

const Database = require("better-sqlite3");
const path     = require("path");
const { app }  = require("electron");

let _db = null;

function getDB() {
  if (_db) return _db;

  const dbPath = path.join(app.getPath("userData"), "rtdf-local.db");
  _db = new Database(dbPath);
  _db.pragma("journal_mode = WAL");

  _db.exec(`
    CREATE TABLE IF NOT EXISTS session (
      id                 INTEGER PRIMARY KEY CHECK (id = 1),
      user_id            TEXT,
      email              TEXT,
      display_name       TEXT,
      avatar_url         TEXT,
      credits_remaining  INTEGER DEFAULT 0,
      total_credits_used INTEGER DEFAULT 0,
      access_token       TEXT,
      refresh_token      TEXT,
      last_synced        INTEGER
    );

    CREATE TABLE IF NOT EXISTS usage_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      session_seconds INTEGER,
      credits_used    INTEGER,
      started_at      INTEGER,
      ended_at        INTEGER,
      synced          INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS preferences (
      key        TEXT PRIMARY KEY,
      value      TEXT,
      updated_at INTEGER
    );
  `);

  return _db;
}

// ── Session ──────────────────────────────────────────────────────────

/** Returns the cached session row, or null if logged out. */
function getSession() {
  return getDB().prepare("SELECT * FROM session WHERE id = 1").get() || null;
}

/**
 * Saves (or replaces) the local session cache.
 * @param {object} data  Shape: { user_id, email, display_name, avatar_url,
 *                                credits_remaining, access_token, refresh_token }
 */
function saveSession(data) {
  const existing = getSession();
  getDB().prepare(`
    INSERT INTO session
      (id, user_id, email, display_name, avatar_url,
       credits_remaining, total_credits_used, access_token, refresh_token, last_synced)
    VALUES (1, @user_id, @email, @display_name, @avatar_url,
            @credits_remaining, @total_credits_used, @access_token, @refresh_token, @last_synced)
    ON CONFLICT (id) DO UPDATE SET
      user_id            = excluded.user_id,
      email              = excluded.email,
      display_name       = excluded.display_name,
      avatar_url         = excluded.avatar_url,
      credits_remaining  = excluded.credits_remaining,
      total_credits_used = excluded.total_credits_used,
      access_token       = excluded.access_token,
      refresh_token      = excluded.refresh_token,
      last_synced        = excluded.last_synced
  `).run({
    user_id:            data.user_id            || "",
    email:              data.email              || "",
    display_name:       data.display_name       || "",
    avatar_url:         data.avatar_url         || null,
    credits_remaining:  data.credits_remaining  ?? (existing?.credits_remaining ?? 0),
    total_credits_used: data.total_credits_used ?? (existing?.total_credits_used ?? 0),
    access_token:       data.access_token       || null,
    refresh_token:      data.refresh_token      || null,
    last_synced:        data.last_synced        ?? Date.now(),
  });
}

/** Clears the local session (logout). */
function clearSession() {
  getDB().prepare("DELETE FROM session WHERE id = 1").run();
}

/**
 * Deducts credits from the local cache immediately (for smooth UX).
 * The GCP server is the source of truth — always sync after this.
 * @returns {number} New credits_remaining.
 */
function deductCredits(credits) {
  const db  = getDB();
  const row = db.prepare(
    "SELECT credits_remaining, total_credits_used FROM session WHERE id = 1"
  ).get();
  if (!row) return 0;
  const newBalance = Math.max(0, row.credits_remaining - credits);
  const newUsed    = (row.total_credits_used || 0) + credits;
  db.prepare(
    "UPDATE session SET credits_remaining = ?, total_credits_used = ? WHERE id = 1"
  ).run(newBalance, newUsed);
  return newBalance;
}

/**
 * Sets the authoritative credit balance from the server.
 * @returns {number} The new balance.
 */
function setCredits(credits) {
  getDB().prepare(
    "UPDATE session SET credits_remaining = ?, last_synced = ? WHERE id = 1"
  ).run(credits, Date.now());
  return credits;
}

// ── Usage log ─────────────────────────────────────────────────────────

/**
 * Records a completed session segment for later sync.
 * @param {number} seconds  Duration in seconds.
 * @param {number} credits  Credits consumed (seconds × 0.1).
 */
function logUsage(seconds, credits) {
  const now = Date.now();
  getDB().prepare(`
    INSERT INTO usage_log (session_seconds, credits_used, started_at, ended_at)
    VALUES (?, ?, ?, ?)
  `).run(seconds, credits, now - seconds * 1000, now);
}

/** Returns all usage_log rows not yet synced to the GCP server. */
function getUnsyncedUsage() {
  return getDB().prepare("SELECT * FROM usage_log WHERE synced = 0").all();
}

/** Marks the given row ids as synced. */
function markSynced(ids) {
  if (!ids || ids.length === 0) return;
  const ph = ids.map(() => "?").join(",");
  getDB().prepare(`UPDATE usage_log SET synced = 1 WHERE id IN (${ph})`).run(...ids);
}

// ── Preferences ───────────────────────────────────────────────────────

function setPreference(key, value) {
  getDB().prepare(`
    INSERT OR REPLACE INTO preferences (key, value, updated_at) VALUES (?, ?, ?)
  `).run(key, String(value), Date.now());
}

function getPreference(key, defaultValue = null) {
  const row = getDB().prepare("SELECT value FROM preferences WHERE key = ?").get(key);
  return row ? row.value : defaultValue;
}

// ── Dev bypass — remove before shipping ──────────────────────────────

/**
 * Seeds a fake authenticated session so auth/credit checks pass
 * in dev mode without hitting Supabase. No-op if session exists.
 */
function seedDevSession() {
  if (getSession()) return;
  saveSession({
    user_id:            "dev-user-001",
    email:              "dev@tzurah.ai",
    display_name:       "Dev User",
    avatar_url:         null,
    credits_remaining:  99999,
    total_credits_used: 0,
    access_token:       "placeholder-token",
    refresh_token:      "placeholder-refresh",
    last_synced:        Date.now(),
  });
}

// ── Token validation ──────────────────────────────────────────────────

/**
 * Validates a raw (decrypted) JWT access token.
 *
 * @param {string} rawToken           The decrypted JWT string (eyJ...).
 * @param {number} minSecondsRemaining  Reject if fewer than this many seconds remain (default 0).
 * @returns {boolean}  true = structurally valid JWT that has not yet expired.
 */
function validateToken(rawToken, minSecondsRemaining = 0) {
  if (!rawToken || typeof rawToken !== "string") return false;
  const parts = rawToken.split(".");
  if (parts.length !== 3) return false;
  try {
    // Base64url → base64 → JSON
    const b64     = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    if (typeof payload.exp !== "number") return false;
    return (payload.exp - minSecondsRemaining) > (Date.now() / 1000);
  } catch {
    return false;
  }
}

// ── Exports ───────────────────────────────────────────────────────────
module.exports = {
  getDB,
  getSession,
  saveSession,
  clearSession,
  deductCredits,
  setCredits,
  logUsage,
  getUnsyncedUsage,
  markSynced,
  seedDevSession,
  validateToken,
  setPreference,
  getPreference,
};
