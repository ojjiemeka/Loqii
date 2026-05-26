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
  "--alert-text": "var(--text-primary)",
  "--alert-bg": "var(--surface-elevated)",
  "--alert-border": "var(--border)",
  "--alert-badge-bg": "var(--accent-danger)",
  "--alert-badge-text": "var(--loqii-paper)",
});

export function applyLoqiiThemeAliases(root = document.documentElement) {
  Object.entries(LOQII_THEME_TOKENS).forEach(([key, value]) => {
    root.style.setProperty(key, value);
  });
}

export function getActiveThemeClass(source = document.body) {
  const theme = source?.dataset?.theme === "light" ? "light" : "dark";
  return `loqii-theme-${theme}`;
}

export function applyThemeToOverlayRoot(root, source = document.body) {
  if (!root) return root;
  const theme = source?.dataset?.theme === "light" ? "light" : "dark";
  root.dataset.theme = theme;
  root.classList.remove("loqii-theme-light", "loqii-theme-dark", "theme-light", "theme-dark");
  root.classList.add(`loqii-theme-${theme}`, `theme-${theme}`);
  return root;
}

export function getFeatureFlag(flags, key, fallback = false) {
  if (!flags || typeof flags !== "object") return fallback;
  if (typeof flags[key] === "boolean") return flags[key];
  return fallback;
}
