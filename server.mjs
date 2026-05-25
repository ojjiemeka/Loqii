/**
 * server.mjs — Local Express server  (ES Module)
 *
 * Runs embedded inside Electron on port 3000 (default).
 * Serves static assets + the Decart API token proxy.
 *
 * Auth and payments are handled by the GCP server (gcp-server.js).
 * The Decart API key is NEVER stored locally — always fetched from GCP.
 *
 * Routes:
 *   GET  /                → index.html  (main face-swap app)
 *   GET  /obs             → obs.html
 *   GET  /login.html      → login.html
 *   GET  /signup.html     → signup.html
 *   GET  /topup.html      → topup.html
 *   GET  /dashboard.html  → dashboard.html
 *   GET  /api/token       → Decart API key proxied from GCP (cached 5 min)
 *   GET  /api/key         → alias of /api/token (standalone compat)
 */

import "dotenv/config";
import express              from "express";
import path                 from "path";
import { fileURLToPath }    from "url";
import { WebSocketServer }  from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Bootstrap config (fetched from GCP, never on disk) ────────────
const GCP_URL      = process.env.GCP_SERVER_URL || "http://34.39.83.195:4000";
const APP_SECRET   = process.env.BOOTSTRAP_SECRET || "tzurah-bootstrap-2025-prod";
let appConfig      = null; // in-memory only

async function fetchBootstrap() {
  try {
    const res = await fetch(`${GCP_URL}/api/bootstrap`, {
      headers: { "x-app-secret": APP_SECRET },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error("Bootstrap HTTP " + res.status);
    appConfig = await res.json();
    console.log("[BOOTSTRAP] Config loaded successfully");
    console.log("[BOOTSTRAP] Supabase URL:", appConfig.supabase_url ? "✅" : "❌");
    console.log("[BOOTSTRAP] Anon key:    ", appConfig.supabase_anon_key ? "✅" : "❌");
    console.log("[BOOTSTRAP] Feature flags:", Object.keys(appConfig.feature_flags || {}).length, "flags");
    console.log("[BOOTSTRAP] Credit packs:", (appConfig.credit_packs || []).length, "packs");
    return true;
  } catch (err) {
    console.error("[BOOTSTRAP] Failed:", err.message);
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
          console.log("[BOOTSTRAP] Refreshing config…");
          fetchBootstrap().catch(() => {});
        }, 30 * 60 * 1000);
      }
      return true;
    }
    if (i < maxAttempts - 1) {
      console.log(`[BOOTSTRAP] Retry ${i + 1}/${maxAttempts - 1} in 3s…`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  console.error("[BOOTSTRAP] Could not reach GCP after", maxAttempts, "attempts — app will show connection error");
  return false;
}

// ── Token cache (avoids hitting GCP on every renderer request) ────
let _cachedRawDecartKey   = null;
let _rawDecartKeyCachedAt = 0;
const TOKEN_CACHE_MS = 5 * 60 * 1000; // 5 minutes

async function fetchTokenFromGCP() {
  const gcpUrl = (appConfig?.gcp_server_url) || GCP_URL;
  const secret = process.env.INTERNAL_SECRET || "tzurah-internal";
  const gcpRes = await fetch(`${gcpUrl}/internal/decart-key`, {
    headers: { "x-internal-secret": secret },
    signal: AbortSignal.timeout(8000),
  });
  if (!gcpRes.ok) throw new Error(`GCP token fetch failed: ${gcpRes.status}`);
  const data = await gcpRes.json();
  if (!data.token) throw new Error("GCP returned no token");
  return data.token;
}

// ── Build Express app ──────────────────────────────────────────────
function buildApp() {
  const app = express();
  app.use(express.json());

  // public/ contains sdk-bundle.js (built by `npm run build`)
  app.use(express.static(path.join(__dirname, "public")));
  // Root static — serves assets, SDK entry, etc.
  app.use(express.static(__dirname, { index: false }));

  // ── HTML pages ────────────────────────────────────────────────

  // Main face-swap app (requires login — index.html checks session via IPC)
  app.get("/",               (_req, res) => res.sendFile(path.join(__dirname, "index.html")));
  app.get("/obs",            (_req, res) => res.sendFile(path.join(__dirname, "obs.html")));

  // Auth screens (also loadFile'd by Electron, but served here for completeness)
  app.get("/login.html",     (_req, res) => res.sendFile(path.join(__dirname, "login.html")));
  app.get("/signup.html",    (_req, res) => res.sendFile(path.join(__dirname, "signup.html")));
  app.get("/topup.html",     (_req, res) => res.sendFile(path.join(__dirname, "topup.html")));
  app.get("/dashboard.html", (_req, res) => res.sendFile(path.join(__dirname, "dashboard.html")));

  // ── /api/token + /api/key — proxy Decart key from GCP ────────
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

  // ── /decart/token — proxies user-authed request to GCP ───────────
  // Requires Authorization: Bearer <supabase-access-token> from the renderer.
  // GCP validates the JWT and returns the Decart API token.
  // TODO: cache is keyed on a single slot — fine for single-user Electron,
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
      console.error("[DECART TOKEN] Fetch failed:", err.message);
      return res.status(503).json({ error: err.message });
    }
  });

  // ── /api/config — expose bootstrap config to renderer ─────────
  app.get("/api/config", (_req, res) => {
    if (!appConfig) return res.status(503).json({ error: "Config not loaded yet — GCP may be unreachable" });
    return res.json({
      supabase_url:           appConfig.supabase_url,
      supabase_anon_key:      appConfig.supabase_anon_key,
      gcp_server_url:         appConfig.gcp_server_url,
      feature_flags:          appConfig.feature_flags,
      credit_packs:           appConfig.credit_packs,
      burn_rate:              appConfig.burn_rate,
      free_credits_on_signup: appConfig.free_credits_on_signup,
      app_version:            appConfig.app_version,
    });
  });

  // ── /mock/purchase — proxy to GCP (localhost-only, Electron test mode) ──
  app.post("/mock/purchase", async (req, res) => {
    try {
      const gcpUrl = (appConfig?.gcp_server_url) || process.env.GCP_SERVER_URL || "http://34.39.83.195:4000";
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
      console.error("[mock/purchase proxy]", err);
      return res.status(500).json({ error: err.message });
    }
  });

  return app;
}

