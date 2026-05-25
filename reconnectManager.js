export function createReconnectManager(options = {}) {
  const maxAttempts = options.maxAttempts || 4;
  const baseDelayMs = options.baseDelayMs || 900;
  let attempts = 0;
  let timer = null;
  let nextRetryAt = null;

  function clear() {
    if (timer) clearTimeout(timer);
    timer = null;
    nextRetryAt = null;
  }

  return {
    reset() {
      attempts = 0;
      clear();
    },
    noteReconnect(reason = "sdk_reconnecting") {
      attempts += 1;
      options.onAttempt?.({ attempts, maxAttempts, reason });
      if (attempts > maxAttempts) {
        clear();
        options.onExhausted?.({ attempts, maxAttempts, reason });
        return { exhausted: true, attempts, delayMs: 0 };
      }
      const delayMs = Math.min(8000, baseDelayMs * Math.pow(2, attempts - 1));
      nextRetryAt = Date.now() + delayMs;
      clear();
      timer = setTimeout(() => {
        timer = null;
        options.onTimer?.({ attempts, maxAttempts, reason });
      }, delayMs);
      return { exhausted: false, attempts, delayMs };
    },
    getSnapshot() {
      return {
        attempts,
        maxAttempts,
        nextRetryAt,
        secondsUntilRetry: nextRetryAt ? Math.max(0, Math.ceil((nextRetryAt - Date.now()) / 1000)) : 0,
      };
    },
  };
}
