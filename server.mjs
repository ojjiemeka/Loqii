/**
 * server.mjs - Local Express server  (ES Module)
 *
 * Runs embedded inside Electron on port 3000 (default).
 * Serves static assets + the Decart API token proxy.
 *
 * Auth and payments are handled by the GCP server (gcp-server.js).
 * The Decart API key is NEVER stored locally - always fetched from GCP.
 *
 * Routes:
 *   GET  /                -> index.html  (main face-swap app)
 *   GET  /obs             -> obs.html
 *   GET  /login.html      -> login.html
 *   GET  /signup.html     -> signup.html
 *   GET  /topup.html      -> topup.html
 *   GET  /dashboard.html  -> dashboard.html
 *   GET  /api/token       -> Decart API key proxied from GCP (cached 5 min)
 *   GET  /api/key         -> alias of /api/token (standalone compat)
 */

import "dotenv/config";
import express              from "express";
import path                 from "path";
import { fileURLToPath }    from "url";
import { WebSocketServer }  from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

function runtimeEnvironment() {
  const raw = String(process.env.LOQII_ENV || process.env.TZURAH_ENV || process.env.NODE_ENV || "development").toLowerCase();
  return ["production", "staging", "development"].includes(raw) ? raw : "development";
}

export function isDevelopment() { return runtimeEnvironment() === "development"; }
export function isStaging() { return runtimeEnvironment() === "staging"; }
export function isProduction() { return runtimeEnvironment() === "production"; }

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

function validateLocalServerConfig() {
  const generated = [];
  ensureDevelopmentSecret("BOOTSTRAP_SECRET", "dev-bootstrap-secret", generated);
  ensureDevelopmentSecret("INTERNAL_SECRET", "dev-internal-secret", generated);
  const missing = [];
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
  if (missing.length) {
    const error = new Error(`Configuration unavailable: ${missing.join(", ")}`);
    error.code = "CONFIG_INVALID";
    throw error;
  }
  if (generated.length) console.log("[CONFIG] Using development-only generated internal secrets");
  return {
    environment: runtimeEnvironment(),
    gcpServerUrl,
    bootstrapSecret: envValue("BOOTSTRAP_SECRET", { required: true }),
    internalSecret: envValue("INTERNAL_SECRET", { required: true }),
  };
}

function validateBootstrapPayload(payload) {
  const missing = [];
  if (!payload || typeof payload !== "object") missing.push("bootstrap payload");
  if (!payload?.supabase_url) missing.push("supabase_url");
  if (!payload?.supabase_anon_key) missing.push("supabase_anon_key");
  if (!payload?.gcp_server_url) missing.push("gcp_server_url");
  if (!payload?.feature_flags || typeof payload.feature_flags !== "object") missing.push("feature_flags");
  if (missing.length) {
    const error = new Error(`Configuration unavailable: ${missing.join(", ")}`);
    error.code = "BOOTSTRAP_INVALID";
    throw error;
  }
}

let localServerConfig = validateLocalServerConfig();

// Bootstrap config (fetched from GCP, never on disk)
const GCP_URL      = localServerConfig.gcpServerUrl;
const APP_SECRET   = localServerConfig.bootstrapSecret;
const INTERNAL_SECRET = localServerConfig.internalSecret;
let appConfig      = null; // in-memory only
let configDegraded = false;
let configDegradedReason = "";
let oauthCallbackHandler = null;

const SAFE_DEV_FEATURE_FLAGS = Object.freeze({
  show_onboarding: true,
  onboarding_dev_only: false,
  onboarding_required: false,
  enable_google_oauth: false,
  enable_help_center: true,
  enable_light_mode: true,
  enable_scene_engine: true,
  enable_style_engine: true,
  enable_background_mode: true,
  enable_topup_flow: true,
  enable_real_payments: false,
  enable_mock_payments: false,
  mock_payments: false,
  enable_dev_tools: false,
  enable_advanced_diagnostics: false,
  enable_prompt_debug: false,
  enable_session_debug: false,
  enable_performance_metrics: false,
  enable_oauth_debug: false,
  enable_reconnect_debug: false,
});

