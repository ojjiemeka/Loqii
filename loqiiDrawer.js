import { applyThemeToOverlayRoot } from "./loqiiTheme.js";

let drawerStylesInjected = false;

function injectDrawerStyles() {
  if (drawerStylesInjected) return;
  drawerStylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    .loqii-drawer-overlay {
      position: fixed; inset: 0; z-index: 9700;
      background: var(--overlay); backdrop-filter: blur(5px);
      display: flex; justify-content: flex-end; padding: 12px;
    }
    .loqii-drawer {
      width: min(520px, 100%); height: calc(100vh - 24px);
      display: flex; flex-direction: column; overflow: hidden;
      border: 1px solid var(--border); border-radius: 12px;
      background: var(--surface); color: var(--text-primary);
      box-shadow: -24px 0 80px var(--shadow);
    }
    .loqii-drawer-header {
      flex: 0 0 auto; padding: 14px 16px; border-bottom: 1px solid var(--border);
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
    }
    .loqii-drawer-title { font-size: .92rem; font-weight: 850; color: var(--text-primary); }
    .loqii-drawer-close {
      width: 28px; height: 28px; border: 1px solid var(--border); border-radius: 7px;
      background: var(--surface-elevated); color: var(--text-muted); cursor: pointer; font: inherit;
    }
    .loqii-drawer-body {
      flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 14px 16px;
      display: flex; flex-direction: column; gap: 12px;
    }
    .loqii-drawer-close:hover { color: var(--text-primary); border-color: var(--accent-primary); }
    .loqii-section {
      border: 1px solid var(--border); border-radius: 9px; background: var(--surface-elevated);
      padding: 11px;
    }
    .loqii-section-title {
      color: var(--text-primary); font-size: .74rem; font-weight: 850; margin-bottom: 7px;
      text-transform: uppercase; letter-spacing: .06em;
    }
    .loqii-section-copy { color: var(--text-secondary); font-size: .76rem; line-height: 1.5; }
    .loqii-drawer-actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .loqii-setting-row {
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      padding: 8px 0; border-bottom: 1px solid var(--border);
    }
    .loqii-setting-row:last-child { border-bottom: 0; }
    .loqii-setting-label {
      color: var(--text-secondary); font-size: .76rem; font-weight: 750;
    }
    .loqii-setting-value {
      color: var(--text-primary); font-size: .78rem; font-weight: 850;
      text-align: right; overflow-wrap: anywhere;
    }
    .loqii-btn {
      border: 1px solid var(--border); border-radius: 7px; padding: 8px 12px;
      background: var(--surface-elevated); color: var(--text-primary);
      cursor: pointer; font: inherit; font-size: .78rem; font-weight: 800;
    }
    .loqii-btn:disabled { opacity: .48; cursor: not-allowed; box-shadow: none; }
    .loqii-btn:hover { border-color: var(--accent-primary); box-shadow: 0 0 14px var(--accent-glow); }
    .loqii-btn-primary { background: var(--accent-primary); border-color: var(--accent-primary); color: var(--loqii-paper); }
    .loqii-btn-danger { background: var(--surface-elevated); border-color: var(--accent-danger); color: var(--accent-danger); }
    .loqii-account {
      display: flex; flex-direction: column; gap: 12px; color: var(--text-primary);
    }
    .loqii-account-summary {
      display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px;
    }
    .loqii-account-card {
      min-height: 92px; border: 1px solid var(--border); border-radius: 9px;
      background: var(--surface-elevated); padding: 12px;
      display: flex; flex-direction: column; justify-content: space-between; gap: 8px;
    }
    .loqii-account-profile { flex-direction: row; align-items: center; justify-content: flex-start; grid-column: span 2; }
    .loqii-account-avatar {
      width: 44px; height: 44px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center; flex: 0 0 auto;
      background: var(--accent-primary); color: var(--loqii-paper);
      font-size: 1.1rem; font-weight: 900; overflow: hidden;
    }
    .loqii-account-avatar img { width: 100%; height: 100%; object-fit: cover; }
    .loqii-account-title {
      color: var(--text-muted); font-size: .62rem; font-weight: 900;
      letter-spacing: .07em; text-transform: uppercase;
    }
    .loqii-account-value {
      color: var(--text-primary); font-size: 1rem; font-weight: 900; line-height: 1.2;
      overflow: hidden; text-overflow: ellipsis;
    }
    .loqii-account-value.accent { color: var(--accent-primary); font-size: 1.45rem; }
    .loqii-account-meta { color: var(--text-secondary); font-size: .74rem; line-height: 1.4; overflow-wrap: anywhere; }
    .loqii-account-actions {
      display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px;
    }
    .loqii-account-history {
      border: 1px solid var(--border); border-radius: 9px; overflow: hidden;
      background: var(--surface-elevated);
    }
    .loqii-account-history-head,
    .loqii-account-purchase {
      display: grid; grid-template-columns: minmax(0, 1fr) 110px 86px; gap: 10px; align-items: center;
      padding: 10px 12px; border-bottom: 1px solid var(--border);
    }
    .loqii-account-history-head {
      color: var(--text-muted); font-size: .62rem; font-weight: 900;
      letter-spacing: .07em; text-transform: uppercase; background: var(--surface);
    }
    .loqii-account-purchase:last-child { border-bottom: 0; }
    .loqii-account-purchase-name { color: var(--text-primary); font-size: .8rem; font-weight: 850; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .loqii-account-purchase-date,
    .loqii-account-purchase-price { color: var(--text-secondary); font-size: .72rem; }
    .loqii-account-purchase-credits { color: var(--accent-primary); font-size: .8rem; font-weight: 900; text-align: right; }
    .loqii-account-purchase-price { text-align: right; }
    @media (max-width: 560px) {
      .loqii-account-summary,
      .loqii-account-actions { grid-template-columns: 1fr; }
      .loqii-account-profile { grid-column: span 1; }
      .loqii-account-history-head { display: none; }
      .loqii-account-purchase { grid-template-columns: 1fr; gap: 4px; }
      .loqii-account-purchase-credits,
      .loqii-account-purchase-price { text-align: left; }
    }
  `;
  document.head.appendChild(style);
}

export function LoqiiDrawer({ title = "Loqii", body = "", width = 520, onClose } = {}) {
  injectDrawerStyles();
  document.querySelectorAll(".loqii-drawer-overlay").forEach((el) => el.remove());
  const overlay = document.createElement("div");
  overlay.className = "loqii-drawer-overlay";
  applyThemeToOverlayRoot(overlay);
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
