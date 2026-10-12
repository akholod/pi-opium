import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from '@earendil-works/pi-coding-agent';
import type {
  ParentContext,
  RunAgentOptions,
  RunAgentResult,
} from 'pi-agent-runner';
import { buildOrchestratorPrompt } from '../src/prompt.ts';
import { loadCouncilAgent, runCouncil } from '../src/council.ts';
import { readState, writeState, DEFAULT_STATE } from '../src/state.ts';

const parent = {
  events: { emit() {}, on: () => () => {} },
  ctx: {},
} as unknown as ParentContext;

const agentsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'agents');
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

// the councillor prompts are identical; the models tell the agents apart
const agentOf = (model: string | undefined): string =>
  ['councillor-alpha', 'councillor-beta', 'councillor-gamma', 'council'].find(
    (name) =>
      parseFrontmatter<{ model?: string }>(
        readFileSync(join(agentsDir, `${name}.md`), 'utf8'),
      ).frontmatter.model === model,
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

const base = { parent, cwd: '/tmp', agentDirs: [agentsDir] };

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

test('council: an invalid agent file fails and names the file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opium-agents-'));
  for (const name of ['alpha', 'beta', 'gamma']) {
    writeFileSync(join(dir, `councillor-${name}.md`), 'prompt\n');
  }
  writeFileSync(
    join(dir, 'councillor-alpha.md'),
    '---\nthinking: ludicrous\n---\nprompt\n',
  );
  writeFileSync(join(dir, 'council.md'), 'prompt\n');
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

const fallbackDir = (council = '') => {
  const dir = mkdtempSync(join(tmpdir(), 'opium-fb-'));
  const fm = (name: string, extra: string) =>
    `---\nmodel: p/${name}\n${extra}---\n${name}\n`;
  writeFileSync(
    join(dir, 'councillor-alpha.md'),
    fm('alpha', 'fallbackModels: p/alpha2, p/alpha3\n'),
  );
  writeFileSync(join(dir, 'councillor-beta.md'), fm('beta', ''));
  writeFileSync(join(dir, 'councillor-gamma.md'), fm('gamma', ''));
  writeFileSync(join(dir, 'council.md'), fm('council', council));
  return dir;
};

test('council fallback: failed primary falls back to the next model', async () => {
  const f = scripted({ 'alpha|p/alpha': ['failed'] });
  const result = await runCouncil({
    parent,
    cwd: '/tmp',
    question: 'q',
    agentDirs: [fallbackDir()],
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
  const dir = fallbackDir();
  const r1 = await runCouncil({
    parent,
    cwd: '/tmp',
    question: 'q',
    agentDirs: [dir],
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
    agentDirs: [dir],
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
    agentDirs: [fallbackDir()],
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
    agentDirs: [fallbackDir()],
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
    agentDirs: [fallbackDir()],
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
    agentDirs: [fallbackDir('fallbackModels: p/council2\n')],
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
    agentDirs: [fallbackDir('fallbackModels: p/council2\n')],
    runAgent: dead.runAgent,
  });
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.error, 'council synthesis failed: failed err');
});

test('loader: fallbackModels parses strings and lists, validates', () => {
  const load = (fm: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'opium-ld-'));
    writeFileSync(join(dir, 'x.md'), `---\n${fm}---\nbody\n`);
    return () => loadCouncilAgent('x', [dir]);
  };
  assert.deepEqual(load('model: a/b\nfallbackModels: c/d, e/f\n')().models, [
    'a/b',
    'c/d',
    'e/f',
  ]);
  assert.deepEqual(
    load('model: a/b\nfallbackModels:\n  - c/d\n  - a/b\n')().models,
    ['a/b', 'c/d'],
  );
  assert.deepEqual(load('fallbackModels: \n')().models, ['inherit']);
  assert.deepEqual(load('fallbackModels: []\n')().models, ['inherit']);
  assert.deepEqual(load('')().models, ['inherit']);
  assert.throws(load('fallbackModels: c/d, nope\n'), /x\.md: fallbackModels/);
  assert.throws(load('fallbackModels: c/\n'), /fallbackModels/);
});
