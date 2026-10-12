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
