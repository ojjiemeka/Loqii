export const SESSION_STATES = Object.freeze({
  IDLE: "idle",
  CONNECTING: "connecting",
  CONNECTED: "connected",
  STREAMING: "streaming",
  RECORDING: "recording",
  RECONNECTING: "reconnecting",
  DISCONNECTED: "disconnected",
  FAILED: "failed",
  STOPPING: "stopping",
});

const ACTIVE_STATES = new Set([
  SESSION_STATES.CONNECTING,
  SESSION_STATES.CONNECTED,
  SESSION_STATES.STREAMING,
  SESSION_STATES.RECORDING,
  SESSION_STATES.RECONNECTING,
]);

const STOPPABLE_STATES = new Set([
  SESSION_STATES.CONNECTING,
  SESSION_STATES.CONNECTED,
  SESSION_STATES.STREAMING,
  SESSION_STATES.RECORDING,
  SESSION_STATES.RECONNECTING,
  SESSION_STATES.FAILED,
]);

let currentState = {
  value: SESSION_STATES.IDLE,
  previous: null,
  reason: "initial",
  updatedAt: Date.now(),
  meta: {},
};

const listeners = new Set();

export function getSessionState() {
  return { ...currentState, meta: { ...currentState.meta } };
}

export function isSessionActive(state = currentState.value) {
  return ACTIVE_STATES.has(state);
}

export function canStartSession(state = currentState.value) {
  return state === SESSION_STATES.IDLE ||
    state === SESSION_STATES.DISCONNECTED ||
    state === SESSION_STATES.FAILED;
}

export function canStopSession(state = currentState.value) {
  return STOPPABLE_STATES.has(state);
}

export function canRecordSession(state = currentState.value) {
  return state === SESSION_STATES.STREAMING ||
    state === SESSION_STATES.RECORDING;
}

export function setSessionState(nextState, meta = {}) {
  if (!Object.values(SESSION_STATES).includes(nextState)) {
    throw new Error(`Unknown session state: ${nextState}`);
  }

  if (currentState.value === SESSION_STATES.STOPPING && nextState === SESSION_STATES.CONNECTING) {
    return getSessionState();
  }

  const previous = currentState.value;
  currentState = {
    value: nextState,
    previous,
    reason: meta.reason || "",
    updatedAt: Date.now(),
    meta: { ...meta },
  };

  const snapshot = getSessionState();
  listeners.forEach((listener) => {
    try { listener(snapshot); } catch (err) { console.error("[sessionState]", err); }
  });
  return snapshot;
}

export function subscribeSessionState(listener, options = {}) {
  if (typeof listener !== "function") return () => {};
  listeners.add(listener);
  if (options.immediate !== false) listener(getSessionState());
  return () => listeners.delete(listener);
}
