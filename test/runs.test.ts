import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentHandle,
  GenerationResult,
  QueueDisposition,
  RunStatus,
  TurnOptions,
} from 'pi-agent-runner';
import type { AgentDefinition } from '../src/agents.ts';
import {
  RunRefusal,
  RunRegistry,
  type RunRecord,
  type StartOptions,
} from '../src/runs.ts';

const def = (name = 'fixer'): AgentDefinition =>
  ({ name, models: ['inherit'], skills: [], packages: [] }) as never;

const gen = (status: RunStatus = 'completed'): GenerationResult => ({
  status,
  value: 'v',
  dropped: [],
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 1,
    toolCalls: 0,
    durationMs: 1,
    waitedMs: 0,
  },
});

class FakeHandle implements AgentHandle {
  sessionId = 's';
  state: 'idle' | 'running' | 'disposed' = 'idle';
  tasks: string[] = [];
  turns: (TurnOptions | undefined)[] = [];
  queued: string[] = [];
  steered: string[] = [];
  disposed = 0;
  aborted = 0;
  // when set, run() waits for release(status)
  manual = false;
  private resolve?: (r: GenerationResult) => void;

  run(task: string, options?: TurnOptions): Promise<GenerationResult> {
    this.tasks.push(task);
    this.turns.push(options);
    this.state = 'running';
    if (!this.manual) {
      this.state = 'idle';
      return Promise.resolve(gen());
    }
    return new Promise((resolve) => {
      this.resolve = (r) => {
        this.state = 'idle';
        resolve(r);
      };
    });
  }
  release(status: RunStatus = 'completed'): void {
    this.resolve?.(gen(status));
  }
  steer(text: string): Promise<QueueDisposition> {
    this.steered.push(text);
    return Promise.resolve('queued');
  }
  followUp(text: string): Promise<QueueDisposition> {
    this.queued.push(text);
    return Promise.resolve('queued');
  }
  abort(): Promise<void> {
    this.aborted += 1;
    this.release('cancelled');
    return Promise.resolve();
  }
  dispose(): Promise<void> {
    this.disposed += 1;
    this.state = 'disposed';
    this.release('cancelled');
    return Promise.resolve();
  }
}

interface Harness {
  reg: RunRegistry;
  handles: FakeHandle[];
  starts: StartOptions[];
  terminal: RunRecord[];
  dir: string;
}

const setup = (
  opts: {
    manual?: boolean;
    max?: number;
    dir?: string;
    fail?: boolean;
  } = {},
): Harness => {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'opium-runs-'));
  const handles: FakeHandle[] = [];
  const starts: StartOptions[] = [];
  const terminal: RunRecord[] = [];
  let clock = 0;
  let n = 0;
  const reg = new RunRegistry({
    runsDir: dir,
    maxSessionsPerAgent: opts.max,
    now: () => (clock += 1),
    newId: () => `r-${(n += 1)}`,
    onTerminal: (run) => terminal.push(run),
    start: (_def, options) => {
      starts.push(options);
      if (opts.fail) return Promise.reject(new Error('no model'));
      const handle = new FakeHandle();
      handle.manual = opts.manual ?? false;
      handles.push(handle);
      // the runner creates the session file
      const file = options.transcriptPath ?? options.resumeFrom;
      if (file) writeFileSync(file, '');
      return Promise.resolve({
        handle,
        turn: { timeoutMs: 9 },
        warnings: ['w'],
      });
    },
  });
  return { reg, handles, starts, terminal, dir };
};

const bg = { background: true, cwd: '/w' };
const tick = (): Promise<void> =>
  new Promise((r) => {
    setImmediate(r);
  });

test('spawn and complete: unread, onTerminal once, metadata', async () => {
  const h = setup();
  const { run, done } = h.reg.spawn(def(), '  do  the\nthing ', bg);
  assert.equal(run.state, 'starting');
  assert.equal(run.objective, 'do the thing');
  const final = await done;
  assert.equal(final, run);
  assert.equal(run.state, 'completed');
  assert.equal(run.unread, true);
  assert.equal(run.generation, 1);
  assert.equal(run.retained, true);
  assert.deepEqual(run.warnings, ['w']);
  assert.equal(h.terminal.length, 1);
  assert.equal(h.handles[0]?.turns[0]?.timeoutMs, 9);
  assert.equal(h.starts[0]?.transcriptPath, join(h.dir, 'r-1.jsonl'));
  assert.ok(existsSync(join(h.dir, 'r-1.json')));
  assert.equal(h.reg.result('r-1'), run);
  assert.equal(run.unread, false);
});

test('duplicates: refused while unread, allowed after read or while running', async () => {
  const h = setup();
  const first = h.reg.spawn(def(), 'same  task', bg);
  await first.done;
  assert.throws(
    () => h.reg.spawn(def(), 'same task', bg),
    (e) =>
      e instanceof RunRefusal &&
      e.code === 'duplicate' &&
      e.message.includes('run r-1 (fixer) already finished'),
  );
  // another agent is fine
  await h.reg.spawn(def('other'), 'same task', bg).done;
  h.reg.markRead('r-1');
  await h.reg.spawn(def(), 'same task', bg).done;

  const m = setup({ manual: true });
  m.reg.spawn(def(), 'x', bg);
  await tick();
  m.reg.spawn(def(), 'x', bg);
  assert.equal(m.reg.list().length, 2);
});

