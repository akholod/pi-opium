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
import { runCouncil } from '../src/council.ts';
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
