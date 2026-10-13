// Background Job Board: a compact digest of the run registry injected into
// the orchestrator's context when it changes. Pure over run records.

import { defaultLive, stuck, type LiveLookup } from './live.ts';
import type { RunRecord } from './runs.ts';

const TEXT_LIMIT = 100;
const REVIVABLE_WINDOW_MS = 30 * 60 * 1000;
const REVIVABLE_MAX = 5;

const truncate = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit - 1)}…` : text;

const isActive = (run: RunRecord): boolean =>
  run.state === 'starting' || run.state === 'running';

const age = (ms: number): string => {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return `${Math.floor(Math.max(0, ms) / 1000)}s`;
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
};

interface Sections {
  running: RunRecord[];
  unread: RunRecord[];
  revivable: RunRecord[];
}

const sections = (runs: RunRecord[], now: number): Sections => {
  const running = runs.filter(isActive);
  const unread = runs.filter((run) => !isActive(run) && run.unread);
  const revivable = runs
    .filter(
      (run) =>
        !isActive(run) &&
        !run.unread &&
        run.retained &&
        now - run.lastUsedAt <= REVIVABLE_WINDOW_MS,
    )
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    .slice(0, REVIVABLE_MAX);
  return { running, unread, revivable };
};

const unreadLine = (run: RunRecord): string => {
  const base = `- ${run.id} ${run.agent} ${run.state}`;
  if (run.state !== 'failed' && run.state !== 'timed_out') return base;
  const error = run.error ?? run.result?.error;
  return error ? `${base} — ${truncate(error, TEXT_LIMIT)}` : base;
};

export const formatBoard = (
  runs: RunRecord[],
  now: number,
  live: LiveLookup = defaultLive,
): string | undefined => {
  const { running, unread, revivable } = sections(runs, now);
  const blocks: string[] = [];
  if (running.length) {
    blocks.push(
      [
        'Running:',
        ...running.map(
          (run) =>
            `- ${run.id} ${run.agent} ${run.state} ${age(
              now - run.startedAt,
            )} — ${truncate(run.objective, TEXT_LIMIT)}${
              stuck(live, run, now) ? ' (possibly stuck)' : ''
            }`,
        ),
      ].join('\n'),
    );
  }
  if (unread.length) {
    blocks.push(
      [
        'Finished, result unread (read with agent_result):',
        ...unread.map(unreadLine),
      ].join('\n'),
    );
  }
  if (revivable.length) {
    blocks.push(
      [
        'Revivable (continue with agent_revive):',
        ...revivable.map((run) => `- ${run.id} ${run.agent} ${run.state}`),
      ].join('\n'),
    );
  }
  const closing =
    'Results are delivered automatically; do not poll agent_status in a loop.';
  const body = [...blocks, closing].join('\n\n');
  const head = '<system-reminder>\n### Background Job Board\n';
  return blocks.length ? `${head}${body}\n</system-reminder>` : undefined;
};

// Stable over everything the board shows except ages and times; '' when the
// board is empty. `now` only decides which runs are still revivable.
export const boardFingerprint = (
  runs: RunRecord[],
  now: number = Date.now(),
  live: LiveLookup = defaultLive,
): string => {
  const { running, unread, revivable } = sections(runs, now);
  return [...running, ...unread, ...revivable]
    .map((run) =>
      [
        run.id,
        run.state,
        run.generation,
        Number(run.unread),
        Number(run.retained),
        Number(stuck(live, run, now)),
      ].join(':'),
    )
    .join('|');
};
