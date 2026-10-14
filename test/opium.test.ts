import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseFrontmatter,
  type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';
import type {
  ParentContext,
  RunAgentOptions,
  RunAgentResult,
} from 'pi-agent-runner';
import { buildOrchestratorPrompt } from '../src/prompt.ts';
import { loadAgent, readAgentOverrides } from '../src/agents.ts';
import { runCouncil } from '../src/council.ts';
import {
  readState,
  seedDefaults,
  writeState,
  DEFAULT_STATE,
} from '../src/state.ts';
import { createOpium } from '../extensions/opium.ts';

const parent = {
  events: { emit() {}, on: () => () => {} },
  ctx: {},
} as unknown as ParentContext;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const agentsDir = join(root, 'agents');
// the shipped runtime values, as a user's seeded opium.json would hold them
const shipped = readAgentOverrides(join(root, 'defaults', 'opium.json'));
const agentBody = (name: string): string =>
  parseFrontmatter(
    readFileSync(join(agentsDir, `${name}.md`), 'utf8'),
  ).body.trim();

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
  assert.match(full, /`agent\(\{ agent: "<name>"/);
  for (const tool of [
    'agent_status',
    'agent_result',
    'agent_message',
    'agent_cancel',
    'agent_revive',
  ]) {
    assert.ok(full.includes(`\`${tool}(`), tool);
  }
  // no pi-subagents vocabulary is left; its tools are only named as off
  // limits
  assert.ok(!full.includes('subagent('));
  assert.ok(!full.includes('pi-subagents'));
  assert.match(full, /do not call or enable them/);
  // other extensions' background-task tools are named only as blind to runs
  assert.equal(full.split('bg_wait').length, 2);
  assert.match(full, /`bg_wait`, `bg_status`\) do not see agent runs/);
  assert.ok(!full.includes('fork'));
  assert.ok(!full.includes('ralplan'));
  assert.ok(!full.includes('ralph'));
  const trimmed = buildOrchestratorPrompt({
    disabled: ['designer', 'observer'],
  });
  assert.ok(!trimmed.includes('\ndesigner\n'));
  assert.ok(!trimmed.includes('observer + explorer'));
  assert.ok(trimmed.includes('multiple fixer instances'));
  // only callable agents are listed; council is a tool and always stays
  const available = buildOrchestratorPrompt({
    available: ['explorer', 'fixer'],
  });
  assert.ok(available.includes('\nexplorer\n'));
  assert.ok(!available.includes('\noracle\n'));
  assert.ok(available.includes('\ncouncil (via'));
});

test('state round-trips and defaults to on', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'opium-')), 'opium.json');
  assert.deepEqual(readState(path), DEFAULT_STATE);
  writeState(path, { orchestrator: false });
  assert.deepEqual(readState(path), { orchestrator: false });
});

test('writeState preserves other keys in the file', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'opium-')), 'opium.json');
  writeFileSync(
    path,
    JSON.stringify({
      orchestrator: true,
      agents: { oracle: { model: 'a/b' } },
    }),
  );
  writeState(path, { orchestrator: false });
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
    orchestrator: false,
    agents: { oracle: { model: 'a/b' } },
  });
});

test('seedDefaults copies the defaults only when opium.json is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opium-seed-'));
  const defaults = join(dir, 'defaults.json');
  writeFileSync(defaults, '{"orchestrator":true,"agents":{"a":{}}}\n');
  // the config directory is created on demand
  const path = join(dir, 'home', '.pi', 'agent', 'opium.json');
  assert.equal(seedDefaults(path, defaults), true);
  assert.equal(readFileSync(path, 'utf8'), readFileSync(defaults, 'utf8'));
  // an existing file is never touched or merged
  writeFileSync(path, '{"orchestrator":false}');
  assert.equal(seedDefaults(path, defaults), false);
  assert.equal(readFileSync(path, 'utf8'), '{"orchestrator":false}');
  // no defaults file: nothing is created
  const other = join(dir, 'other', 'opium.json');
  assert.equal(seedDefaults(other, join(dir, 'missing.json')), false);
  assert.equal(existsSync(other), false);
});

