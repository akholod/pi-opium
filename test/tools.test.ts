import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
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
import { RunRegistry, type StartOptions } from '../src/runs.ts';
import {
  agentCancel,
  agentMessage,
  agentResult,
  agentStatus,
  reviveAgent,
  runAgent,
  type ToolDeps,
} from '../src/tools.ts';

const def = (name: string, background = false): AgentDefinition =>
  ({
    name,
    models: ['inherit'],
    skills: [],
    packages: [],
    background,
    advertise: true,
  }) as never;

const gen = (status: RunStatus, value = 'the answer'): GenerationResult => ({
  status,
  value,
  dropped: status === 'completed' ? [] : ['late note'],
  error: status === 'completed' ? undefined : 'boom',
  usage: {
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0.0123,
    turns: 1,
    toolCalls: 0,
    durationMs: 1500,
    waitedMs: 0,
  },
});

class FakeHandle implements AgentHandle {
  sessionId = 's';
  state: 'idle' | 'running' | 'disposed' = 'idle';
  manual = false;
  status: RunStatus = 'completed';
  disposition: QueueDisposition = 'queued';
  private resolve?: (r: GenerationResult) => void;

  run(_task: string, _options?: TurnOptions): Promise<GenerationResult> {
    if (!this.manual) return Promise.resolve(gen(this.status));
    this.state = 'running';
    return new Promise((resolve) => {
      this.resolve = (r) => {
        this.state = 'idle';
        resolve(r);
      };
    });
  }
  steer(): Promise<QueueDisposition> {
    return Promise.resolve(this.disposition);
  }
  followUp(): Promise<QueueDisposition> {
    return Promise.resolve(this.disposition);
  }
  abort(): Promise<void> {
    this.resolve?.(gen('cancelled'));
    return Promise.resolve();
  }
  dispose(): Promise<void> {
    this.state = 'disposed';
    this.resolve?.(gen('cancelled'));
    return Promise.resolve();
  }
}

interface Harness {
  deps: ToolDeps;
  handles: FakeHandle[];
  starts: StartOptions[];
}

const setup = (
  opts: { manual?: boolean; status?: RunStatus; max?: number } = {},
): Harness => {
  const dir = mkdtempSync(join(tmpdir(), 'opium-tools-'));
  const handles: FakeHandle[] = [];
  const starts: StartOptions[] = [];
  let clock = 0;
  let n = 0;
  const registry = new RunRegistry({
    runsDir: dir,
    maxSessionsPerAgent: opts.max,
    now: () => (clock += 1000),
    newId: () => `r-${(n += 1)}`,
    start: (_def, options) => {
      starts.push(options);
      const handle = new FakeHandle();
      handle.manual = opts.manual ?? false;
      handle.status = opts.status ?? 'completed';
      handles.push(handle);
      const file = options.transcriptPath ?? options.resumeFrom;
      if (file) writeFileSync(file, '');
      return Promise.resolve({ handle, turn: {}, warnings: ['w1'] });
    },
  });
  const deps: ToolDeps = {
    registry,
    loadDef: (name) => def(name, name === 'bgagent'),
    agentNames: () => ['bgagent', 'fixer', 'oracle'],
    cwd: '/w',
    now: () => clock,
  };
  return { deps, handles, starts };
};

const tick = (): Promise<void> =>
  new Promise((r) => {
    setImmediate(r);
  });

test('unknown and non-advertised agents are rejected with the roster', async () => {
  const { deps } = setup();
  for (const name of ['nope', 'council']) {
    await assert.rejects(
      runAgent(deps, { agent: name, task: 't' }),
      new RegExp(`unknown agent "${name}"; available: bgagent, fixer, oracle`),
    );
  }
});

test('foreground completed returns formatted text and marks read', async () => {
  const { deps } = setup();
  const updates: string[] = [];
  const res = await runAgent(
    deps,
    { agent: 'fixer', task: 'do it' },
    { onProgress: (m) => updates.push(m) },
  );
  const lines = res.text.split('\n');
  assert.equal(lines[0], 'run r-1 (fixer) completed, generation 1');
  assert.equal(lines[1], 'the answer');
  assert.ok(lines.includes('warnings: w1'));
  assert.equal(lines.at(-1), 'tokens 15, $0.0123, 1.5s');
  assert.equal(deps.registry.get('r-1')?.unread, false);
  assert.deepEqual(updates, ['fixer: running', 'fixer: completed']);
});