test('cap evicts least recently used terminal, never running', async () => {
  const h = setup({ max: 2 });
  await h.reg.spawn(def(), 'a', bg).done;
  await h.reg.spawn(def(), 'b', bg).done;
  await h.reg.spawn(def(), 'c', bg).done;
  assert.equal(h.handles[0]?.disposed, 1);
  assert.equal(h.reg.get('r-1')?.retained, false);
  assert.equal(h.reg.get('r-2')?.retained, true);
  assert.equal(h.reg.get('r-3')?.retained, true);

  const m = setup({ manual: true, max: 1 });
  m.reg.spawn(def(), 'a', bg);
  m.reg.spawn(def(), 'b', bg);
  await tick();
  m.handles[0]?.release();
  await tick();
  // r-1 is terminal and over the cap; r-2 still runs and is kept
  assert.equal(m.reg.get('r-1')?.retained, false);
  assert.equal(m.reg.get('r-2')?.retained, true);
  assert.equal(m.handles[1]?.disposed, 0);
});

test('cancel keeps the session; revive runs generation 2 on it', async () => {
  const h = setup({ manual: true });
  const { run, done } = h.reg.spawn(def(), 'work', bg);
  await tick();
  assert.equal(run.state, 'running');
  assert.equal(await h.reg.cancel('r-1'), 'cancelled');
  await done;
  assert.equal(run.state, 'cancelled');
  assert.equal(run.retained, true);
  assert.equal(await h.reg.cancel('r-1'), 'not_running');
  assert.equal(await h.reg.cancel('nope'), 'unknown');

  const again = h.reg.revive('r-1', 'more', def());
  assert.equal(again.run.generation, 2);
  assert.equal(again.run.unread, false);
  assert.equal(again.run.objective, 'work');
  assert.equal(again.run.task, 'more');
  await tick();
  h.handles[0]?.release();
  await again.done;
  assert.equal(h.handles.length, 1);
  assert.deepEqual(h.handles[0]?.tasks, ['work', 'more']);
  assert.equal(run.state, 'completed');
  assert.equal(run.unread, true);
  assert.equal(h.terminal.length, 2);
});

test('revive refused while running', async () => {
  const h = setup({ manual: true });
  h.reg.spawn(def(), 'work', bg);
  await tick();
  assert.throws(
    () => h.reg.revive('r-1', 'x', def()),
    (e) => e instanceof RunRefusal && e.code === 'running',
  );
  h.handles[0]?.release();
});

test('revive after eviction and after restart resumes the transcript', async () => {
  const h = setup({ max: 1 });
  await h.reg.spawn(def(), 'a', bg).done;
  await h.reg.spawn(def(), 'b', bg).done;
  assert.equal(h.reg.get('r-1')?.retained, false);
  const evicted = h.reg.revive('r-1', 'again', def());
  await evicted.done;
  assert.equal(h.starts.at(-1)?.resumeFrom, join(h.dir, 'r-1.jsonl'));
  assert.equal(h.reg.get('r-1')?.generation, 2);
  assert.equal(h.reg.get('r-1')?.retained, true);

  const fresh = setup({ dir: h.dir });
  // the owner of a pre-restart run comes from its metadata
  assert.equal(fresh.reg.agentOf('r-2'), 'fixer');
  assert.equal(fresh.reg.agentOf('zzz'), undefined);
  const { run, done } = fresh.reg.revive('r-2', 'back', def());
  await done;
  assert.equal(fresh.starts[0]?.resumeFrom, join(h.dir, 'r-2.jsonl'));
  assert.equal(run.agent, 'fixer');
  assert.equal(run.objective, 'b');
  assert.equal(run.generation, 2);
  assert.equal(run.state, 'completed');
});

test('revive without a transcript or unknown id is refused', async () => {
  const h = setup({ fail: true });
  await h.reg.spawn(def(), 'a', bg).done;
  assert.throws(
    () => h.reg.revive('r-1', 'x', def()),
    (e) => e instanceof RunRefusal && e.code === 'no_session',
  );
  assert.throws(
    () => h.reg.revive('zzz', 'x', def()),
    (e) => e instanceof RunRefusal && e.code === 'unknown',
  );
});

test('message dispositions', async () => {
  const h = setup({ max: 1 });
  assert.equal(await h.reg.message('x', 'hi', 'queue'), 'unknown');
  await h.reg.spawn(def(), 'a', bg).done;
  await h.reg.spawn(def(), 'b', bg).done;
  assert.equal(await h.reg.message('r-1', 'hi', 'queue'), 'not_retained');
  const long = `  ${'x'.repeat(3000)} `;
  assert.equal(await h.reg.message('r-2', long, 'queue'), 'queued');
  assert.equal(h.handles[1]?.queued[0]?.length, 2000);
  assert.equal(await h.reg.message('r-2', ' go ', 'steer'), 'queued');
  assert.deepEqual(h.handles[1]?.steered, ['go']);
});

test('shutdown disposes everything and blocks new work', async () => {
  const h = setup({ manual: true });
  const { run, done } = h.reg.spawn(def(), 'a', bg);
  await tick();
  await h.reg.shutdown();
  await done;
  await h.reg.shutdown();
  assert.equal(h.handles[0]?.disposed >= 1, true);
  assert.equal(run.retained, false);
  assert.ok(h.reg.get('r-1'));
  assert.throws(
    () => h.reg.spawn(def(), 'b', bg),
    (e) => e instanceof RunRefusal && e.code === 'shutdown',
  );
  assert.throws(
    () => h.reg.revive('r-1', 'b', def()),
    (e) => e instanceof RunRefusal && e.code === 'shutdown',
  );
});

test('start failure marks the run failed', async () => {
  const h = setup({ fail: true });
  const { run, done } = h.reg.spawn(def(), 'a', bg);
  await done;
  assert.equal(run.state, 'failed');
  assert.equal(run.error, 'no model');
  assert.equal(run.unread, true);
  assert.equal(run.retained, false);
  assert.equal(h.terminal.length, 1);
});
