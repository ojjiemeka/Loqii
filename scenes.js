export const SCENE_STORAGE_KEYS = Object.freeze({
  selected: "loqii_selected_scene_id",
  favorites: "loqii_favorite_scene_ids",
  recent: "loqii_recent_scene_ids",
});

export const BUILTIN_SCENES = Object.freeze([
  {
    id: "professional-studio",
    name: "Professional Studio",
    category: "Studio",
    description: "Broadcast studio with acoustic panels and soft key lighting.",
    backgroundPrompt: "a professional broadcast studio with acoustic wall panels, a clean desk, and shallow depth of field",
    lightingPrompt: "soft key lighting with natural skin tones",
    cameraPrompt: "medium creator framing with subtle depth of field",
    tags: ["studio", "creator", "professional"],
    compatibility: ["realtime", "image_preview"],
    previewColor: "#3F6C51",
  },
  {
    id: "modern-office",
    name: "Modern Office",
    category: "Work",
    description: "Tasteful office with plants, glass, and warm practical light.",
    backgroundPrompt: "a modern office interior with glass walls, tasteful plants, warm overhead lighting, and a tidy executive workspace",
    lightingPrompt: "warm overhead light balanced with soft daylight",
    cameraPrompt: "clean desk-level creator framing",
    tags: ["office", "work", "clean"],
    compatibility: ["realtime", "image_preview"],
    previewColor: "#606D5D",
  },
  {
    id: "luxury-apartment",
    name: "Luxury Apartment",
    category: "Interior",
    description: "Elegant apartment with city views and quiet ambient light.",
    backgroundPrompt: "a luxury apartment living room with floor-to-ceiling windows, neutral furniture, city views, and elegant ambient lighting",
    lightingPrompt: "warm ambient lighting with soft window highlights",
    cameraPrompt: "cinematic living-room creator framing",
    tags: ["interior", "luxury", "warm"],
    compatibility: ["realtime", "image_preview"],
    previewColor: "#C97064",
  },
  {
    id: "podcast-room",
    name: "Podcast Room",
    category: "Studio",
    description: "Warm podcast studio with shelves and sound treatment.",
    backgroundPrompt: "a cozy podcast recording room with warm lamps, sound treatment, shelves, and a professional creator setup",
    lightingPrompt: "warm practical lamps and soft studio fill",
    cameraPrompt: "talking-head creator framing",
    tags: ["podcast", "studio", "warm"],
    compatibility: ["realtime", "image_preview"],
    previewColor: "#3F6C51",
  },
  {
    id: "neon-cyberpunk",
    name: "Neon Cyberpunk",
    category: "Stylized",
    description: "Cinematic rainy city without changing identity.",
    backgroundPrompt: "a neon cyberpunk city backdrop with tasteful signs, rain-slick reflections, and cinematic night lighting",
    lightingPrompt: "restrained colored rim light with readable face exposure",
    cameraPrompt: "cinematic close creator framing",
    tags: ["stylized", "night", "city"],
    compatibility: ["realtime"],
    previewColor: "#C97064",
  },
  {
    id: "outdoor-park",
    name: "Outdoor Park",
    category: "Outdoor",
    description: "Natural park daylight and soft background bokeh.",
    backgroundPrompt: "a bright outdoor park with green trees, soft daylight, a natural walkway, and gentle background bokeh",
    lightingPrompt: "soft daylight with natural skin tones",
    cameraPrompt: "natural portrait framing",
    tags: ["outdoor", "daylight", "natural"],
    compatibility: ["realtime", "image_preview"],
    previewColor: "#3F6C51",
  },
  {
    id: "beach-sunset",
    name: "Beach Sunset",
    category: "Outdoor",
    description: "Warm beach horizon and calm sunset light.",
    backgroundPrompt: "a beach at sunset with warm golden light, calm waves, soft sand, and a relaxed cinematic horizon",
    lightingPrompt: "golden hour light with controlled highlights",
    cameraPrompt: "cinematic portrait framing",
    tags: ["outdoor", "sunset", "cinematic"],
    compatibility: ["realtime", "image_preview"],
    previewColor: "#C97064",
  },
  {
    id: "minimal-white-room",
    name: "Minimal White Room",
    category: "Clean",
    description: "Quiet minimal room for distraction-free creator content.",
    backgroundPrompt: "a minimal white room with clean walls, soft studio lighting, subtle shadows, and a distraction-free professional look",
    lightingPrompt: "soft studio lighting and clean shadow detail",
    cameraPrompt: "centered creator framing",
    tags: ["clean", "minimal", "studio"],
    compatibility: ["realtime", "image_preview"],
    previewColor: "#606D5D",
  },
]);

function readList(storage, key) {
  try {
    const parsed = JSON.parse(storage.getItem(key) || "[]");
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function writeList(storage, key, list) {
  storage.setItem(key, JSON.stringify(Array.from(new Set(list)).slice(0, 12)));
}

export function getSceneCategories(scenes = BUILTIN_SCENES) {
  return ["All", ...Array.from(new Set(scenes.map((scene) => scene.category))).sort()];
}

export function createSceneStore(options = {}) {
  const storage = options.storage || localStorage;
  let selectedId = storage.getItem(SCENE_STORAGE_KEYS.selected) || "";
  let favorites = new Set(readList(storage, SCENE_STORAGE_KEYS.favorites));
  let recent = readList(storage, SCENE_STORAGE_KEYS.recent);

  function getById(id) {
    return BUILTIN_SCENES.find((scene) => scene.id === id) || null;
  }

  return {
    all: BUILTIN_SCENES,
    getSelected() { return getById(selectedId); },
    select(id) {
      selectedId = id || "";
      if (selectedId) {
        storage.setItem(SCENE_STORAGE_KEYS.selected, selectedId);
        recent = [selectedId, ...recent.filter((item) => item !== selectedId)].slice(0, 8);
        writeList(storage, SCENE_STORAGE_KEYS.recent, recent);
      } else {
        storage.removeItem(SCENE_STORAGE_KEYS.selected);
      }
      return this.getSelected();
    },
    clear() { return this.select(""); },
    isFavorite(id) { return favorites.has(id); },
    toggleFavorite(id) {
      if (!id) return false;
      if (favorites.has(id)) favorites.delete(id);
      else favorites.add(id);
      writeList(storage, SCENE_STORAGE_KEYS.favorites, Array.from(favorites));
      return favorites.has(id);
    },
    getRecent() { return recent.map(getById).filter(Boolean); },
    search({ query = "", category = "All", favoritesOnly = false } = {}) {
      const q = query.trim().toLowerCase();
      return BUILTIN_SCENES.filter((scene) => {
        if (category && category !== "All" && scene.category !== category) return false;
        if (favoritesOnly && !favorites.has(scene.id)) return false;
        if (!q) return true;
        return [scene.name, scene.description, scene.category, ...(scene.tags || [])]
          .join(" ").toLowerCase().includes(q);
      });
    },
  };
}
