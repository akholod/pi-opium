// Idle wake: while the parent is idle and background work is running or
// unread, nudge the orchestrator every few minutes, at most `cap` times
// for an unchanged job board. Testable without Pi (timers are injected).

export const WAKE_TEXT =
  '<system-reminder>\nBackground agents are still running or have unread ' +
  'results. Await running agents; if one appears stuck, check it with ' +
  'agent_status and cancel or revive only when justified. Read unread ' +
  'results with agent_result. Do not respond to this reminder.\n' +
  '</system-reminder>';

export const DEFAULT_WAKE_INTERVAL_MS = 300_000;
const DEFAULT_CAP = 2;

export interface WakeSnapshot {
  active: boolean;
  fingerprint: string;
}

export interface WakeConfig {
  intervalMs?: number;
  cap?: number;
  snapshot: () => WakeSnapshot;
  send: (text: string) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface Wake {
  settled(): void;
  busy(): void;
  userInput(): void;
  waitForUser(): void;
  stop(): void;
}

export const createWake = (config: WakeConfig): Wake => {
  const intervalMs = config.intervalMs ?? DEFAULT_WAKE_INTERVAL_MS;
  const cap = config.cap ?? DEFAULT_CAP;
  const setTimer =
    config.setTimer ??
    ((fn: () => void, ms: number): unknown => setTimeout(fn, ms).unref());
  const clearTimer =
    config.clearTimer ??
    ((handle: unknown): void => clearTimeout(handle as NodeJS.Timeout));

  let timer: unknown;
  let armed = false;
  let latched = false;
  let stopped = false;
  // wakes sent in a row for the same fingerprint, and that fingerprint
  let count = 0;
  let lastFingerprint: string | undefined;
  let wakeSent = false;

  const clear = (): void => {
    if (armed) clearTimer(timer);
    armed = false;
    timer = undefined;
  };

  const exhausted = (fingerprint: string): boolean =>
    fingerprint === lastFingerprint && count >= cap;

  const fire = (): void => {
    armed = false;
    timer = undefined;
    if (latched || stopped) return;
    const s = config.snapshot();
    if (!s.active || exhausted(s.fingerprint)) return;
    count = s.fingerprint === lastFingerprint ? count + 1 : 1;
    lastFingerprint = s.fingerprint;
    wakeSent = true;
    config.send(WAKE_TEXT);
  };

  return {
    settled() {
      if (latched || stopped || armed) return;
      const s = config.snapshot();
      if (!s.active || exhausted(s.fingerprint)) return;
      timer = setTimer(fire, intervalMs);
      armed = true;
    },
    busy() {
      clear();
      if (!wakeSent) {
        count = 0;
        lastFingerprint = undefined;
      }
      wakeSent = false;
    },
    userInput() {
      count = 0;
      lastFingerprint = undefined;
      latched = false;
    },
    waitForUser() {
      latched = true;
      clear();
    },
    stop() {
      stopped = true;
      clear();
    },
  };
};
