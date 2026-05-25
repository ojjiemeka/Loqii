export const SETTINGS_SECTIONS = Object.freeze([
  { id: "general", name: "General", description: "Launch, theme, and workspace preferences." },
  { id: "video", name: "Video", description: "Camera, preview, and output settings." },
  { id: "audio", name: "Audio", description: "Microphone, monitor, and speaker routing." },
  { id: "ai", name: "AI", description: "Prompt, scene, style, and model behavior." },
  { id: "performance", name: "Performance", description: "FPS, latency, reconnects, and rendering health." },
  { id: "developer", name: "Developer", description: "Diagnostics, environment proof, and debug toggles." },
]);

export function getSettingsSections() {
  return SETTINGS_SECTIONS.map((section) => ({ ...section }));
}
