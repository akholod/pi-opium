// Live activity of a run, read from pi-agent-runner's process-wide registry.

import { isPossiblyStuck, liveRuns, type LiveRun } from 'pi-agent-runner';
import type { RunRecord } from './runs.ts';

export type LiveLookup = (run: RunRecord) => LiveRun | undefined;

// only a run whose handle is retained has a child session to look up
export const defaultLive: LiveLookup = (run) =>
  run.retained && run.sessionId !== undefined
    ? liveRuns()
        .list()
        .find((live) => live.id === run.sessionId)
    : undefined;

export const stuck = (
  live: LiveLookup,
  run: RunRecord,
  now: number,
): boolean => {
  const found = live(run);
  return found !== undefined && isPossiblyStuck(found, now);
};
