// Entry point for esbuild — re-exports only what the browser needs.
// Run `npm run build` (or `node build.js`) to produce public/sdk-bundle.js.
export { createDecartClient, models } from "@decartai/sdk";
