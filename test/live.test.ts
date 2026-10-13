import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STUCK_AFTER_MS, type LiveRun } from 'pi-agent-runner';
import { boardFingerprint, formatBoard } from '../src/board.ts';
import type { LiveLookup } from '../src/live.ts';
import type { RunRecord } from '../src/runs.ts';
import { agentStatus, type ToolDeps } from '../src/tools.ts';

const NOW = 10_000_000;

const record = (over: Partial<RunRecord> = {}): RunRecord => ({
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
  sessionId: 's-1',
  transcriptPath: '/tmp/x.jsonl',
  startedAt: NOW - 600_000,
  lastUsedAt: NOW - 600_000,
  cwd: '/tmp',
  ...over,
});

const liveRun = (stuck: boolean): LiveRun => ({
  id: 's-1',
  name: 'fixer',
  state: 'running',
  waitingForUser: false,
  currentTool: 'bash',
  turns: 2,
  toolCalls: 3,
  tokens: { input: 100, output: 20 },
  cost: 0.1,
  generation: 1,
  startedAt: NOW - 600_000,
  lastActivityAt: NOW - 5000,
  lastStepAt: stuck ? NOW - STUCK_AFTER_MS : NOW - 1000,
});

const lookup =
  (stuck: boolean): LiveLookup =>
  (run) =>
    run.sessionId === 's-1' ? liveRun(stuck) : undefined;

const depsFor = (run: RunRecord, live: LiveLookup): ToolDeps =>
  ({
    registry: { get: () => run, list: () => [run] },
    now: () => NOW,
    live,
  }) as never as ToolDeps;

test('agent_status shows live activity and the stuck hint', () => {
  for (const stuck of [false, true]) {
    const text = agentStatus(depsFor(record(), lookup(stuck)), {
      id: 'r-1',
    }).text;
    assert.match(text, /\ntool: bash\n/);
    assert.match(text, /\nlast activity: 5s ago\n/);
    assert.match(text, /turns 2, tool calls 3, tokens 120/);
    const hint = /possibly stuck: no completed step for 120s; check with/;
    assert.equal(hint.test(text), stuck);
  }
});

test('agent_status without live data or for a terminal run', () => {
  const none = agentStatus(
    depsFor(record(), () => undefined),
    {
      id: 'r-1',
    },
  ).text;
  assert.doesNotMatch(none, /last activity|possibly stuck/);
  const done = agentStatus(
    depsFor(record({ state: 'completed' }), lookup(true)),
    { id: 'r-1' },
  ).text;
  assert.doesNotMatch(done, /last activity|possibly stuck/);
});

test('board marks stuck runs; fingerprint carries the flag, not ages', () => {
  const ok = formatBoard([record()], NOW, lookup(false))!;
  const bad = formatBoard([record()], NOW, lookup(true))!;
  assert.doesNotMatch(ok, /possibly stuck/);
  assert.match(bad, /do it \(possibly stuck\)/);
  assert.notEqual(
    boardFingerprint([record()], NOW, lookup(false)),
    boardFingerprint([record()], NOW, lookup(true)),
  );
  assert.equal(
    boardFingerprint([record()], NOW, lookup(false)),
    boardFingerprint([record()], NOW + 30_000, lookup(false)),
  );
});