function markConfigDegraded(reason) {
  configDegraded = true;
  configDegradedReason = reason || "backend bootstrap unavailable";
}

function isConfigDegraded() {
  return configDegraded === true;
}

function safeDevBootstrapConfig(reason) {
  return {
    ok: false,
    degraded: true,
    degraded_reason: reason || "backend bootstrap unavailable",
    supabase_url: "",
    supabase_anon_key: "",
    gcp_server_url: GCP_URL,
    feature_flags: { ...SAFE_DEV_FEATURE_FLAGS },
    app_flags: { ...SAFE_DEV_FEATURE_FLAGS },
    credit_packs: [],
    burn_rate: 2.18,
    free_credits_on_signup: 6,
    app_version: "dev",
  };
}

async function safeErrorFromResponse(res) {
  try {
    const data = await res.clone().json();
    const code = data?.code || data?.error_code || data?.error || `HTTP_${res.status}`;
    const reason = data?.reason || data?.message || data?.error_description || data?.error || "request rejected";
    return { code: String(code).slice(0, 80), reason: String(reason).slice(0, 160) };
  } catch {
    return { code: `HTTP_${res.status}`, reason: res.statusText || "request rejected" };
  }
}

export function setOAuthCallbackHandler(handler) {
  oauthCallbackHandler = typeof handler === "function" ? handler : null;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function oauthMessageFor(payload = {}) {
  if (payload.error_code === "user_banned") return "This account is banned.";
  return payload.error_description || payload.error || "Authentication failed.";
}

function hasOAuthPayload(payload = {}) {
  return Boolean(
    payload.error ||
    payload.error_code ||
    payload.error_description ||
    payload.access_token ||
    payload.refresh_token ||
    payload.code
  );
}

function sanitizeOAuthPayload(payload = {}) {
  return {
    error: payload.error || null,
    error_code: payload.error_code || null,
    error_description: payload.error_description || null,
    access_token: payload.access_token || null,
    refresh_token: payload.refresh_token || null,
    code: payload.code || null,
  };
}

function dispatchOAuthCallback(payload) {
  if (!oauthCallbackHandler) {
    console.warn("[OAUTH] Callback received before Electron handler was registered");
    return;
  }
  try {
    oauthCallbackHandler(sanitizeOAuthPayload(payload));
  } catch (err) {
    console.warn("[OAUTH] Callback handler failed:", err?.message || err);
  }
}

function oauthCallbackPage(payload = {}) {
  const failed = Boolean(payload.error || payload.error_code);
  const message = failed
    ? `Authentication failed: ${oauthMessageFor(payload)}`
    : "Authentication complete. You can return to Loqii.";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Loqii Authentication</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #011627;
      color: #F7F3E3;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: min(480px, calc(100vw - 32px));
      border: 1px solid rgba(247, 243, 227, 0.16);
      border-radius: 16px;
      padding: 28px;
      background: rgba(1, 22, 39, 0.92);
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.35);
      text-align: center;
    }
    h1 { margin: 0 0 10px; font-size: 1.25rem; }
    p { margin: 0; color: rgba(247, 243, 227, 0.78); line-height: 1.5; }
  </style>
</head>
<body>
  <main>
    <h1>${failed ? "Authentication failed" : "Authentication received"}</h1>
    <p id="message">${escapeHtml(message)}</p>
  </main>
  <script>
    (async () => {
      const params = new URLSearchParams(window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash);
      const payload = Object.fromEntries(params.entries());
      if (payload.error || payload.error_code || payload.error_description || payload.access_token || payload.refresh_token || payload.code) {
        history.replaceState(null, "", window.location.pathname + window.location.search);
        try {
          await fetch("/oauth/callback", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });
          const banned = payload.error_code === "user_banned";
          document.getElementById("message").textContent = banned
            ? "Authentication failed: This account is banned."
            : payload.error
              ? "Authentication failed. You can return to Loqii."
              : "Authentication complete. You can return to Loqii.";
        } catch {
          document.getElementById("message").textContent = "Authentication complete. Return to Loqii to continue.";
        }
      }
    })();
  </script>
