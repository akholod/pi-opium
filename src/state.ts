// Persistent on/off switch for the orchestrator prompt:
// `~/.pi/agent/crew.json` -> { "orchestrator": true }. Default on.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface CrewState {
  orchestrator: boolean;
}

export const DEFAULT_STATE: CrewState = { orchestrator: true };

export const statePath = (configDirName: string, homeDir = homedir()): string =>
  join(homeDir, configDirName, 'agent', 'crew.json');

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

export const writeState = (path: string, state: CrewState): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n', 'utf8');
};
