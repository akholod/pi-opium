// Persistent on/off switch for the orchestrator prompt:
// `~/.pi/agent/opium.json` -> { "orchestrator": true }. Default on.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

export interface CrewState {
  orchestrator: boolean;
}

export const DEFAULT_STATE: CrewState = { orchestrator: true };

// Pi's config directory: `~/.pi/agent`, or `PI_CODING_AGENT_DIR` when set
export const statePath = (agentDir = getAgentDir()): string =>
  join(agentDir, 'opium.json');

// Shipped defaults: every agent's runtime values, copied to the user's
// opium.json on first run.
export const DEFAULTS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'defaults',
  'opium.json',
);

// Copies the shipped defaults when the user has no opium.json yet. An
// existing file is never touched or merged.
export const seedDefaults = (
  path: string,
  defaultsPath = DEFAULTS_PATH,
): boolean => {
  if (existsSync(path) || !existsSync(defaultsPath)) return false;
  mkdirSync(dirname(path), { recursive: true });
  copyFileSync(defaultsPath, path);
  return true;
};

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

export interface PanesSettings {
  enabled: boolean;
  max: number;
  multiplexer: 'auto' | 'herdr' | 'tmux';
}

export const DEFAULT_PANES: PanesSettings = {
  enabled: true,
  max: 3,
  multiplexer: 'auto',
};

// `panes: false` or `panes: { enabled?, max?, multiplexer? }`; live agent
// panes open only inside herdr or tmux. Invalid values fall back to the
// defaults.
export const readPanesSettings = (path: string): PanesSettings => {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      panes?: unknown;
    } | null;
    const panes = raw?.panes;
    if (panes === false) return { ...DEFAULT_PANES, enabled: false };
    if (typeof panes !== 'object' || panes === null) return DEFAULT_PANES;
    const { enabled, max, multiplexer } = panes as Record<string, unknown>;
    return {
      enabled: typeof enabled === 'boolean' ? enabled : DEFAULT_PANES.enabled,
      max:
        typeof max === 'number' && Number.isInteger(max) && max > 0
          ? max
          : DEFAULT_PANES.max,
      multiplexer:
        multiplexer === 'herdr' || multiplexer === 'tmux'
          ? multiplexer
          : DEFAULT_PANES.multiplexer,
    };
  } catch {
    return DEFAULT_PANES;
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