test('createOpium seeds opium.json at load, leaves an existing one', () => {
  const home = mkdtempSync(join(tmpdir(), 'opium-home-'));
  const defaults = join(home, 'defaults.json');
  writeFileSync(defaults, '{"orchestrator":false,"agents":{}}\n');
  const pi = {
    events: { emit() {}, on: () => () => {} },
    on() {},
    registerTool() {},
    registerCommand() {},
    sendMessage() {},
  } as unknown as ExtensionAPI;
  const load = () => {
    const previous = process.env.HOME;
    process.env.HOME = home;
    try {
      createOpium(pi, { runsDir: join(home, 'runs'), defaultsPath: defaults });
    } finally {
      process.env.HOME = previous;
    }
  };
  const path = join(home, '.pi', 'agent', 'opium.json');
  load();
  assert.equal(readFileSync(path, 'utf8'), readFileSync(defaults, 'utf8'));
  writeFileSync(path, '{"orchestrator":true}');
  load();
  assert.equal(readFileSync(path, 'utf8'), '{"orchestrator":true}');
});

// the councillor prompts are identical; the models tell the agents apart
const agentOf = (model: string | undefined): string =>
  ['councillor-alpha', 'councillor-beta', 'councillor-gamma', 'council'].find(
    (name) => shipped.overrides[name]?.model === model,
  ) ?? 'unknown';

const fake = (answers: Record<string, RunAgentResult['status']> = {}) => {
  const calls: (RunAgentOptions & { agent: string })[] = [];
  const runAgent = async (opts: RunAgentOptions): Promise<RunAgentResult> => {
    const agent = agentOf(opts.model);
    calls.push({ ...opts, agent });
    const status = answers[agent] ?? 'completed';
    const usage = {
      input: 5,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.01,
      turns: 1,
      toolCalls: 0,
      durationMs: 1,
      waitedMs: 0,
    };
    if (status !== 'completed') return { status, value: undefined, usage };
    const responses = opts.task
      .split('# Councillor responses')[1]
      ?.replace(/\s+/g, ' ')
      .trim();
    const text =
      agent === 'council'
        ? `## Council Response\nsynth of: ${responses}`
        : `${agent} says hi`;
    return { status, value: text, usage, model: `m/${agent}` };
  };
  return { runAgent, calls };
};

const base = {
  parent,
  cwd: '/tmp',
  agentDirs: [agentsDir],
  overrides: shipped.overrides,
};

test('council: councillors in parallel, then synthesis', async () => {
  const f = fake();
  const result = await runCouncil({
    ...base,
    question: 'tabs or spaces?',
    context: 'see .editorconfig',
    runAgent: f.runAgent,
  });
  assert.equal(result.outcome, 'completed', result.error);
  assert.deepEqual(
    f.calls.map((c) => c.agent),
    ['councillor-alpha', 'councillor-beta', 'councillor-gamma', 'council'],
  );
  for (const [index, call] of f.calls.entries()) {
    assert.equal(call.parent, parent);
    assert.equal(call.extensions, 'none');
    assert.deepEqual(call.label, { name: call.agent, context: 'council' });
    assert.deepEqual(
      call.tools,
      index < 3 ? ['read', 'grep', 'find', 'ls'] : [],
    );
  }
  for (const call of f.calls) {
    assert.equal(call.systemPrompt, agentBody(call.agent));
  }
  assert.equal(f.calls[0].model, 'openai-codex/gpt-6-luna');
  assert.equal(f.calls[0].thinking, 'high');
  assert.equal(f.calls[0].timeoutMs, 900000);
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
    ...base,
    question: 'q',
    runAgent: f.runAgent,
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
    ...base,
    question: 'q',
    runAgent: dead.runAgent,
  });
  assert.equal(failed.outcome, 'failed');
  assert.equal(dead.calls.length, 3);

  const cancelled = fake({ 'councillor-gamma': 'cancelled' });
  const aborted = await runCouncil({
    ...base,
    question: 'q',
    runAgent: cancelled.runAgent,
  });
  assert.equal(aborted.outcome, 'aborted');
});

