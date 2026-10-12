import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type { AgentHandle, GenerationResult } from 'pi-agent-runner';
import { createOpium } from '../extensions/opium.ts';
import type { Starter } from '../src/runs.ts';
import { WAKE_TEXT } from '../src/wake.ts';

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

class FakeHandle {
  sessionId = 's';
  state: 'idle' | 'running' | 'disposed' = 'idle';
  private resolve?: (r: GenerationResult) => void;
  run(): Promise<GenerationResult> {
    this.state = 'running';
    return new Promise((resolve) => {
      this.resolve = resolve;
    });
  }
  finish(): void {
    this.state = 'idle';
    this.resolve?.({ status: 'completed', value: 'ok', dropped: [], usage });
  }
  abort(): Promise<void> {
    this.finish();
    return Promise.resolve();
  }
  dispose(): Promise<void> {
    this.state = 'disposed';
    this.finish();
    return Promise.resolve();
  }
}

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Tool = {
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ) => Promise<{ content: { text: string }[] }>;
};

const ctx = { cwd: '/tmp' } as unknown as ExtensionContext;
const tick = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

const setup = (orchestrator = true) => {
  const home = mkdtempSync(join(tmpdir(), 'opium-wb-'));
  const sent: { message: { customType: string; content: string } }[] = [];
  const tools = new Map<string, Tool>();
  const handlers = new Map<string, Handler[]>();
  const timers: (() => void)[] = [];
  const pi = {
    events: { emit() {}, on: () => () => {} },
    on: (name: string, fn: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), fn]);
    },
    registerTool: (tool: Tool & { name: string }) => tools.set(tool.name, tool),
    registerCommand() {},
    sendMessage: (message: never) => {
      sent.push({ message });
    },
  } as unknown as ExtensionAPI;
  const handles: FakeHandle[] = [];
  const starter: Starter = async () => {
    const handle = new FakeHandle();
    handles.push(handle);
    return { handle: handle as unknown as AgentHandle, turn: {}, warnings: [] };
  };
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    createOpium(pi, {
      starter,
      runsDir: join(home, 'runs'),
      wake: { setTimer: (fn) => timers.push(fn) },
    });
  } finally {
    process.env.HOME = previous;
  }
  const fire = async (name: string, event: unknown = {}) => {
    const results: unknown[] = [];
    for (const fn of handlers.get(name) ?? []) {
      results.push(await fn(event, ctx));
    }
    return results;
  };
  const before = async () => {
    const event = {
      systemPromptOptions: { sections: {} as Record<string, string> },
    };
    const results = await fire('before_agent_start', event);
    return {
      event,
      result: results.find((r) => (r as { message?: unknown }).message) as
        | { message: { customType: string; content: string; display: boolean } }
        | undefined,
    };
  };
  const call = (name: string, params: Record<string, unknown>) =>
    (tools.get(name) as Tool).execute('c', params, undefined, undefined, ctx);
  const spawn = async (task: string) => {
    await call('agent', { agent: 'fixer', task, background: true });
    await tick();
  };
  void orchestrator;
  return { sent, handles, timers, fire, before, call, spawn };
};

test('board is injected only when it changes', async () => {
  const t = setup();
  await t.fire('session_start');
  const first = await t.before();
  const { event } = first;
  let { result } = first;
  assert.equal(result, undefined);
  assert.ok(event.systemPromptOptions.sections.orchestrator);

  await t.spawn('job one');
  ({ result } = await t.before());
  assert.equal(result?.message.customType, 'opium-job-board');
  assert.equal(result?.message.display, false);
  assert.match(result?.message.content ?? '', /Running:/);

  ({ result } = await t.before());
  assert.equal(result, undefined);

  t.handles[0].finish();
  await tick();
  ({ result } = await t.before());
  assert.match(result?.message.content ?? '', /Revivable/);
});

test('wait_for_user is skipped while running, latches otherwise', async () => {
  const t = setup();
  await t.fire('session_start');
  await t.spawn('job');
  const skipped = await t.call('wait_for_user', { reason: ' sign   in ' });
  assert.match(
    skipped.content[0].text,
    /^state: waiting_for_user_skipped\nreason: sign in/,
  );

  t.handles[0].finish();
  await tick();

  const waiting = await t.call('wait_for_user', { reason: 'approve' });
  assert.match(
    waiting.content[0].text,
    /^state: waiting_for_user\nreason: approve/,
  );
  // a new run is active, but the latch suppresses the wake
  await t.spawn('job two');
  await t.fire('agent_settled', { aborted: false });
  assert.equal(t.timers.length, 0);

  await t.fire('input', { text: 'done', source: 'interactive' });
  await t.fire('agent_settled', { aborted: false });
  assert.equal(t.timers.length, 1);
  t.timers[0]();
  const wake = t.sent.find((s) => s.message.customType === 'opium-wake');
  // the wake turn has no before_agent_start, so it carries the board
  const content = wake?.message.content ?? '';
  assert.ok(content.startsWith(WAKE_TEXT));
  assert.match(content, /### Background Job Board[\s\S]*Running:/);
  // the same board is not injected again on the next user prompt
  const { result } = await t.before();
  assert.equal(result, undefined);
});

test('extension input does not release the latch', async () => {
  const t = setup();
  await t.fire('session_start');
  await t.spawn('job');
  t.handles[0].finish();
  await tick();
  await t.call('wait_for_user', { reason: 'x' }).catch(() => undefined);
  await t.fire('input', { text: 'x', source: 'extension' });
  await t.fire('agent_settled', { aborted: false });
  assert.equal(t.timers.length, 0);
});

test('child process gets no board, prompt, or wait_for_user', async () => {
  process.env.PI_SUBAGENT_CHILD = '1';
  try {
    const t = setup();
    await t.fire('session_start');
    await t.spawn('job');
    const { event, result } = await t.before();
    assert.equal(result, undefined);
    assert.deepEqual(event.systemPromptOptions.sections, {});
    await assert.rejects(
      t.call('wait_for_user', { reason: 'x' }),
      /orchestrator/,
    );
  } finally {
    delete process.env.PI_SUBAGENT_CHILD;
  }
});