test('foreground failure throws the formatted text', async () => {
  const { deps } = setup({ status: 'failed' });
  await assert.rejects(
    runAgent(deps, { agent: 'fixer', task: 'x' }),
    (e: Error) =>
      e.message.includes('run r-1 (fixer) failed, generation 1') &&
      e.message.includes('error: boom') &&
      e.message.includes('dropped messages: late note'),
  );
  assert.equal(deps.registry.get('r-1')?.unread, false);
});

test('background returns immediately; agent default applies', async () => {
  const { deps } = setup({ manual: true });
  const res = await runAgent(deps, { agent: 'bgagent', task: 'long' });
  assert.equal(
    res.text,
    'run r-1 (bgagent) started in the background; its result is delivered ' +
      'when it finishes; use agent_status / agent_result r-1',
  );
  assert.equal(deps.registry.get('r-1')?.state, 'running');
  assert.equal(deps.registry.get('r-1')?.background, true);
  const explicit = await runAgent(deps, {
    agent: 'fixer',
    task: 'other',
    background: true,
  });
  assert.match(explicit.text, /started in the background/);
});

test('duplicate unread objective is refused with the registry message', async () => {
  const { deps } = setup();
  await runAgent(deps, { agent: 'fixer', task: 'same' }, {});
  deps.registry.get('r-1')!.unread = true;
  await assert.rejects(
    runAgent(deps, { agent: 'fixer', task: ' same ' }),
    /run r-1 \(fixer\) already finished this objective/,
  );
  assert.equal(deps.registry.list().length, 1);
});

test('resume while running is refused and does not spawn', async () => {
  const { deps } = setup({ manual: true });
  await runAgent(deps, { agent: 'fixer', task: 'a', background: true });
  await assert.rejects(
    runAgent(deps, {
      agent: 'fixer',
      task: 'more',
      resume: 'r-1',
      background: true,
    }),
    /cannot revive run r-1: .*still running; do not retry as a new spawn/,
  );
  assert.equal(deps.registry.list().length, 1);
  assert.equal(deps.registry.get('r-1')?.generation, 1);
});

test('resume of an unknown run is refused without a new spawn', async () => {
  const { deps, starts } = setup();
  await assert.rejects(
    runAgent(deps, { agent: 'fixer', task: 't', resume: 'r-zz' }),
    /cannot revive run r-zz: run r-zz not found; do not retry as a new spawn/,
  );
  assert.equal(starts.length, 0);
  assert.equal(deps.registry.list().length, 0);
});

test('resume of an evicted run starts from its transcript', async () => {
  const { deps, starts } = setup({ max: 1 });
  await runAgent(deps, { agent: 'fixer', task: 'one' });
  await runAgent(deps, { agent: 'fixer', task: 'two' });
  assert.equal(deps.registry.get('r-1')?.retained, false);
  const res = await runAgent(deps, {
    agent: 'fixer',
    task: 'again',
    resume: 'r-1',
  });
  assert.match(res.text, /^run r-1 \(fixer\) completed, generation 2/);
  assert.equal(starts.length, 3);
  assert.equal(starts[2]?.resumeFrom, deps.registry.get('r-1')?.transcriptPath);
  assert.equal(deps.registry.list().length, 2);
});

test('agent_revive continues a run; unknown id; owner check', async () => {
  const { deps } = setup();
  await runAgent(deps, { agent: 'fixer', task: 'one' });
  const res = await reviveAgent(deps, { id: 'r-1', task: 'next' });
  assert.match(res.text, /generation 2/);
  await assert.rejects(
    reviveAgent(deps, { id: 'r-9', task: 'x' }),
    /unknown run "r-9"/,
  );
  await assert.rejects(
    reviveAgent(deps, { id: 'r-1', task: 'x', agent: 'oracle' }),
    /belongs to agent "fixer"/,
  );
});

