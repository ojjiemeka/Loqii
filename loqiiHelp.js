export const HELP_SECTIONS = Object.freeze([
  ["Getting Started", "Choose an identity, write a prompt, then press Start. Apply Prompt updates the active realtime session."],
  ["Camera setup", "Use the camera selector before starting. Restart the session after changing cameras."],
  ["Audio setup", "Choose mic input, speaker output, and optional monitor routing before going live."],
  ["How Face Swap works", "Loqii sends camera frames to Decart and applies your identity, scene, and style prompt in realtime."],
  ["Identity images", "Use clear portrait images with visible face detail. Avoid extreme blur or heavy occlusion."],
  ["Scenes", "Scenes change the full environment while preserving the person and identity."],
  ["Background", "Background mode changes only the environment behind the person."],
  ["Style", "Style mode changes the visual look without changing the person."],
  ["Credits and billing", "Credits are consumed while a realtime session is active. Stop ends the session and finalizes sync."],
  ["OBS setup", "Press OBS, then add the local browser source shown in the setup guide."],
  ["Troubleshooting", "If video stalls, Stop safely, check camera permissions, and restart the session."],
  ["Contact support", "Support placeholder: support@tzurah.ai"],
]);

export function buildHelpMarkup() {
  return HELP_SECTIONS.map(([title, copy]) => `
    <section class="loqii-section">
      <div class="loqii-section-title">${title}</div>
      <div class="loqii-section-copy">${copy}</div>
    </section>
  `).join("");
}