// ── OBS WebSocket relay ────────────────────────────────────────────
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

      // Subsequent messages from pushers → relay to all viewers
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

// ── startServer — called by electron.js ───────────────────────────
export async function startServer(port) {
  // Start listening FIRST so Electron can load index.html immediately.
  // /api/config returns 503 while bootstrap is in progress; bootstrapApp()
  // in index.html retries until it gets a 200.
  const expressApp = buildApp();
  const server = await new Promise((resolve) => {
    const s = expressApp.listen(port, () => {
      console.log("═══════════════════════════════════════════════");
      console.log("  Loqii — Local Express Server  [Electron mode]");
      console.log(`  http://localhost:${port}`);
      console.log("───────────────────────────────────────────────");
      console.log("  GET /api/config → bootstrap config for renderer");
      console.log("  GET /api/token  → Decart key (proxied from GCP)");
      console.log("  GET /           → index.html");
      console.log("  WS  /           → OBS frame relay");
      console.log("═══════════════════════════════════════════════\n");
      resolve(s);
    });
  });
  attachObsWebSocket(server);

  // Bootstrap in background — renderer retries /api/config until ready
  bootstrapWithRetry(5).catch(() => {});

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

// ── Standalone (npm start / node server.mjs) ──────────────────────
const isMain = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(__filename);

if (isMain) {
  const PORT = parseInt(process.env.EXPRESS_PORT || process.env.PORT || "3000", 10);
  const standaloneServer = buildApp().listen(PORT, () => {
    console.log("═══════════════════════════════════════════════");
    console.log("  Loqii — Decart AI Face Swap  [standalone]");
    console.log(`  http://localhost:${PORT}`);
    console.log("═══════════════════════════════════════════════\n");
  });
  attachObsWebSocket(standaloneServer);
}