test('agent_status reports one run and lists all newest first', async () => {
  const { deps } = setup({ manual: true });
  const long = 'x'.repeat(300);
  await runAgent(deps, { agent: 'fixer', task: long, background: true });
  await runAgent(deps, { agent: 'oracle', task: 'short', background: true });
  const one = agentStatus(deps, { id: 'r-1' }).text;
  assert.match(one, /^run r-1 \(fixer\) running, generation 1/);
  assert.match(one, /background: true, unread: false, retained: true/);
  assert.match(one, /objective: x{119}…/);
  assert.match(one, /warnings: w1/);
  const list = agentStatus(deps, {}).text.split('\n');
  assert.equal(list.length, 2);
  assert.match(list[0]!, /^r-2 oracle running gen 1 \[background, retained\]/);
  assert.match(list[1]!, /^r-1 fixer/);
  assert.throws(() => agentStatus(deps, { id: 'nope' }), /unknown run/);
  assert.equal(agentStatus(setup().deps, {}).text, 'no runs');
});

test('agent_result: running is text, terminal marks read, unknown throws', async () => {
  const { deps, handles } = setup({ manual: true });
  await runAgent(deps, { agent: 'fixer', task: 'a', background: true });
  assert.equal(
    agentResult(deps, { id: 'r-1' }).text,
    'run r-1 is still running (generation 1)',
  );
  handles[0]!.abort();
  await tick();
  await tick();
  const run = deps.registry.get('r-1')!;
  assert.equal(run.unread, true);
  const res = agentResult(deps, { id: 'r-1' });
  assert.match(res.text, /^run r-1 \(fixer\) cancelled, generation 1/);
  assert.equal(run.unread, false);
  assert.throws(() => agentResult(deps, { id: 'zz' }), /unknown run/);
});

test('agent_message dispositions', async () => {
  const { deps, handles } = setup({ manual: true });
  await runAgent(deps, { agent: 'fixer', task: 'a', background: true });
  const queued = await agentMessage(deps, { id: 'r-1', message: 'hi' });
  assert.match(queued.text, /queued \(accepted, not yet consumed/);
  handles[0]!.disposition = 'idle';
  const idle = await agentMessage(deps, {
    id: 'r-1',
    message: 'hi',
    mode: 'steer',
  });
  assert.match(idle.text, /idle \(the run is not running; use agent_revive/);
  handles[0]!.disposition = 'disposed';
  const disposed = await agentMessage(deps, { id: 'r-1', message: 'hi' });
  assert.match(disposed.text, /disposed \(the session is no longer live/);
  handles[0]!.state = 'disposed';
  const gone = await agentMessage(deps, { id: 'r-1', message: 'hi' });
  assert.match(gone.text, /not_retained \(the session is no longer live/);
  await assert.rejects(
    agentMessage(deps, { id: 'zz', message: 'hi' }),
    /unknown run "zz"/,
  );
});

test('agent_cancel: cancelled, not_running, unknown', async () => {
  const { deps } = setup({ manual: true });
  await runAgent(deps, { agent: 'fixer', task: 'a', background: true });
  const res = await agentCancel(deps, { id: 'r-1' });
  assert.equal(
    res.text,
    'run r-1 cancelled; the session is kept; continue it with agent_revive',
  );
  await tick();
  await tick();
  const again = await agentCancel(deps, { id: 'r-1' });
  assert.equal(again.text, 'run r-1 is not running');
  await assert.rejects(agentCancel(deps, { id: 'zz' }), /unknown run "zz"/);
});

test('aborting a foreground call cancels the run', async () => {
  const { deps } = setup({ manual: true });
  const controller = new AbortController();
  const pending = runAgent(
    deps,
    { agent: 'fixer', task: 'slow' },
    { signal: controller.signal },
  );
  await tick();
  assert.equal(deps.registry.get('r-1')?.state, 'running');
  controller.abort();
  await assert.rejects(pending, /run r-1 \(fixer\) cancelled/);
  assert.equal(deps.registry.get('r-1')?.state, 'cancelled');
});
