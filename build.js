/**
 * Bundles @decartai/sdk for browser use.
 * Output: public/sdk-bundle.js (ESM, browser-compatible)
 *
 * Usage:
 *   node build.js
 *   npm run build
 *   npm start   (runs build then server)
 */

import * as esbuild from "esbuild";
import { mkdirSync } from "fs";

mkdirSync("public", { recursive: true });

console.log("Building SDK bundle...");

await esbuild.build({
  entryPoints: ["sdk-entry.js"],
  bundle:      true,
  format:      "esm",
  outfile:     "public/sdk-bundle.js",
  platform:    "browser",

  // Treat the native browser WebSocket / RTCPeerConnection as externals
  // so esbuild doesn't try to polyfill them.
  define: {
    "global":                  "globalThis",
    "process.env.NODE_ENV":    '"production"',
  },

  // Prefer the "browser" export condition so the SDK swaps out Node-only
  // dependencies (e.g. the `ws` package) for browser equivalents.
  conditions: ["browser"],

  // Keep readable for easier debugging; add minify:true once stable.
  minify: false,

  logLevel: "info",
});

console.log("OK public/sdk-bundle.js ready");
