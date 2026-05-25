import {
  SESSION_STATES,
  canRecordSession,
  canStartSession,
  canStopSession,
  isSessionActive,
} from "./sessionState.js";

export function describeSessionState(state) {
  const value = typeof state === "string" ? state : state?.value;
  switch (value) {
    case SESSION_STATES.CONNECTING: return { badge: "connecting", label: "Connecting..." };
    case SESSION_STATES.CONNECTED: return { badge: "connected", label: "Connected" };
    case SESSION_STATES.STREAMING: return { badge: "connected", label: "Streaming live" };
    case SESSION_STATES.RECORDING: return { badge: "connected", label: "Recording" };
    case SESSION_STATES.RECONNECTING: return { badge: "connecting", label: "Reconnecting..." };
    case SESSION_STATES.FAILED: return { badge: "error", label: "Session failed" };
    case SESSION_STATES.STOPPING: return { badge: "connecting", label: "Stopping..." };
    case SESSION_STATES.DISCONNECTED:
    case SESSION_STATES.IDLE:
    default: return { badge: "", label: "Disconnected" };
  }
}

export function getActionAvailability(state, flags = {}) {
  const value = typeof state === "string" ? state : state?.value;
  const active = isSessionActive(value);
  const promptReady = value === SESSION_STATES.CONNECTED ||
    value === SESSION_STATES.STREAMING ||
    value === SESSION_STATES.RECORDING ||
    value === SESSION_STATES.RECONNECTING;
  return {
    start: canStartSession(value) && !flags.starting && !flags.stopping,
    stop: canStopSession(value) && !flags.stopping,
    applyPrompt: promptReady && !flags.applying,
    applyScene: active || flags.hasQueuedScene,
    record: canRecordSession(value) && !flags.recordingBlocked,
  };
}
