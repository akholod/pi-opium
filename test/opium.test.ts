import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { buildOrchestratorPrompt } from '../src/prompt.ts';
import { runCouncil, type Delegate } from '../src/council.ts';
import { readState, writeState, DEFAULT_STATE } from '../src/state.ts';
import type { DelegateOptions, DelegationResponse } from '../src/delegation.ts';

const pi = {} as ExtensionAPI;

test('orchestrator prompt lists the roster and drops disabled agents', () => {
  const full = buildOrchestratorPrompt();
  for (const name of [
    'explorer',
    'librarian',
    'oracle',
    'designer',
    'fixer',
    'fast-generic',
    'council',
    'observer',
  ]) {
    assert.ok(full.includes(`\n${name}`), name);
  }
  assert.match(full, /subagent\(\{ agent: "<name>"/);
  assert.ok(!full.includes('ralplan'));
  assert.ok(!full.includes('ralph'));
  const trimmed = buildOrchestratorPrompt({
    disabled: ['designer', 'observer'],
  });
  assert.ok(!trimmed.includes('\ndesigner\n'));
  assert.ok(!trimmed.includes('observer + explorer'));
  assert.ok(trimmed.includes('multiple fixer instances'));
});

test('state round-trips and defaults to on', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'opium-')), 'opium.json');
  assert.deepEqual(readState(path), DEFAULT_STATE);
  writeState(path, { orchestrator: false });
  assert.deepEqual(readState(path), { orchestrator: false });
});

const fake = (answers: Record<string, DelegationResponse['status']> = {}) => {
  const calls: DelegateOptions[] = [];
  const delegateFn: Delegate = async (_pi, request) => {
    calls.push(request);
    const status = answers[request.agent] ?? 'completed';
    if (status !== 'completed') return { requestId: 'r', status };
    const text =
      request.agent === 'council'
        ? `## Council Response\nsynth of: ${request.task.split('# Councillor responses')[1]?.replace(/\s+/g, ' ').trim()}`
        : `${request.agent} says hi`;
    return {
      requestId: 'r',
      status: 'completed',
      model: `m/${request.agent}`,
      result: { kind: 'text', text },
      usage: {
        input: 5,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.01,
        turns: 1,
        toolCalls: 0,
        durationMs: 1,
      },
    };
  };
  return { delegateFn, calls };
};

test('council: councillors in parallel, then synthesis', async () => {
  const f = fake();
  const result = await runCouncil({
    pi,
    cwd: '/tmp',
    question: 'tabs or spaces?',
    context: 'see .editorconfig',
    delegateFn: f.delegateFn,
  });
  assert.equal(result.outcome, 'completed', result.error);
  assert.deepEqual(
    f.calls.map((c) => c.agent),
    ['councillor-alpha', 'councillor-beta', 'councillor-gamma', 'council'],
  );
  // one owner, distinct nodes
  assert.equal(new Set(f.calls.map((c) => c.ownerRunId)).size, 1);
  assert.equal(new Set(f.calls.map((c) => c.nodeId)).size, 4);
  assert.match(f.calls[0].task, /see \.editorconfig/);
  const synthesisTask = f.calls[3].task;
  assert.match(synthesisTask, /## Councillor alpha \(m\/councillor-alpha\)/);
  assert.match(synthesisTask, /councillor-gamma says hi/);
  assert.match(result.report, /^## Council Response/);
  assert.equal(result.usage.runs, 4);
  assert.equal(result.seats.length, 3);
});

test('council: a failed seat is reported, synthesis still runs', async () => {
  const f = fake({ 'councillor-beta': 'timed_out' });
  const result = await runCouncil({
    pi,
    cwd: '/tmp',
    question: 'q',
    delegateFn: f.delegateFn,
  });
  assert.equal(result.outcome, 'completed', result.error);
  assert.equal(result.seats[1].ok, false);
  assert.match(f.calls[3].task, /\[no answer: timed_out\]/);
});

test('council: all seats failed -> failed; cancelled -> aborted', async () => {
  const dead = fake({
    'councillor-alpha': 'failed',
    'councillor-beta': 'failed',
    'councillor-gamma': 'timed_out',
  });
  const failed = await runCouncil({
    pi,
    cwd: '/tmp',
    question: 'q',
    delegateFn: dead.delegateFn,
  });
  assert.equal(failed.outcome, 'failed');
  assert.equal(dead.calls.length, 3);

  const cancelled = fake({ 'councillor-gamma': 'cancelled' });
  const aborted = await runCouncil({
    pi,
    cwd: '/tmp',
    question: 'q',
    delegateFn: cancelled.delegateFn,
  });
  assert.equal(aborted.outcome, 'aborted');
});
