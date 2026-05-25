export function createPerformanceMonitor() {
  const state = {
    fps: 0,
    reconnectCount: 0,
    decartRttMs: null,
    sessionStartedAt: null,
    droppedFrames: 0,
    streamLatencyMs: null,
    lastPromptUpdateAt: null,
  };

  return {
    startSession() {
      state.sessionStartedAt = Date.now();
      state.reconnectCount = 0;
      state.droppedFrames = 0;
      state.lastPromptUpdateAt = null;
    },
    stopSession() {
      state.sessionStartedAt = null;
      state.fps = 0;
      state.streamLatencyMs = null;
    },
    setFps(fps) {
      state.fps = Number.isFinite(Number(fps)) ? Number(fps) : 0;
      if (state.fps > 0 && state.fps < 10) state.droppedFrames += 1;
    },
    markReconnect() { state.reconnectCount += 1; },
    markPromptUpdate() { state.lastPromptUpdateAt = Date.now(); },
    markDecartRtt(ms) { state.decartRttMs = Number.isFinite(Number(ms)) ? Math.round(ms) : null; },
    markStreamLatency(ms) { state.streamLatencyMs = Number.isFinite(Number(ms)) ? Math.round(ms) : null; },
    getSnapshot() {
      const uptimeMs = state.sessionStartedAt ? Date.now() - state.sessionStartedAt : 0;
      return { ...state, uptimeMs };
    },
  };
}

export function formatDuration(ms) {
  const sec = Math.floor((ms || 0) / 1000);
  const min = Math.floor(sec / 60);
  return `${String(min).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
}
