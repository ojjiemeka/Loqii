export const PROMPT_LAYER_NAMES = Object.freeze([
  "identityLayer",
  "backgroundLayer",
  "styleLayer",
  "enhancementLayer",
  "safetyLayer",
]);

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function sentence(value) {
  const text = clean(value);
  if (!text) return "";
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

export function buildIntensityLayer(mode, intensity) {
  const val = Number.isFinite(Number(intensity)) ? Number(intensity) : 100;
  if (mode === "background") {
    if (val <= 30) return "Use a subtle background blend and keep some original environment visible.";
    if (val <= 60) return "Use moderate background replacement with natural edges.";
    if (val <= 90) return "Use strong background replacement with consistent lighting.";
    return "Use complete background replacement with photorealistic perspective and seamless subject edges.";
  }
  if (mode === "style") {
    if (val <= 30) return "Apply a very subtle visual style while preserving the original look.";
    if (val <= 60) return "Apply a moderate visual style while preserving identity.";
    if (val <= 90) return "Apply a strong visual style while preserving identity and outfit.";
    return "Apply the full style treatment while preserving identity, face, outfit, and body shape.";
  }
  if (val <= 30) return "Slightly modify the character in the video.";
  if (val <= 60) return "Moderately transform the character in the video.";
  if (val <= 90) return "Strongly transform the character in the video.";
  return "Completely substitute the character in the video.";
}

export function composePrompt(layers = {}) {
  const ordered = PROMPT_LAYER_NAMES
    .map((name) => ({ name, text: sentence(layers[name]) }))
    .filter((layer) => layer.text);

  const seen = new Set();
  const unique = ordered.filter((layer) => {
    const key = layer.text.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    prompt: unique.map((layer) => layer.text).join(" "),
    activeLayers: unique.map((layer) => layer.name),
    layers: Object.fromEntries(unique.map((layer) => [layer.name, layer.text])),
  };
}

export function buildPromptDebugSnapshot(input = {}) {
  return {
    finalPrompt: input.prompt || "",
    activeLayers: input.activeLayers || [],
    activeScene: input.scene?.name || null,
    activeStyle: input.style?.name || null,
    activeBackground: input.background?.name || null,
    generatedAt: new Date().toISOString(),
  };
}
