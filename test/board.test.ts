import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boardFingerprint, formatBoard } from '../src/board.ts';
import type { RunRecord } from '../src/runs.ts';

const NOW = 10_000_000;
const MIN = 60_000;

const run = (over: Partial<RunRecord>): RunRecord => ({
  id: 'r-1',
  agent: 'fixer',
  objective: 'do it',
  task: 'do it',
  state: 'running',
  generation: 1,
  background: true,
  unread: false,
  warnings: [],
  retained: true,
  transcriptPath: '/tmp/x.jsonl',
  startedAt: NOW - 3 * MIN,
  lastUsedAt: NOW - 3 * MIN,
  cwd: '/tmp',
  ...over,
});

test('empty board is undefined with an empty fingerprint', () => {
  assert.equal(formatBoard([], NOW), undefined);
  assert.equal(boardFingerprint([], NOW), '');
  const old = run({ state: 'completed', lastUsedAt: NOW - 40 * MIN });
  assert.equal(formatBoard([old], NOW), undefined);
  assert.equal(boardFingerprint([old], NOW), '');
});

test('running, unread and revivable sections', () => {
  const text = formatBoard(
    [
      run({ id: 'r-run', objective: 'x'.repeat(150) }),
      run({
        id: 'r-bad',
        state: 'failed',
        unread: true,
        error: 'e'.repeat(150),
      }),
      run({ id: 'r-ok', state: 'completed', unread: true }),
      run({ id: 'r-rev', state: 'completed', lastUsedAt: NOW - MIN }),
    ],
    NOW,
  ) as string;
  assert.ok(text.startsWith('<system-reminder>\n### Background Job Board\n'));
  assert.ok(text.endsWith('</system-reminder>'));
  assert.match(text, /Running:\n- r-run fixer running 3m — x{99}…\n/);
  assert.match(text, /Finished, result unread.*agent_result/);
  assert.match(text, /- r-bad fixer failed — e{99}…/);
  assert.match(text, /- r-ok fixer completed\n/);
  assert.match(text, /Revivable.*agent_revive\):\n- r-rev fixer completed/);
  assert.match(text, /do not poll agent_status in a loop/);
});

test('sections are omitted when empty; revivable is capped at 5', () => {
  const revivable = Array.from({ length: 7 }, (_, i) =>
    run({ id: `r-${i}`, state: 'completed', lastUsedAt: NOW - i * 1000 }),
  );
  const text = formatBoard(revivable, NOW) as string;
  assert.doesNotMatch(text, /Running:/);
  assert.doesNotMatch(text, /unread/);
  assert.equal(text.match(/^- r-/gm)?.length, 5);
  assert.doesNotMatch(text, /r-6/);
});

test('fingerprint ignores time but tracks state', () => {
  const a = run({});
  assert.equal(
    boardFingerprint([a], NOW),
    boardFingerprint([{ ...a, startedAt: 1 }], NOW + 5 * MIN),
  );
  assert.notEqual(
    boardFingerprint([a], NOW),
    boardFingerprint([{ ...a, state: 'completed', unread: true }], NOW),
  );
});
