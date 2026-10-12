// Persistent on/off switch for the orchestrator prompt:
// `~/.pi/agent/opium.json` -> { "orchestrator": true }. Default on.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface CrewState {
  orchestrator: boolean;
}

export const DEFAULT_STATE: CrewState = { orchestrator: true };

export const statePath = (configDirName: string, homeDir = homedir()): string =>
  join(homeDir, configDirName, 'agent', 'opium.json');

export const readState = (path: string): CrewState => {
  if (!existsSync(path)) return DEFAULT_STATE;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<CrewState>;
    return {
      orchestrator:
        typeof raw.orchestrator === 'boolean'
          ? raw.orchestrator
          : DEFAULT_STATE.orchestrator,
    };
  } catch {
    return DEFAULT_STATE;
  }
};

export interface WakeSettings {
  enabled: boolean;
  intervalMs: number;
}

export const DEFAULT_WAKE: WakeSettings = {
  enabled: true,
  intervalMs: 300_000,
};

// `wake: { enabled?, intervalMs? }` in the same file; invalid values fall
// back to the defaults.
export const readWakeSettings = (path: string): WakeSettings => {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      wake?: { enabled?: unknown; intervalMs?: unknown };
    } | null;
    const wake = raw?.wake;
    if (typeof wake !== 'object' || wake === null) return DEFAULT_WAKE;
    const { enabled, intervalMs } = wake;
    return {
      enabled: typeof enabled === 'boolean' ? enabled : DEFAULT_WAKE.enabled,
      intervalMs:
        typeof intervalMs === 'number' &&
        Number.isFinite(intervalMs) &&
        intervalMs > 0
          ? intervalMs
          : DEFAULT_WAKE.intervalMs,
    };
  } catch {
    return DEFAULT_WAKE;
  }
};

// Keeps other keys already in the file (e.g. per-agent `agents` overrides).
export const writeState = (path: string, state: CrewState): void => {
  let existing: Record<string, unknown> = {};
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      existing = raw as Record<string, unknown>;
    }
  } catch {
    // missing or unreadable: start fresh
  }
  mkdirSync(dirname(path), { recursive: true });
  const merged = { ...existing, ...state };
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
};
