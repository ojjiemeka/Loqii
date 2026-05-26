export const SETTINGS_SECTIONS = Object.freeze([
  { id: "general", name: "General", description: "Theme, version, account, and credits summary." },
  { id: "video", name: "Video", description: "Camera, layout, and OBS status." },
  { id: "audio", name: "Audio", description: "Microphone, output, and monitor routing." },
  { id: "ai", name: "AI", description: "Intensity, scene behavior, and style behavior." },
  { id: "help", name: "Help", description: "Help Center and support entry points." },
  { id: "developer", name: "Developer", description: "Flag-gated diagnostics for internal QA." },
]);

export function getSettingsSections() {
  return SETTINGS_SECTIONS.map((section) => ({ ...section }));
}