test('council: without opium.json values the seats inherit the model', async () => {
  const calls: RunAgentOptions[] = [];
  const result = await runCouncil({
    parent,
    cwd: '/tmp',
    question: 'q',
    agentDirs: [agentsDir],
    runAgent: async (opts) => {
      calls.push(opts);
      const usage = {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        turns: 1,
        toolCalls: 0,
        durationMs: 1,
        waitedMs: 0,
      };
      return { status: 'completed', value: 'ok', usage };
    },
  });
  assert.equal(result.outcome, 'completed', result.error);
  assert.equal(calls.length, 4);
  for (const call of calls) {
    assert.equal(call.model, 'inherit');
    assert.equal(call.thinking, undefined);
  }
});

test('council: explicit timeoutMs overrides the agent file', async () => {
  const f = fake();
  await runCouncil({
    ...base,
    question: 'q',
    timeoutMs: 1234,
    runAgent: f.runAgent,
  });
  assert.ok(f.calls.every((c) => c.timeoutMs === 1234));
});

test('council: wrapUpMs and idleTimeoutMs reach every seat and the synthesizer', async () => {
  const f = fake();
  await runCouncil({
    ...base,
    question: 'q',
    overrides: {
      ...shipped.overrides,
      'councillor-alpha': {
        ...shipped.overrides['councillor-alpha'],
        wrapUpMs: 11,
        idleTimeoutMs: 22,
      },
      council: {
        ...shipped.overrides.council,
        wrapUpMs: 33,
        idleTimeoutMs: 44,
      },
    },
    runAgent: f.runAgent,
  });
  const by = (name: string) => f.calls.find((c) => c.agent === name);
  assert.equal(by('councillor-alpha')?.wrapUpMs, 11);
  assert.equal(by('councillor-alpha')?.idleTimeoutMs, 22);
  assert.equal(by('council')?.wrapUpMs, 33);
  assert.equal(by('council')?.idleTimeoutMs, 44);
  assert.equal(by('councillor-beta')?.wrapUpMs, 180000);
  assert.equal(by('councillor-beta')?.idleTimeoutMs, 600000);
});

test('council: an invalid agent file fails and names the file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opium-agents-'));
  for (const name of ['alpha', 'beta', 'gamma']) {
    writeFileSync(
      join(dir, `councillor-${name}.md`),
      '---\ndescription: d\n---\nprompt\n',
    );
  }
  writeFileSync(
    join(dir, 'councillor-alpha.md'),
    '---\ndescription: d\nthinking: ludicrous\n---\nprompt\n',
  );
  writeFileSync(join(dir, 'council.md'), '---\ndescription: d\n---\nprompt\n');
  const f = fake();
  const result = await runCouncil({
    parent,
    cwd: '/tmp',
    question: 'q',
    agentDirs: [dir],
    runAgent: f.runAgent,
  });
  assert.equal(result.outcome, 'failed');
  assert.match(result.error ?? '', /councillor-alpha\.md.*thinking/);
  assert.equal(f.calls.length, 0);
});

