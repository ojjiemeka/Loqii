let stylesInjected = false;

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function injectModalStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    .loqii-overlay {
      position: fixed; inset: 0; z-index: 9800;
      display: flex; align-items: center; justify-content: center;
      padding: 20px; background: rgba(1,22,39,.72);
      backdrop-filter: blur(8px);
    }
    .loqii-modal {
      width: min(520px, 100%);
      max-height: min(82vh, 680px);
      display: flex; flex-direction: column; overflow: hidden;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--surface);
      color: var(--text);
      box-shadow: 0 28px 80px var(--shadow);
    }
    .loqii-modal-header {
      flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between;
      gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--border);
    }
    .loqii-modal-title { font-size: .92rem; font-weight: 850; color: var(--text); }
    .loqii-modal-close {
      width: 28px; height: 28px; border-radius: 7px; border: 1px solid var(--border);
      background: var(--surface2); color: var(--muted); cursor: pointer; font: inherit;
    }
    .loqii-modal-close:hover { color: var(--text); border-color: rgba(63,108,81,.45); }
    .loqii-modal-body {
      flex: 1 1 auto; min-height: 0; overflow-y: auto;
      padding: 15px 16px; color: var(--muted); line-height: 1.55;
    }
    .loqii-modal-body strong { color: var(--text); }
    .loqii-modal-input {
      width: 100%; margin-top: 10px; padding: 9px 10px; border-radius: 7px;
      border: 1px solid var(--border); background: var(--field); color: var(--text);
      font: inherit; outline: none;
    }
    .loqii-modal-footer {
      flex: 0 0 auto; display: flex; justify-content: flex-end; gap: 8px;
      padding: 12px 16px; border-top: 1px solid var(--border);
    }
    .loqii-btn {
      border: 1px solid var(--border); border-radius: 7px; padding: 7px 12px;
      background: var(--surface2); color: var(--text); cursor: pointer;
      font: inherit; font-size: .78rem; font-weight: 800;
    }
    .loqii-btn:hover { border-color: rgba(63,108,81,.45); box-shadow: 0 0 14px rgba(63,108,81,.10); }
    .loqii-btn-primary { background: var(--loqii-green); border-color: var(--loqii-green); color: var(--loqii-paper); }
    .loqii-btn-danger { background: rgba(201,112,100,.14); border-color: rgba(201,112,100,.48); color: var(--loqii-coral); }
    .loqii-empty, .loqii-loading {
      border: 1px dashed var(--border); border-radius: 9px; padding: 18px;
      text-align: center; color: var(--muted); background: var(--surface2);
    }
    .loqii-section {
      border: 1px solid var(--border); border-radius: 9px; background: var(--surface2);
      padding: 11px; margin-bottom: 10px;
    }
    .loqii-section-title {
      color: var(--text); font-size: .74rem; font-weight: 850; margin-bottom: 7px;
      text-transform: uppercase; letter-spacing: .06em;
    }
    .loqii-section-copy { color: var(--muted); font-size: .76rem; line-height: 1.5; }
    .loqii-loading::before {
      content: ""; display: inline-block; width: 12px; height: 12px; margin-right: 8px;
      border: 2px solid rgba(247,243,227,.22); border-top-color: var(--loqii-green);
      border-radius: 50%; animation: loqiiSpin .8s linear infinite; vertical-align: -2px;
    }
    @keyframes loqiiSpin { to { transform: rotate(360deg); } }
  `;
  document.head.appendChild(style);
}

export function LoqiiEmptyState(message = "Nothing to show yet.") {
  return `<div class="loqii-empty">${escapeHtml(message)}</div>`;
}

export function LoqiiLoadingState(message = "Loading...") {
  return `<div class="loqii-loading">${escapeHtml(message)}</div>`;
}

export function LoqiiModal(options = {}) {
  injectModalStyles();
  const {
    title = "Loqii",
    body = "",
    confirmLabel = "OK",
    cancelLabel = "Cancel",
    cancelable = true,
    danger = false,
    input = false,
    defaultValue = "",
    width = 520,
  } = options;

  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "loqii-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.innerHTML = `
      <section class="loqii-modal" style="width:min(${Number(width) || 520}px,100%)">
        <header class="loqii-modal-header">
          <div class="loqii-modal-title">${escapeHtml(title)}</div>
          ${cancelable ? `<button class="loqii-modal-close" type="button" data-loqii-cancel aria-label="Close">x</button>` : ""}
        </header>
        <div class="loqii-modal-body">
          ${typeof body === "string" ? body : ""}
          ${input ? `<input class="loqii-modal-input" data-loqii-input type="text" value="${escapeHtml(defaultValue)}">` : ""}
        </div>
        <footer class="loqii-modal-footer">
          ${cancelable ? `<button class="loqii-btn" type="button" data-loqii-cancel>${escapeHtml(cancelLabel)}</button>` : ""}
          <button class="loqii-btn loqii-btn-primary ${danger ? "loqii-btn-danger" : ""}" type="button" data-loqii-confirm>${escapeHtml(confirmLabel)}</button>
        </footer>
      </section>`;
    document.body.appendChild(overlay);

    const finish = (confirmed) => {
      const value = input && confirmed ? overlay.querySelector("[data-loqii-input]")?.value || "" : null;
      overlay.remove();
      resolve(input ? (confirmed ? value : null) : confirmed);
    };
    const onKey = (event) => {
      if (!document.body.contains(overlay)) return document.removeEventListener("keydown", onKey);
      if (event.key === "Escape" && cancelable) finish(false);
      if (event.key === "Enter" && !event.shiftKey && event.target?.tagName !== "TEXTAREA") finish(true);
    };
    document.addEventListener("keydown", onKey);
    overlay.addEventListener("click", (event) => { if (event.target === overlay && cancelable) finish(false); });
    overlay.querySelectorAll("[data-loqii-cancel]").forEach((btn) => btn.addEventListener("click", () => finish(false)));
    overlay.querySelector("[data-loqii-confirm]")?.addEventListener("click", () => finish(true));
    setTimeout(() => overlay.querySelector("[data-loqii-input]")?.focus(), 40);
  });
}

export function LoqiiConfirm(message, options = {}) {
  return LoqiiModal({
    ...options,
    body: `<p>${escapeHtml(message)}</p>`,
    confirmLabel: options.confirmLabel || "Confirm",
    cancelable: true,
  });
}
