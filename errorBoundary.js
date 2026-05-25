export function createErrorBoundary(options = {}) {
  const log = options.log || (() => {});
  const showStatus = options.showStatus || (() => {});

  function capture(scope, err, recovery) {
    const error = err instanceof Error ? err : new Error(String(err || "Unknown error"));
    log(`${scope} failed: ${error.message}`, "error");
    showStatus(`${scope} failed`, { level: "error", persist: true });
    if (typeof recovery === "function") {
      try { recovery(error); } catch (recoveryErr) { log(`${scope} recovery failed: ${recoveryErr.message}`, "error"); }
    }
    return error;
  }

  async function guard(scope, fn, recovery) {
    try {
      return await fn();
    } catch (err) {
      capture(scope, err, recovery);
      return null;
    }
  }

  return { capture, guard };
}