// scripted fake: results keyed by `${agent}|${model}`, consumed per attempt
type Script = Record<string, (RunAgentResult['status'] | string)[]>;
const scripted = (script: Script) => {
  const calls: { key: string; task: string }[] = [];
  const runAgent = async (opts: RunAgentOptions): Promise<RunAgentResult> => {
    const agent = opts.systemPrompt.split('\n')[0];
    const key = `${agent}|${opts.model}`;
    calls.push({ key, task: opts.task });
    const step = script[key]?.shift() ?? 'ok';
    const usage = {
      input: 5,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.01,
      turns: 1,
      toolCalls: 0,
      durationMs: 1,
      waitedMs: 0,
    };
    if (['failed', 'timed_out', 'cancelled'].includes(step)) {
      return {
        status: step as RunAgentResult['status'],
        value: undefined,
        usage,
        error: `${step} err`,
      };
    }
    return {
      status: 'completed',
      value: step === 'ok' ? `${key} answer` : step,
      usage,
      model: `resolved/${opts.model}`,
    };
  };
  return { runAgent, calls };
};

// agent files hold the prompt only; models and fallbacks are overrides
const fallbackDir = (council: string[] = []) => {
  const dir = mkdtempSync(join(tmpdir(), 'opium-fb-'));
  for (const name of ['alpha', 'beta', 'gamma', 'council']) {
    const file = name === 'council' ? name : `councillor-${name}`;
    writeFileSync(
      join(dir, `${file}.md`),
      `---\ndescription: d\n---\n${name}\n`,
    );
  }
  const overrides = {
    'councillor-alpha': {
      model: 'p/alpha',
      fallbackModels: ['p/alpha2', 'p/alpha3'],
    },
    'councillor-beta': { model: 'p/beta' },
    'councillor-gamma': { model: 'p/gamma' },
    council: { model: 'p/council', fallbackModels: council },
  };
  return { agentDirs: [dir], overrides };
};

test('council fallback: failed primary falls back to the next model', async () => {
  const f = scripted({ 'alpha|p/alpha': ['failed'] });
  const result = await runCouncil({
    parent,
    cwd: '/tmp',
    question: 'q',
    ...fallbackDir(),
    runAgent: f.runAgent,
  });
  assert.equal(result.outcome, 'completed', result.error);
  const alpha = result.seats[0];
  assert.equal(alpha.ok, true);
  assert.equal(alpha.model, 'resolved/p/alpha2');
  assert.equal(alpha.attempts.length, 2);
  assert.deepEqual(
    alpha.attempts.map((a) => [a.model, a.status]),
    [
      ['p/alpha', 'failed'],
      ['p/alpha2', 'completed'],
    ],
  );
  assert.equal(result.usage.runs, 5);
});

test('council fallback: empty answers retry the same model once', async () => {
  const retried = scripted({ 'alpha|p/alpha': ['', 'answer'] });
  const fb = fallbackDir();
  const r1 = await runCouncil({
    parent,
    cwd: '/tmp',
    question: 'q',
    ...fb,
    runAgent: retried.runAgent,
  });
  assert.equal(r1.seats[0].ok, true);
  assert.equal(r1.seats[0].text, 'answer');
  assert.equal(r1.seats[0].attempts.length, 2);
  assert.equal(r1.seats[0].attempts[0].status, 'empty');
  assert.equal(r1.seats[0].model, 'resolved/p/alpha');

  const moved = scripted({ 'alpha|p/alpha': ['', '  '] });
  const progress: string[] = [];
  const r2 = await runCouncil({
    parent,
    cwd: '/tmp',
    question: 'q',
    ...fb,
    runAgent: moved.runAgent,
    onProgress: (m) => progress.push(m),
  });
  assert.equal(r2.seats[0].ok, true);
  assert.equal(r2.seats[0].attempts.length, 3);
  assert.equal(r2.seats[0].model, 'resolved/p/alpha2');
  assert.ok(
    progress.includes('council: alpha empty answer from p/alpha, retrying'),
  );
  assert.ok(
    progress.includes(
      'council: alpha empty answer on p/alpha, trying p/alpha2',
    ),
  );
});

