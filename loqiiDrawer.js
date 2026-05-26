let drawerStylesInjected = false;

function injectDrawerStyles() {
  if (drawerStylesInjected) return;
  drawerStylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    .loqii-drawer-overlay {
      position: fixed; inset: 0; z-index: 9700;
      background: var(--overlay, rgba(1,22,39,.48)); backdrop-filter: blur(5px);
      display: flex; justify-content: flex-end; padding: 12px;
    }
    .loqii-drawer {
      width: min(520px, 100%); height: calc(100vh - 24px);
      display: flex; flex-direction: column; overflow: hidden;
      border: 1px solid var(--border); border-radius: 12px;
      background: var(--surface-elevated, var(--surface)); color: var(--text-primary, var(--text));
      box-shadow: -24px 0 80px var(--shadow);
    }
    .loqii-drawer-header {
      flex: 0 0 auto; padding: 14px 16px; border-bottom: 1px solid var(--border);
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
    }
    .loqii-drawer-title { font-size: .92rem; font-weight: 850; color: var(--text-primary, var(--text)); }
    .loqii-drawer-close {
      width: 28px; height: 28px; border: 1px solid var(--border); border-radius: 7px;
      background: var(--surface-muted, var(--surface2)); color: var(--text-muted, var(--muted)); cursor: pointer; font: inherit;
    }
    .loqii-drawer-body {
      flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 14px 16px;
      display: flex; flex-direction: column; gap: 12px;
    }
    .loqii-section {
      border: 1px solid var(--border); border-radius: 9px; background: var(--surface-muted, var(--surface2));
      padding: 11px;
    }
    .loqii-section-title {
      color: var(--text-primary, var(--text)); font-size: .74rem; font-weight: 850; margin-bottom: 7px;
      text-transform: uppercase; letter-spacing: .06em;
    }
    .loqii-section-copy { color: var(--text-secondary, var(--muted)); font-size: .76rem; line-height: 1.5; }
    .loqii-drawer-actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .loqii-btn {
      border: 1px solid var(--border); border-radius: 7px; padding: 8px 12px;
      background: var(--surface-muted, var(--surface2)); color: var(--text-primary, var(--text));
      cursor: pointer; font: inherit; font-size: .78rem; font-weight: 800;
    }
    .loqii-btn:hover { border-color: var(--accent-primary, var(--loqii-green)); box-shadow: 0 0 14px rgba(63,108,81,.10); }
    .loqii-btn-primary { background: var(--accent-primary, var(--loqii-green)); border-color: var(--accent-primary, var(--loqii-green)); color: var(--loqii-paper); }
    .loqii-btn-danger { background: rgba(201,112,100,.14); border-color: var(--accent-danger, var(--loqii-coral)); color: var(--text-danger, var(--loqii-coral)); }
  `;
  document.head.appendChild(style);
}

export function LoqiiDrawer({ title = "Loqii", body = "", width = 520, onClose } = {}) {
  injectDrawerStyles();
  document.querySelectorAll(".loqii-drawer-overlay").forEach((el) => el.remove());
  const overlay = document.createElement("div");
  overlay.className = "loqii-drawer-overlay";
  overlay.innerHTML = `
    <aside class="loqii-drawer" style="width:min(${Number(width) || 520}px,100%)" role="dialog" aria-modal="true" aria-label="${title}">
      <header class="loqii-drawer-header">
        <div class="loqii-drawer-title">${title}</div>
        <button class="loqii-drawer-close" type="button" aria-label="Close" data-loqii-drawer-close>x</button>
      </header>
      <div class="loqii-drawer-body">${body}</div>
    </aside>`;
  document.body.appendChild(overlay);
  const close = () => {
    overlay.remove();
    if (typeof onClose === "function") onClose();
  };
  const onKey = (event) => {
    if (!document.body.contains(overlay)) return document.removeEventListener("keydown", onKey);
    if (event.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey);
  overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });
  overlay.querySelector("[data-loqii-drawer-close]")?.addEventListener("click", close);
  return { close, element: overlay };
}