</body>
</html>`;
}

function handleOAuthBrowserCallback(req, res) {
  const payload = sanitizeOAuthPayload(req.method === "POST" ? req.body : req.query);
  if (hasOAuthPayload(payload)) dispatchOAuthCallback(payload);
  res
    .status(payload.error || payload.error_code ? 400 : 200)
    .setHeader("Cache-Control", "no-store")
    .send(oauthCallbackPage(payload));
}

async function fetchBootstrap() {
  const endpoint = "/api/bootstrap";
  const url = `${GCP_URL}${endpoint}`;
  try {
    const res = await fetch(url, {
      headers: { "x-app-secret": APP_SECRET },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const safe = await safeErrorFromResponse(res);
      console.error(`[BOOTSTRAP] Failed endpoint=${endpoint} status=${res.status} code=${safe.code} reason=${safe.reason}`);
      return false;
    }
    appConfig = await res.json();
    validateBootstrapPayload(appConfig);
    configDegraded = false;
    configDegradedReason = "";
    console.log("[BOOTSTRAP] Environment:", runtimeEnvironment());
    console.log("[BOOTSTRAP] Config loaded successfully");
    console.log("[BOOTSTRAP] Supabase URL:", appConfig.supabase_url ? "configured" : "missing");
    console.log("[BOOTSTRAP] Anon key:", appConfig.supabase_anon_key ? "configured" : "missing");
    console.log("[BOOTSTRAP] Feature flags:", Object.keys(appConfig.feature_flags || {}).length, "flags");
    console.log("[BOOTSTRAP] Credit packs:", (appConfig.credit_packs || []).length, "packs");
    return true;
  } catch (err) {
    const code = err?.name === "TimeoutError" ? "BOOTSTRAP_TIMEOUT" : (err?.code || "BOOTSTRAP_NETWORK_OR_PARSE_ERROR");
    console.error(`[BOOTSTRAP] Failed endpoint=${endpoint} status=none code=${code} reason=${err?.message || "request failed"}`);
    return false;
  }
}

let _bootstrapTimerStarted = false;
let _bootstrapRefreshTimer = null;

async function bootstrapWithRetry(maxAttempts = 5) {
  for (let i = 0; i < maxAttempts; i++) {
    if (await fetchBootstrap()) {
      // Start 30-minute refresh timer only once, anchored to first success
      if (!_bootstrapTimerStarted) {
        _bootstrapTimerStarted = true;
        _bootstrapRefreshTimer = setInterval(() => {
          console.log("[BOOTSTRAP] Refreshing config...");
          fetchBootstrap().catch(() => {});
        }, 30 * 60 * 1000);
      }
      return true;
    }
    if (i < maxAttempts - 1) {
      console.log(`[BOOTSTRAP] Retry ${i + 1}/${maxAttempts - 1} in 3s...`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  const reason = `backend bootstrap unavailable after ${maxAttempts} attempts`;
  markConfigDegraded(reason);
  console.error("[BOOTSTRAP] Could not reach backend after", maxAttempts, "attempts");
  if (isDevelopment()) {
    appConfig = safeDevBootstrapConfig(reason);
    console.warn("[BOOTSTRAP] Development degraded mode: using local safe defaults");
  }
  return false;
}

// Token cache (avoids hitting GCP on every renderer request)
let _cachedRawDecartKey   = null;
let _rawDecartKeyCachedAt = 0;
const TOKEN_CACHE_MS = 5 * 60 * 1000; // 5 minutes

async function fetchTokenFromGCP() {
  const gcpUrl = (appConfig?.gcp_server_url) || GCP_URL;
  const gcpRes = await fetch(`${gcpUrl}/internal/decart-key`, {
    headers: { "x-internal-secret": INTERNAL_SECRET },
    signal: AbortSignal.timeout(8000),
  });
  if (!gcpRes.ok) throw new Error(`GCP token fetch failed: ${gcpRes.status}`);
  const data = await gcpRes.json();
  if (!data.token) throw new Error("GCP returned no token");
  return data.token;
}

// Build Express app
function buildApp() {
  const app = express();
  app.use(express.json());

  // public/ contains sdk-bundle.js (built by `npm run build`)
  app.use(express.static(path.join(__dirname, "public")));
  // Root static - serves assets, SDK entry, etc.
  app.use(express.static(__dirname, { index: false }));

  // HTML pages

  // Main face-swap app (requires login - index.html checks session via IPC)
  app.get("/", (req, res) => {
    if (hasOAuthPayload(req.query)) return handleOAuthBrowserCallback(req, res);
    return res.sendFile(path.join(__dirname, "index.html"));
  });
  app.get("/auth/callback", handleOAuthBrowserCallback);
  app.get("/oauth/callback", handleOAuthBrowserCallback);
  app.post("/oauth/callback", handleOAuthBrowserCallback);
  app.get("/obs",            (_req, res) => res.sendFile(path.join(__dirname, "obs.html")));

  // Auth screens (also loadFile'd by Electron, but served here for completeness)
  app.get("/login.html",     (_req, res) => res.sendFile(path.join(__dirname, "login.html")));
  app.get("/signup.html",    (_req, res) => res.sendFile(path.join(__dirname, "signup.html")));
  app.get("/topup.html",     (_req, res) => res.sendFile(path.join(__dirname, "topup.html")));
  app.get("/dashboard.html", (_req, res) => res.sendFile(path.join(__dirname, "dashboard.html")));

  // /api/token + /api/key - proxy Decart key from GCP
  // Key is NEVER stored locally. Fetched from GCP and cached for 5 min.
  // Falls back to stale cache if GCP is unreachable.
  async function handleTokenRequest(_req, res) {
    try {
      const bust = parseInt(process.env.TOKEN_CACHE_BUSTED || "0");
      if (_cachedRawDecartKey && Date.now() - _rawDecartKeyCachedAt < TOKEN_CACHE_MS && _rawDecartKeyCachedAt > bust) {
        return res.json({ apiKey: _cachedRawDecartKey });
      }
      const token = await fetchTokenFromGCP();
      _cachedRawDecartKey   = token;
      _rawDecartKeyCachedAt = Date.now();
      console.log("[TOKEN] Fresh key fetched from GCP and cached");
      return res.json({ apiKey: _cachedRawDecartKey });
    } catch (err) {
      console.error("[TOKEN] Proxy error:", err.message);
      if (_cachedRawDecartKey) {
        console.warn("[TOKEN] Returning stale cached key as fallback");
        return res.json({ apiKey: _cachedRawDecartKey });
      }
      return res.status(503).json({ error: "Could not fetch API token from GCP" });
    }
  }

  app.get("/api/token", handleTokenRequest);
  app.get("/api/key",   handleTokenRequest);

  // /decart/token - proxies user-authed request to GCP
  // Requires Authorization: Bearer <supabase-access-token> from the renderer.
  // GCP validates the JWT and returns the Decart API token.
  // TODO: cache is keyed on a single slot - fine for single-user Electron,
  //       but a multi-user server deployment would need per-user caching.
  app.get("/decart/token", async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: "No authorization header" });
    }
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");

    try {
      const gcpUrl = (appConfig?.gcp_server_url) || GCP_URL;
      const gcpRes = await fetch(`${gcpUrl}/decart/token`, {
        headers: {
          "Authorization":  authHeader,
          "Content-Type":   "application/json",
          "Cache-Control":   "no-store",
        },
        signal: AbortSignal.timeout(5000),
      });

      if (!gcpRes.ok) {
        const err = await gcpRes.json().catch(() => ({}));
        return res.status(gcpRes.status).json(err);
      }

      const data = await gcpRes.json();
      console.log("[TOKEN] GCP response fields:", Object.keys(data));
      if (data.decart_environment_used || data.decart_reason) {
        console.log("[TOKEN] Decart environment:", data.decart_environment_used || "unknown", data.decart_reason || "");
      }

      const token = data.token || data.apiKey || data.api_key ||
                    data.key || data.data?.token || data.access_token || null;

      console.log("[TOKEN] Extracted token:", token ? "present" : "missing");

      if (!token) {
        console.error("[TOKEN] Could not find token in GCP response:", Object.keys(data));
        return res.status(503).json({
          error: "No token in GCP response. Fields: " + Object.keys(data).join(", "),
        });
      }

      return res.json({
        token,
        decart_environment_used: data.decart_environment_used || data.environment || null,
        decart_reason: data.decart_reason || data.reason || null,
        decart_test_user: data.decart_test_user === true,
      });

    } catch (err) {
      console.error("[DECART TOKEN] Fetch failed:", err.code || err.message);
      return res.status(503).json({ error: "Service temporarily unavailable" });
    }
  });

  // /api/config - expose bootstrap config to renderer
  app.get("/api/config", (_req, res) => {
    if (!appConfig && isDevelopment()) {
      const reason = configDegradedReason || "backend bootstrap unavailable";
      markConfigDegraded(reason);
      appConfig = safeDevBootstrapConfig(reason);
    }
    if (!appConfig) return res.status(503).json({ error: "Configuration unavailable" });
    return res.json({
      ok: !isConfigDegraded(),
      degraded: isConfigDegraded(),
      degraded_reason: isDevelopment() ? configDegradedReason : undefined,
      supabase_url:           appConfig.supabase_url,
      supabase_anon_key:      appConfig.supabase_anon_key,
      gcp_server_url:         appConfig.gcp_server_url,
      feature_flags:          appConfig.feature_flags,
      app_flags:              appConfig.app_flags || appConfig.feature_flags,
      credit_packs:           appConfig.credit_packs,
      burn_rate:              appConfig.burn_rate,
      free_credits_on_signup: appConfig.free_credits_on_signup,
      app_version:            appConfig.app_version,
    });
  });

  // /mock/purchase - proxy to GCP (localhost-only, Electron test mode)
  app.get("/api/app-config", async (req, res) => {
    if (!appConfig && isDevelopment()) {
      const reason = configDegradedReason || "backend app config unavailable";
      markConfigDegraded(reason);
      appConfig = safeDevBootstrapConfig(reason);
    }
    if (!appConfig) return res.status(503).json({ error: "Configuration unavailable" });
    try {
      const gcpUrl = (appConfig?.gcp_server_url) || GCP_URL;
      const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
      if (req.headers.authorization) headers.Authorization = req.headers.authorization;
      const gcpRes = await fetch(`${gcpUrl}/api/app-config`, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      if (!gcpRes.ok) throw new Error(`GCP app config failed: ${gcpRes.status}`);
      return res.json(await gcpRes.json());
    } catch (err) {
      console.warn("[APP CONFIG] Falling back to safe flags:", err.message);
      return res.json({
        ok: false,
        degraded: isConfigDegraded(),
        degraded_reason: isDevelopment() ? (configDegradedReason || "backend app config unavailable") : undefined,
        feature_flags: appConfig.feature_flags || { ...SAFE_DEV_FEATURE_FLAGS },
        app_flags: appConfig.app_flags || appConfig.feature_flags || { ...SAFE_DEV_FEATURE_FLAGS },
        is_dev_account: false,
        environment: isDevelopment() ? "development_degraded" : "bootstrap_fallback",
      });
    }
  });

  app.post("/mock/purchase", async (req, res) => {
    if (isProduction() && !(appConfig?.feature_flags?.enable_mock_payments || appConfig?.feature_flags?.mock_payments)) {
      return res.status(403).json({ error: "Service temporarily unavailable" });
    }
    try {
      const gcpUrl = (appConfig?.gcp_server_url) || GCP_URL;
      const gcpRes = await fetch(`${gcpUrl}/mock/purchase`, {
        method:  "POST",
        headers: {
          "Content-Type": "application/json",
          ...(req.headers.authorization ? { "Authorization": req.headers.authorization } : {}),
        },
        body: JSON.stringify(req.body),
      });
      const data = await gcpRes.json();
      return res.status(gcpRes.status).json(data);
    } catch (err) {
      console.error("[mock/purchase proxy]", err?.message || err);
      return res.status(500).json({ error: "Service temporarily unavailable" });
    }
  });

  return app;
}

// OBS WebSocket relay
// Pushers (Electron) send frames; viewers (OBS browser source) receive them.
function attachObsWebSocket(httpServer) {
  const wss     = new WebSocketServer({ server: httpServer });
  const pushers = new Set();
  const viewers = new Set();
  httpServer.__tzurahObsWss = wss;

  wss.on("connection", (ws) => {
    let identified = false;

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      // First message identifies the client role
      if (!identified) {
        identified = true;
        if (msg.type === "obs-push") {
          pushers.add(ws);
        } else if (msg.type === "obs-source") {
          viewers.add(ws);
        }
        return;
      }

      // Subsequent messages from pushers relay to all viewers
      if (pushers.has(ws) && msg.type === "frame") {
        const payload = JSON.stringify(msg);
        for (const viewer of viewers) {
          if (viewer.readyState === viewer.OPEN) {
            viewer.send(payload);
          }
        }
      }
    });

    ws.on("close", () => {
      pushers.delete(ws);
      viewers.delete(ws);
    });

    ws.on("error", () => ws.close());
  });
  return wss;
}

// startServer - called by electron.js
export async function startServer(port) {
  localServerConfig = validateLocalServerConfig();
  if (isProduction()) {
    const ok = await bootstrapWithRetry(3);
    if (!ok) {
      const error = new Error("Configuration unavailable");
      error.code = "BOOTSTRAP_UNAVAILABLE";
      throw error;
    }
  }
  // Start listening FIRST so Electron can load index.html immediately.
  // /api/config returns 503 while bootstrap is in progress; bootstrapApp()
  // in index.html retries until it gets a 200.
  const expressApp = buildApp();
  const server = await new Promise((resolve) => {
    const s = expressApp.listen(port, () => {
      console.log("===============================================");
      console.log("  Loqii - Local Express Server  [Electron mode]");
      console.log(`  http://localhost:${port}`);
      console.log("-----------------------------------------------");
      console.log("  GET /api/config -> bootstrap config for renderer");
      console.log("  GET /api/token  -> Decart key (proxied from backend)");
      console.log("  GET /           -> index.html");
      console.log("  WS  /           -> OBS frame relay");
      console.log("===============================================\n");
      resolve(s);
    });
  });
  attachObsWebSocket(server);

  // Bootstrap in background - renderer retries /api/config until ready
  if (!isProduction()) bootstrapWithRetry(5).catch(() => {});

  return server;
}

export async function shutdownServer(server) {
  if (_bootstrapRefreshTimer) {
    clearInterval(_bootstrapRefreshTimer);
    _bootstrapRefreshTimer = null;
    _bootstrapTimerStarted = false;
  }

  const wss = server?.__tzurahObsWss;
  if (wss) {
    for (const client of wss.clients) {
      try { client.close(); } catch {}
      try { client.terminate(); } catch {}
    }
    await new Promise((resolve) => wss.close(() => resolve()));
    server.__tzurahObsWss = null;
  }

  if (server?.listening) {
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

// Standalone (npm start / node server.mjs)
const isMain = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(__filename);

if (isMain) {
  const PORT = parseInt(process.env.EXPRESS_PORT || process.env.PORT || "3000", 10);
  const standaloneServer = buildApp().listen(PORT, () => {
    console.log("===============================================");
    console.log("  Loqii - Decart AI Face Swap  [standalone]");
    console.log(`  http://localhost:${PORT}`);
    console.log("===============================================\n");
  });
  attachObsWebSocket(standaloneServer);
}
