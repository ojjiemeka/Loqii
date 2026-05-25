export function LoqiiToast(message, options = {}) {
  if (!message) return null;
  let stack = document.querySelector(".loqii-toast-stack");
  if (!stack) {
    stack = document.createElement("div");
    stack.className = "loqii-toast-stack status-stack";
    document.body.appendChild(stack);
  }
  const item = document.createElement("div");
  item.className = `status-pill status-${options.level || "info"}`;
  item.textContent = message;
  stack.prepend(item);
  if (options.persist !== true) {
    setTimeout(() => {
      item.classList.add("leaving");
      setTimeout(() => item.remove(), 180);
    }, options.timeout || 3200);
  }
  return item;
}
