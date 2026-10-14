import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentHandle,
  GenerationResult,
  QueueDisposition,
} from 'pi-agent-runner';
import type { AgentDefinition } from '../src/agents.ts';
import {
  createDelivery,
  type DeliveryMessage,
  type DeliveryOptions,
} from '../src/delivery.ts';
import { RunRegistry, type RunRecord } from '../src/runs.ts';

const record = (over: Partial<RunRecord> = {}): RunRecord => ({
  id: 'r-1',
  agent: 'fixer',
  objective: 'o',
  task: 'o',
  state: 'completed',
  generation: 1,
  background: true,
  unread: true,
  warnings: [],
  retained: true,
  transcriptPath: '/t.jsonl',
  startedAt: 1,
  lastUsedAt: 1,
  cwd: '/w',
  ...over,
});

interface Harness {
  sent: { message: DeliveryMessage; options: DeliveryOptions }[];
  read: string[];
  timers: (() => void)[];
  delays: number[];
  failures: { left: number };
  delivery: ReturnType<typeof createDelivery>;
}

const setup = (
  opts: { fail?: number; retries?: number; active?: () => boolean } = {},
): Harness => {
  const sent: Harness['sent'] = [];
  const read: string[] = [];
  const timers: (() => void)[] = [];
  const delays: number[] = [];
  const failures = { left: opts.fail ?? 0 };
  const delivery = createDelivery({
    send: (message, options) => {
      sent.push({ message, options });
      if (failures.left > 0) {
        failures.left -= 1;
        throw new Error('session gone');
      }
    },
    markRead: (id) => read.push(id),
    isActive: opts.active,
    retries: opts.retries,
    retryDelayMs: 7,
    setTimer: (fn, ms) => {
      timers.push(fn);
      delays.push(ms);
    },
  });
  return { sent, read, timers, delays, failures, delivery };
};

test('background terminal run: one steered turn-triggering send, read', () => {
  const h = setup();
  h.delivery.deliver(record());
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0]?.options, {
    triggerTurn: true,
    deliverAs: 'steer',
  });
  const { message } = h.sent[0] ?? {};
  assert.equal(message?.customType, 'opium-agent-result');
  assert.equal(message?.display, true);
  assert.match(message?.content ?? '', /^Background agent run finished\.\n/);
  assert.deepEqual(message?.details, {
    id: 'r-1',
    agent: 'fixer',
    state: 'completed',
    generation: 1,
  });
  assert.deepEqual(h.read, ['r-1']);
});

test('delivery text carries the wrap-up and kept-session notes', () => {
  const usage = {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 1,
    toolCalls: 0,
    durationMs: 1000,
    waitedMs: 0,
  };
  const h = setup();
  h.delivery.deliver(
    record({
      result: {
        status: 'completed',
        value: 'v',
        dropped: [],
        usage,
        wrappedUp: true,
      },
    }),
  );
  h.delivery.deliver(
    record({
      id: 'r-2',
      state: 'timed_out',
      result: { status: 'timed_out', value: '', dropped: [], usage },
    }),
  );
  assert.match(
    h.sent[0]?.message.content ?? '',
    /\nnote: stopped at the time limit; the answer is a wrap-up summary\n/,
  );
  assert.match(
    h.sent[1]?.message.content ?? '',
    /\nsession kept: agent_revive this run to get its report or continue\n/,
  );
});

test('same generation twice delivers once', () => {
  const h = setup();
  h.delivery.deliver(record());
  h.delivery.deliver(record());
  assert.equal(h.sent.length, 1);
});

test('a revived generation delivers again', () => {
  const h = setup();
  h.delivery.deliver(record());
  h.delivery.deliver(record({ generation: 2 }));
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1]?.message.details.generation, 2);
});

test('foreground run is not delivered', () => {
  const h = setup();
  h.delivery.deliver(record({ background: false }));
  assert.equal(h.sent.length, 0);
  assert.deepEqual(h.read, []);
});

test('nothing is delivered after stop or when inactive', () => {
  const h = setup();
  h.delivery.stop();
  h.delivery.deliver(record());
  assert.equal(h.sent.length, 0);
  const inactive = setup({ active: () => false });
  inactive.delivery.deliver(record());
  assert.equal(inactive.sent.length, 0);
});

test('send throwing twice then succeeding: 3 attempts, read once', () => {
  const h = setup({ fail: 2 });
  h.delivery.deliver(record());
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.read, []);
  h.timers.shift()?.();
  h.timers.shift()?.();
  assert.equal(h.sent.length, 3);
  assert.deepEqual(h.read, ['r-1']);
  assert.deepEqual(h.delays, [7, 7]);
  assert.equal(h.timers.length, 0);
});

test('always throwing: retries attempts, never marked read', () => {
  const h = setup({ fail: 99, retries: 4 });
  h.delivery.deliver(record());
  while (h.timers.length) h.timers.shift()?.();
  assert.equal(h.sent.length, 4);
  assert.deepEqual(h.read, []);
});

test('a pending retry is dropped after stop', () => {
  const h = setup({ fail: 1 });
  h.delivery.deliver(record());
  h.delivery.stop();
  h.timers.shift()?.();
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.read, []);
});

// registry integration with a fake starter

const def = {
  name: 'fixer',
  models: ['inherit'],
  skills: [],
} as never as AgentDefinition;

const result: GenerationResult = {
  status: 'completed',
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
};

const integration = () => {
  const h = setup();
  const releases: (() => void)[] = [];
  const reg: RunRegistry = new RunRegistry({
    runsDir: mkdtempSync(join(tmpdir(), 'opium-delivery-')),
    newId: () => 'r-1',
    onTerminal: (run) => h.delivery.deliver(run),
    start: (_def, options) => {
      if (options.transcriptPath) writeFileSync(options.transcriptPath, '');
      let state: AgentHandle['state'] = 'idle';
      let resolve: ((r: GenerationResult) => void) | undefined;
      const finish = (status: 'completed' | 'cancelled'): void => {
        state = 'idle';
        resolve?.({ ...result, status });
      };
      releases.push(() => finish('completed'));
      const handle = {
        sessionId: 's',
        get state() {
          return state;
        },
        run: () => {
          state = 'running';
          return new Promise<GenerationResult>((r) => {
            resolve = r;
          });
        },
        steer: () => Promise.resolve<QueueDisposition>('queued'),
        followUp: () => Promise.resolve<QueueDisposition>('queued'),
        abort: () => {
          finish('cancelled');
          return Promise.resolve();
        },
        dispose: () => {
          state = 'disposed';
          finish('cancelled');
          return Promise.resolve();
        },
      } as AgentHandle;
      return Promise.resolve({ handle, turn: {}, warnings: [] });
    },
  });
  return { h, reg, releases };
};

const tick = (): Promise<void> =>
  new Promise((r) => {
    setImmediate(r);
  });

test('registry: background run completes and is delivered once', async () => {
  const { h, reg, releases } = integration();
  const { done } = reg.spawn(def, 'task', { background: true, cwd: '/w' });
  await tick();
  assert.equal(h.sent.length, 0);
  releases[0]?.();
  await done;
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0]?.message.details.state, 'completed');
  assert.deepEqual(h.read, ['r-1']);
});

test('registry: shutdown while running delivers nothing', async () => {
  const { h, reg } = integration();
  const { done } = reg.spawn(def, 'task', { background: true, cwd: '/w' });
  await tick();
  h.delivery.stop();
  await reg.shutdown();
  await done;
  assert.equal(h.sent.length, 0);
});
