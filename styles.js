export const STYLE_PRESETS = Object.freeze([
  { id: "cinematic", name: "Cinematic", prompt: "cinematic realistic lighting, refined contrast, natural skin detail, premium camera color" },
  { id: "anime", name: "Anime", prompt: "polished anime-inspired rendering while preserving the same identity, outfit, and body shape" },
  { id: "cyberpunk", name: "Cyberpunk", prompt: "tasteful futuristic color contrast and controlled rim light without changing identity" },
  { id: "luxury", name: "Luxury", prompt: "luxury editorial color, soft highlights, elegant contrast, premium creator look" },
  { id: "horror", name: "Horror", prompt: "subtle cinematic horror lighting, moody shadows, readable face, identity preserved" },
  { id: "documentary", name: "Documentary", prompt: "natural documentary realism, true skin tones, practical lighting, minimal stylization" },
  { id: "studio-lighting", name: "Studio Lighting", prompt: "clean studio key light, soft fill, crisp subject separation, natural color" },
  { id: "tiktok-beauty", name: "TikTok Beauty", prompt: "soft beauty lighting, flattering skin detail, social creator polish, identity preserved" },
  { id: "vtuber", name: "VTuber", prompt: "high quality VTuber-inspired creator style while preserving facial identity and outfit structure" },
]);

export function findStyle(id) {
  return STYLE_PRESETS.find((style) => style.id === id) || null;
}
