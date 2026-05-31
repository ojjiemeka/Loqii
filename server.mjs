/**
 * server.mjs - Local Express server  (ES Module)
 *
 * Runs embedded inside Electron on port 3000 (default).
 * Serves static assets + the Decart client-token proxy.
 *
 * Auth and payments are handled by the GCP server (gcp-server.js).
 * Permanent Decart API keys are NEVER stored locally or returned to the renderer.
 *
 * Routes:
 *   GET  /                -> index.html  (main face-swap app)
 *   GET  /obs             -> obs.html
 *   GET  /login.html      -> login.html
 *   GET  /signup.html     -> signup.html
 *   GET  /topup.html      -> topup.html
 *   GET  /dashboard.html  -> dashboard.html
 *   GET  /api/token       -> authenticated Decart client-token compatibility route
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

const developmentGeneratedSecretNames = new Set();

function ensureDevelopmentSecret(name, devValue, generated) {
  if (process.env[name] && String(process.env[name]).trim()) {
    if (developmentGeneratedSecretNames.has(name)) generated.push(name);
    return;
  }
  if (!isDevelopment()) return;
  process.env[name] = devValue;
  developmentGeneratedSecretNames.add(name);
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
    generatedSecrets: new Set(generated),
  };
}

function usePrivilegedBootstrap() {
  if (isDevelopment()) {
    return String(process.env.LOQII_USE_PRIVILEGED_BOOTSTRAP || "").toLowerCase() === "true";
  }
  return true;
}

function privilegedBootstrapRequired() {
  return usePrivilegedBootstrap() && !isDevelopment();
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
let bootstrapSource = "pending";
let lastBootstrapFailure = null;
let startupHealthLogged = false;
let oauthCallbackHandler = null;

const SAFE_DEV_FEATURE_FLAGS = Object.freeze({
  show_onboarding: true,
  onboarding_dev_only: false,
  onboarding_required: false,
  enable_google_oauth: false,
  enable_help_center: true,
  enable_light_mode: true,
  enable_scene_engine: true,
  enable_scene_system: true,
  enable_style_engine: true,
  enable_style_system: true,
  enable_background_mode: true,
  enable_obs_tools: true,
  enable_beta_updater: false,
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
  bootstrapSource = isDevelopment() ? "local_dev_defaults" : "failed";
}

function isConfigDegraded() {
  return configDegraded === true;
}

function safeDevBootstrapConfig(reason) {
  bootstrapSource = "local_dev_defaults";
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

function publicConfigToAppConfig(payload = {}) {
  const flags = payload.public_flags && typeof payload.public_flags === "object"
    ? payload.public_flags
    : {};
  return {
    ok: true,
    degraded: false,
    degraded_reason: "",
    supabase_url: payload.supabase_url || "",
    supabase_anon_key: payload.supabase_anon_key || "",
    gcp_server_url: GCP_URL,
    feature_flags: { ...SAFE_DEV_FEATURE_FLAGS, ...flags },
    app_flags: { ...SAFE_DEV_FEATURE_FLAGS, ...flags },
    credit_packs: [],
    burn_rate: 2.18,
    free_credits_on_signup: 6,
    app_version: payload.app_version || "dev",
    app_name: payload.app_name || "Loqii",
    auth_providers: payload.auth_providers || { email: true, google: flags.enable_google_oauth === true },
    environment_label: payload.environment_label || runtimeEnvironment(),
  };
}

function logStartupHealthSummary() {
  if (startupHealthLogged) return;
  startupHealthLogged = true;
  console.log("[CONFIG] source:", bootstrapSource);
  console.log("[BOOTSTRAP] privileged bootstrap", usePrivilegedBootstrap() ? "enabled" : "skipped");
  console.log("[AUTH] Supabase public auth config", appConfig?.supabase_url && appConfig?.supabase_anon_key ? "available" : "unavailable");
  console.log("[DECART] client token requires authenticated user");
  console.log("[BILLING] server-owned");
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

async function fetchPublicConfig() {
  const endpoint = "/api/public-config";
  try {
    const res = await fetch(`${GCP_URL}${endpoint}`, {
      headers: { "Cache-Control": "no-store" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      const safe = await safeErrorFromResponse(res);
      lastBootstrapFailure = { status: res.status, code: safe.code, reason: safe.reason };
      console.warn(`[PUBLIC CONFIG] Failed endpoint=${endpoint} status=${res.status} code=${safe.code} reason=${safe.reason}`);
      return false;
    }
    const payload = await res.json();
    if (!payload?.success || !payload?.supabase_url || !payload?.supabase_anon_key) {
      lastBootstrapFailure = { status: null, code: "PUBLIC_CONFIG_INVALID", reason: "missing public config fields" };
      console.warn("[PUBLIC CONFIG] Failed endpoint=/api/public-config status=none code=PUBLIC_CONFIG_INVALID reason=missing public config fields");
      return false;
    }
    appConfig = publicConfigToAppConfig(payload);
    configDegraded = false;
    configDegradedReason = "";
    bootstrapSource = "public_config";
    lastBootstrapFailure = null;
    console.log("[CONFIG] public_config loaded");
    return true;
  } catch (err) {
    const code = err?.name === "TimeoutError" ? "PUBLIC_CONFIG_TIMEOUT" : (err?.code || "PUBLIC_CONFIG_NETWORK_OR_PARSE_ERROR");
    lastBootstrapFailure = { status: null, code, reason: err?.message || "request failed" };
    console.warn(`[PUBLIC CONFIG] Failed endpoint=${endpoint} status=none code=${code} reason=${err?.message || "request failed"}`);
    return false;
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

function safeBodyKeys(body) {
  return body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body) : [];
}

async function proxyBackendJson(req, res, backendPath, { timeoutMs = 8000 } = {}) {
  const gcpUrl = (appConfig?.gcp_server_url) || GCP_URL;
  const authHeader = req.headers.authorization || "";
  const method = String(req.method || "GET").toUpperCase();
  const route = req.path || backendPath;
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };
  if (authHeader) headers.Authorization = authHeader;
  const init = {
    method,
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (!["GET", "HEAD"].includes(method)) {
    init.body = JSON.stringify(req.body || {});
  }

  console.log("[PROXY] request", {
    route,
    method,
    auth_present: String(authHeader).startsWith("Bearer "),
    body_keys: safeBodyKeys(req.body),
  });

  try {
    const backendRes = await fetch(`${gcpUrl}${backendPath}`, init);
    const raw = await backendRes.text();
    let data = {};
    if (raw) {
      try { data = JSON.parse(raw); }
      catch { data = { ok: backendRes.ok, message: raw.slice(0, 500) }; }
    }
    console.log("[PROXY] response", {
      route,
      status: backendRes.status,
      ok: backendRes.ok,
      reason: data?.reason || data?.error || data?.message || null,
    });
    return res.status(backendRes.status).json(data);
  } catch (err) {
    console.warn("[PROXY] failure", {
      route,
      method,
      reason: err?.name || err?.message || "fetch_error",
    });
    return res.status(503).json({
      ok: false,
      error: "Service temporarily unavailable",
      reason: err?.name === "TimeoutError" ? "backend_timeout" : "backend_unavailable",
    });
  }
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
      lastBootstrapFailure = { status: res.status, code: safe.code, reason: safe.reason };
      console.error(`[BOOTSTRAP] Failed endpoint=${endpoint} status=${res.status} code=${safe.code} reason=${safe.reason}`);
      return false;
    }
    appConfig = await res.json();
    validateBootstrapPayload(appConfig);
    configDegraded = false;
    configDegradedReason = "";
    bootstrapSource = "privileged_bootstrap";
    lastBootstrapFailure = null;
    console.log("[BOOTSTRAP] Environment:", runtimeEnvironment());
    console.log("[BOOTSTRAP] Config loaded successfully");
    console.log("[BOOTSTRAP] Supabase URL:", appConfig.supabase_url ? "configured" : "missing");
    console.log("[BOOTSTRAP] Anon key:", appConfig.supabase_anon_key ? "configured" : "missing");
    console.log("[BOOTSTRAP] Feature flags:", Object.keys(appConfig.feature_flags || {}).length, "flags");
    console.log("[BOOTSTRAP] Credit packs:", (appConfig.credit_packs || []).length, "packs");
    return true;
  } catch (err) {
    const code = err?.name === "TimeoutError" ? "BOOTSTRAP_TIMEOUT" : (err?.code || "BOOTSTRAP_NETWORK_OR_PARSE_ERROR");
    lastBootstrapFailure = { status: null, code, reason: err?.message || "request failed" };
    console.error(`[BOOTSTRAP] Failed endpoint=${endpoint} status=none code=${code} reason=${err?.message || "request failed"}`);
    return false;
  }
}

let _bootstrapTimerStarted = false;
let _bootstrapRefreshTimer = null;

async function bootstrapWithRetry(maxAttempts = 5) {
  if (isDevelopment() && !usePrivilegedBootstrap()) {
    if (await fetchPublicConfig()) {
      console.log("[BOOTSTRAP] Privileged bootstrap skipped in dev; using public config.");
      logStartupHealthSummary();
      return true;
    }
    const reason = "public config unavailable";
    markConfigDegraded(reason);
    appConfig = safeDevBootstrapConfig(reason);
    console.warn("[BOOTSTRAP] Privileged bootstrap skipped in dev; using local dev fallback.");
    logStartupHealthSummary();
    return false;
  }

  if (isDevelopment() && localServerConfig.generatedSecrets?.has("BOOTSTRAP_SECRET")) {
    if (await fetchPublicConfig()) {
      logStartupHealthSummary();
      return true;
    }
    const reason = "BOOTSTRAP_SECRET not configured";
    markConfigDegraded(reason);
    appConfig = safeDevBootstrapConfig(reason);
    console.warn("[BOOTSTRAP] Dev privileged bootstrap skipped: BOOTSTRAP_SECRET not configured");
    logStartupHealthSummary();
    return false;
  }

  const attempts = isDevelopment() ? 1 : maxAttempts;
  for (let i = 0; i < attempts; i++) {
    if (await fetchBootstrap()) {
      // Start 30-minute refresh timer only once, anchored to first success
      if (!_bootstrapTimerStarted) {
        _bootstrapTimerStarted = true;
        _bootstrapRefreshTimer = setInterval(() => {
          console.log("[BOOTSTRAP] Refreshing config...");
          fetchBootstrap().catch(() => {});
        }, 30 * 60 * 1000);
      }
      logStartupHealthSummary();
      return true;
    }
    if (i < attempts - 1) {
      console.log(`[BOOTSTRAP] Retry ${i + 1}/${attempts - 1} in 3s...`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  const rejectedSecret = lastBootstrapFailure?.status === 401 || lastBootstrapFailure?.status === 403;
  const reason = rejectedSecret ? "backend rejected bootstrap secret" : `backend bootstrap unavailable after ${attempts} attempt${attempts === 1 ? "" : "s"}`;
  markConfigDegraded(reason);
  if (isDevelopment()) {
    if (rejectedSecret) {
      console.warn("[BOOTSTRAP] Dev bootstrap secret rejected. Check Loqii BOOTSTRAP_SECRET matches Tzurah BOOTSTRAP_SECRET. Continuing with safe dev defaults.");
      if (await fetchPublicConfig()) {
        logStartupHealthSummary();
        return false;
      }
    } else {
      console.warn("[BOOTSTRAP] Development degraded mode: using local safe defaults");
    }
    appConfig = safeDevBootstrapConfig(reason);
    logStartupHealthSummary();
  } else {
    console.error("[BOOTSTRAP] Could not reach backend after", attempts, "attempts");
    logStartupHealthSummary();
  }
  return false;
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

  // /api/token + /api/key - compatibility wrappers for authenticated Decart client tokens.
  // Permanent Decart keys never enter this local proxy or the renderer.
  async function handleTokenRequest(req, res) {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: "Authentication required" });
    }
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");

    try {
      const gcpUrl = (appConfig?.gcp_server_url) || GCP_URL;
      const gcpRes = await fetch(`${gcpUrl}/decart/token`, {
        headers: {
          "Authorization": authHeader,
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
        signal: AbortSignal.timeout(5000),
      });
      const data = await gcpRes.json().catch(() => ({}));
      if (!gcpRes.ok) {
        return res.status(gcpRes.status).json(data);
      }
      const token = data.apiKey || data.token || data.api_key || data.key || null;
      if (!token) {
        return res.status(503).json({ error: "No client token in backend response" });
      }
      console.log("[DECART] client token received env=" + (data.decart_environment_used || data.environment || "unknown") + " expiresAt=" + (data.expiresAt || "unknown"));
      return res.json({
        apiKey: token,
        token,
        expiresAt: data.expiresAt || null,
        decart_environment_used: data.decart_environment_used || data.environment || null,
        decart_reason: data.decart_reason || data.reason || null,
        decart_test_user: data.decart_test_user === true,
        allowedModels: data.allowedModels || null,
        constraints: data.constraints || null,
      });
    } catch (err) {
      console.error("[DECART] client token fetch failed:", err.code || err.message);
      return res.status(503).json({ error: "Service temporarily unavailable" });
    }
  }

  app.get("/api/token", handleTokenRequest);
  app.post("/api/token", handleTokenRequest);
  app.get("/api/key",   handleTokenRequest);
  app.post("/api/key",  handleTokenRequest);
  app.get("/api/decart/client-token", handleTokenRequest);
  app.post("/api/decart/client-token", handleTokenRequest);

  // /decart/token - proxies user-authed client-token request to GCP
  // Requires Authorization: Bearer <supabase-access-token> from the renderer.
  // GCP validates the JWT and returns a short-lived Decart client token.
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

      const token = data.token || data.apiKey || data.api_key ||
                    data.key || data.data?.token || data.access_token || null;

      console.log("[DECART] client token received env=" + (data.decart_environment_used || data.environment || "unknown") + " expiresAt=" + (data.expiresAt || "unknown"));

      if (!token) {
        console.error("[TOKEN] Could not find token in GCP response:", Object.keys(data));
        return res.status(503).json({
          error: "No token in GCP response. Fields: " + Object.keys(data).join(", "),
        });
      }

      return res.json({
        token,
        apiKey: token,
        expiresAt: data.expiresAt || null,
        decart_environment_used: data.decart_environment_used || data.environment || null,
        decart_reason: data.decart_reason || data.reason || null,
        decart_test_user: data.decart_test_user === true,
        allowedModels: data.allowedModels || null,
        constraints: data.constraints || null,
      });

    } catch (err) {
      console.error("[DECART] client token fetch failed:", err.code || err.message);
      return res.status(503).json({ error: "Service temporarily unavailable" });
    }
  });

  // /api/config - expose bootstrap config to renderer
  app.get("/api/config", async (_req, res) => {
    if (!appConfig && isDevelopment()) {
      await fetchPublicConfig();
    }
    if (!appConfig && isDevelopment()) {
      const reason = configDegradedReason || "backend public config unavailable";
      markConfigDegraded(reason);
      appConfig = safeDevBootstrapConfig(reason);
    }
    if (!appConfig) return res.status(503).json({ error: "Configuration unavailable" });
    return res.json({
      ok: !isConfigDegraded(),
      config_source: bootstrapSource,
      privileged_bootstrap_used: bootstrapSource === "privileged_bootstrap",
      privileged_bootstrap_required: privilegedBootstrapRequired(),
      source: bootstrapSource,
      bootstrap_source: bootstrapSource,
      bootstrap_degraded: isConfigDegraded(),
      bootstrap_reason: isDevelopment() ? configDegradedReason : undefined,
      reason: isDevelopment() ? configDegradedReason : undefined,
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
      app_name:               appConfig.app_name,
      auth_providers:         appConfig.auth_providers,
      environment_label:      appConfig.environment_label,
    });
  });

  // /mock/purchase - proxy to GCP (localhost-only, Electron test mode)
  app.get("/api/app-config", async (req, res) => {
    if (!appConfig && isDevelopment()) {
      await fetchPublicConfig();
    }
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
      const data = await gcpRes.json();
      return res.json({
        ...data,
        config_source: data.config_source || "app_config",
        privileged_bootstrap_used: bootstrapSource === "privileged_bootstrap",
        privileged_bootstrap_required: privilegedBootstrapRequired(),
        source: bootstrapSource,
        bootstrap_source: bootstrapSource,
        bootstrap_degraded: isConfigDegraded(),
        bootstrap_reason: isDevelopment() ? configDegradedReason : undefined,
        reason: isDevelopment() ? configDegradedReason : undefined,
      });
    } catch (err) {
      console.warn("[APP CONFIG] Falling back to safe flags:", err.message);
      return res.json({
        ok: false,
        config_source: bootstrapSource,
        privileged_bootstrap_used: bootstrapSource === "privileged_bootstrap",
        privileged_bootstrap_required: privilegedBootstrapRequired(),
        source: bootstrapSource,
        bootstrap_source: bootstrapSource,
        bootstrap_degraded: isConfigDegraded(),
        bootstrap_reason: isDevelopment() ? (configDegradedReason || "backend app config unavailable") : undefined,
        reason: isDevelopment() ? (configDegradedReason || "backend app config unavailable") : undefined,
        degraded: isConfigDegraded(),
        degraded_reason: isDevelopment() ? (configDegradedReason || "backend app config unavailable") : undefined,
        feature_flags: appConfig.feature_flags || { ...SAFE_DEV_FEATURE_FLAGS },
        app_flags: appConfig.app_flags || appConfig.feature_flags || { ...SAFE_DEV_FEATURE_FLAGS },
        is_dev_account: false,
        environment: isDevelopment() ? "development_degraded" : "bootstrap_fallback",
      });
    }
  });

  app.post("/api/ensure-profile", (req, res) => {
    return proxyBackendJson(req, res, "/api/ensure-profile");
  });

  app.get("/api/announcements", (req, res) => {
    return proxyBackendJson(req, res, "/api/announcements", { timeoutMs: 5000 });
  });

  app.get("/api/credit-packs", (req, res) => {
    return proxyBackendJson(req, res, "/api/credit-packs", { timeoutMs: 5000 });
  });

  app.get("/api/feature-flags", (req, res) => {
    return proxyBackendJson(req, res, "/api/feature-flags", { timeoutMs: 5000 });
  });

  app.post("/session/end", (req, res) => {
    return proxyBackendJson(req, res, "/session/end");
  });

  app.post("/credits/deduct", (req, res) => {
    return proxyBackendJson(req, res, "/credits/deduct");
  });

  app.post("/credits/sync", (req, res) => {
    return proxyBackendJson(req, res, "/credits/sync");
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

  app.post(["/session/ping", "/api/session/ping"], async (req, res) => {
    const authHeader = req.headers.authorization || "";
    const body = req.body || {};
    console.log("[SESSION REGISTER] proxy request", {
      endpoint: "/session/ping",
      user_id: body.user_id || null,
      email: body.email || null,
      session_id: body.session_id || null,
      auth_present: String(authHeader).startsWith("Bearer "),
      request_body_keys: Object.keys(body),
    });
    try {
      const gcpUrl = (appConfig?.gcp_server_url) || GCP_URL;
      const gcpRes = await fetch(`${gcpUrl}/session/ping`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authHeader ? { Authorization: authHeader } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
      const data = await gcpRes.json().catch(() => ({}));
      console.log("[SESSION REGISTER] proxy response", {
        status: gcpRes.status,
        ok: gcpRes.ok,
        body: data,
      });
      return res.status(gcpRes.status).json(data);
    } catch (err) {
      console.error("[SESSION REGISTER] proxy failure", {
        type: err?.name || "fetch_error",
        message: err?.message || String(err),
      });
      return res.status(503).json({ ok: false, error: "Session ping unavailable", reason: err?.message || "fetch_error" });
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
  if (!isDevelopment()) {
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
      console.log("  GET /api/token  -> Decart client token (proxied from backend)");
      console.log("  GET /           -> index.html");
      console.log("  WS  /           -> OBS frame relay");
      console.log("===============================================\n");
      resolve(s);
    });
  });
  attachObsWebSocket(server);

  // Bootstrap in background - renderer retries /api/config until ready
  if (isDevelopment()) bootstrapWithRetry(5).catch(() => {});

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
