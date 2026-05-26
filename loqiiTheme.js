export const LOQII_THEME_TOKENS = Object.freeze({
  "--app-bg": "var(--bg)",
  "--surface-elevated": "var(--surface2)",
  "--surface-muted": "var(--surface2)",
  "--surface": "var(--surface)",
  "--text-primary": "var(--text)",
  "--text-secondary": "var(--muted)",
  "--text-muted": "var(--muted)",
  "--text-danger": "var(--loqii-coral)",
  "--text-success": "var(--loqii-green)",
  "--accent-primary": "var(--loqii-green)",
  "--accent-danger": "var(--loqii-coral)",
});

export function applyLoqiiThemeAliases(root = document.documentElement) {
  Object.entries(LOQII_THEME_TOKENS).forEach(([key, value]) => {
    root.style.setProperty(key, value);
  });
}

export function getFeatureFlag(flags, key, fallback = false) {
  if (!flags || typeof flags !== "object") return fallback;
  if (typeof flags[key] === "boolean") return flags[key];
  return fallback;
}
