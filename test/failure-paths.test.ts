import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type {
  AgentHandle,
  GenerationResult,
  QueueDisposition,
  TurnOptions,
} from 'pi-agent-runner';
import { createOpium } from '../extensions/opium.ts';
import type { Starter } from '../src/runs.ts';

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  turns: 1,
  toolCalls: 0,
  durationMs: 1,
  waitedMs: 0,
};

// run() stays pending until finish() / fail() / abort() / dispose()
class FakeHandle implements AgentHandle {
  sessionId = 's';
  state: 'idle' | 'running' | 'disposed' = 'idle';
  disposed = 0;
  private settle?: {
    resolve: (r: GenerationResult) => void;
    reject: (e: Error) => void;
  };

  run(_task: string, _options?: TurnOptions): Promise<GenerationResult> {
    this.state = 'running';
    return new Promise((resolve, reject) => {
      this.settle = { resolve, reject };
    });
  }
  finish(status: GenerationResult['status'] = 'completed', value = 'answer') {
    this.state = 'idle';
    this.settle?.resolve({ status, value, dropped: [], usage });
  }
  fail(message: string): void {
    this.state = 'idle';
    this.settle?.reject(new Error(message));
  }
  // eslint-disable-next-line class-methods-use-this
  steer(): Promise<QueueDisposition> {
    return Promise.resolve('queued');
  }
  // eslint-disable-next-line class-methods-use-this
  followUp(): Promise<QueueDisposition> {
    return Promise.resolve('queued');
  }
  abort(): Promise<void> {
    this.finish('cancelled', '');
    return Promise.resolve();
  }
  dispose(): Promise<void> {
    this.disposed += 1;
    this.state = 'disposed';
    this.finish('cancelled', '');
    return Promise.resolve();
  }
}

interface Sent {
  message: { content: string; details: { id: string } };
  options: { triggerTurn?: boolean; deliverAs?: string };
}

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Tool = {
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ) => Promise<{ content: { text: string }[]; details: { id?: string } }>;
};

const ctx = { cwd: '/tmp' } as unknown as ExtensionContext;
const tick = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

const setup = (starter?: Starter) => {
  const sent: Sent[] = [];
  const tools = new Map<string, Tool>();
  const handlers = new Map<string, Handler[]>();
  const pi = {
    events: { emit() {}, on: () => () => {} },
    on: (name: string, fn: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), fn]);
    },
    registerTool: (tool: Tool & { name: string }) => tools.set(tool.name, tool),
    registerCommand() {},
    sendMessage: (message: Sent['message'], options: Sent['options']) => {
      sent.push({ message, options });
    },
  } as unknown as ExtensionAPI;
  const handles: FakeHandle[] = [];
  const defaultStarter: Starter = async () => {
    const handle = new FakeHandle();
    handles.push(handle);
    return { handle, turn: {}, warnings: [] };
  };
  const runsDir = mkdtempSync(join(tmpdir(), 'opium-fp-'));
  // a missing defaults file: never seed the real ~/.pi/agent/opium.json
  const defaultsPath = join(runsDir, 'no-defaults.json');
  createOpium(pi, {
    starter: starter ?? defaultStarter,
    runsDir,
    defaultsPath,
  });
  const fire = async (name: string) => {
    for (const fn of handlers.get(name) ?? []) await fn({}, ctx);
  };
  const call = (name: string, params: Record<string, unknown>) =>
    (tools.get(name) as Tool).execute('c', params, undefined, undefined, ctx);
  const spawn = async (task: string) => {
    const result = await call('agent', {
      agent: 'fixer',
      task,
      background: true,
    });
    return result.details.id as string;
  };
  return { sent, handles, fire, call, spawn, runsDir };
};

test('session replacement drops the old run and starts fresh', async () => {
  const t = setup();
  await t.fire('session_start');
  const oldId = await t.spawn('old task');
  await tick();
  assert.equal(t.handles.length, 1);
  await t.fire('session_shutdown');
  assert.equal(t.handles[0].disposed, 1);
  await tick();
  assert.equal(t.sent.length, 0);

  await t.fire('session_start');
  const status = await t.call('agent_status', {});
  assert.equal(status.content[0].text, 'no runs');
  const newId = await t.spawn('new task');
  await tick();
  assert.notEqual(newId, oldId);
  t.handles[1].finish();
  await tick();
  assert.equal(t.sent.length, 1);
  assert.ok(t.sent[0].message.content.includes(newId));
  assert.equal(t.sent[0].message.details.id, newId);
});

test('background completion is delivered once, steered', async () => {
  const t = setup();
  const id = await t.spawn('do it');
  await tick();
  assert.equal(t.sent.length, 0);
  t.handles[0].finish();
  await tick();
  assert.equal(t.sent.length, 1);
  assert.deepEqual(t.sent[0].options, {
    triggerTurn: true,
    deliverAs: 'steer',
  });
  assert.ok(t.sent[0].message.content.includes(id));
  await tick();
  assert.equal(t.sent.length, 1);
});

test('provider error is delivered once and visible in agent_status', async () => {
  const t = setup();
  const id = await t.spawn('flaky');
  await tick();
  t.handles[0].fail('Codex error: 500');
  await tick();
  assert.equal(t.sent.length, 1);
  assert.match(t.sent[0].message.content, /Codex error: 500/);
  const status = await t.call('agent_status', { id });
  assert.match(status.content[0].text, /failed/);
  assert.match(status.content[0].text, /error: Codex error: 500/);
});

test('revive right after awaited cancel is not refused as running', async () => {
  const t = setup();
  const id = await t.spawn('long');
  await tick();
  const cancelled = await t.call('agent_cancel', { id });
  assert.match(cancelled.content[0].text, /cancelled/);
  // the transcript exists once the session ran; the fake writes none
  writeFileSync(join(t.runsDir, `${id}.jsonl`), '');
  const revived = await t.call('agent_revive', {
    id,
    task: 'continue',
    background: true,
  });
  assert.equal(revived.details.id, id);
});

test('starter rejecting after shutdown delivers nothing, no unhandled rejection', async () => {
  let reject: (e: Error) => void = () => undefined;
  const starter: Starter = () =>
    new Promise((_resolve, rej) => {
      reject = rej;
    });
  const t = setup(starter);
  const unhandled: unknown[] = [];
  const listener = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', listener);
  try {
    await t.fire('session_start');
    await t.spawn('slow start');
    await t.fire('session_shutdown');
    reject(new Error('boom'));
    await tick();
    await tick();
    assert.equal(t.sent.length, 0);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', listener);
  }
});
