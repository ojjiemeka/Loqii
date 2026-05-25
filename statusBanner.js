const DEFAULT_TIMEOUT = 3200;

export function createStatusBannerSystem(options = {}) {
  const root = options.root || document.body;
  const stack = document.createElement("div");
  stack.className = "status-stack";
  stack.setAttribute("aria-live", "polite");
  root.appendChild(stack);

  function showStatus(message, detail = {}) {
    if (!message) return null;
    const level = detail.level || "info";
    const persist = detail.persist === true || level === "error";
    const item = document.createElement("div");
    item.className = `status-pill status-${level}`;
    item.textContent = message;
    stack.prepend(item);

    while (stack.children.length > 4) stack.lastElementChild?.remove();

    if (!persist) {
      setTimeout(() => {
        item.classList.add("leaving");
        setTimeout(() => item.remove(), 180);
      }, detail.timeout || DEFAULT_TIMEOUT);
    }
    return item;
  }

  return {
    showStatus,
    clear() { stack.replaceChildren(); },
    destroy() { stack.remove(); },
  };
}