test('council fallback: exhausted chain fails the seat only', async () => {
  const f = scripted({
    'alpha|p/alpha': ['failed'],
    'alpha|p/alpha2': ['', ''],
    'alpha|p/alpha3': ['timed_out'],
  });
  const result = await runCouncil({
    parent,
    cwd: '/tmp',
    question: 'q',
    ...fallbackDir(),
    runAgent: f.runAgent,
  });
  assert.equal(result.outcome, 'completed', result.error);
  const alpha = result.seats[0];
  assert.equal(alpha.ok, false);
  assert.equal(alpha.status, 'timed_out');
  assert.equal(alpha.attempts.length, 4);
  assert.equal(
    alpha.text,
    'timed_out: timed_out err (tried p/alpha, p/alpha2, p/alpha3)',
  );
  assert.equal(result.seats[1].ok, true);
  assert.match(f.calls[f.calls.length - 1].task, /\[no answer: timed_out/);
  assert.equal(result.usage.runs, 4 + 2 + 1);

  const empty = scripted({
    'alpha|p/alpha': ['', ''],
    'alpha|p/alpha2': ['', ''],
    'alpha|p/alpha3': ['', ''],
  });
  const r2 = await runCouncil({
    parent,
    cwd: '/tmp',
    question: 'q',
    ...fallbackDir(),
    runAgent: empty.runAgent,
  });
  assert.equal(r2.seats[0].status, 'failed');
  assert.match(r2.seats[0].text, /^failed: empty answer \(tried /);
});

test('council fallback: cancelled stops without fallback', async () => {
  const f = scripted({ 'alpha|p/alpha': ['cancelled'] });
  const result = await runCouncil({
    parent,
    cwd: '/tmp',
    question: 'q',
    ...fallbackDir(),
    runAgent: f.runAgent,
  });
  assert.equal(result.outcome, 'aborted');
  assert.equal(result.seats[0].status, 'cancelled');
  assert.equal(result.seats[0].attempts.length, 1);
  assert.ok(!f.calls.some((c) => c.key === 'alpha|p/alpha2'));
});

test('council fallback: synthesizer falls back too', async () => {
  const f = scripted({ 'council|p/council': ['timed_out'] });
  const result = await runCouncil({
    parent,
    cwd: '/tmp',
    question: 'q',
    ...fallbackDir(['p/council2']),
    runAgent: f.runAgent,
  });
  assert.equal(result.outcome, 'completed', result.error);
  assert.equal(result.report, 'council|p/council2 answer');
  assert.equal(result.usage.runs, 5);

  const dead = scripted({
    'council|p/council': ['failed'],
    'council|p/council2': ['failed'],
  });
  const failed = await runCouncil({
    parent,
    cwd: '/tmp',
    question: 'q',
    ...fallbackDir(['p/council2']),
    runAgent: dead.runAgent,
  });
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.error, 'council synthesis failed: failed err');
});

test('opium.json: fallbackModels parses strings and lists, validates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opium-ld-'));
  writeFileSync(join(dir, 'x.md'), '---\ndescription: d\n---\nbody\n');
  const load = (agent: Record<string, unknown>) => {
    const opium = join(dir, 'opium.json');
    writeFileSync(opium, JSON.stringify({ agents: { x: agent } }));
    const { overrides, errors } = readAgentOverrides(opium);
    const models = loadAgent('x', { dirs: [dir], overrides }).models;
    return { models, errors };
  };
  assert.deepEqual(load({ model: 'a/b', fallbackModels: 'c/d, e/f' }).models, [
    'a/b',
    'c/d',
    'e/f',
  ]);
  assert.deepEqual(
    load({ model: 'a/b', fallbackModels: ['c/d', 'a/b'] }).models,
    ['a/b', 'c/d'],
  );
  assert.deepEqual(load({ fallbackModels: [] }).models, ['inherit']);
  assert.deepEqual(load({}).models, ['inherit']);
  for (const bad of ['c/d, nope', 'c/']) {
    const { errors } = load({ fallbackModels: bad });
    assert.equal(errors.length, 1, bad);
    assert.match(errors[0], /fallbackModels/);
  }
});
