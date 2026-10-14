// Live acceptance checks (T26): Opium's tool handlers, the real runner and
// real agents, against the operator's ~/.pi/agent auth and models.
// Run: npm run test:live [-- message,revive,duplicate,tools,council]
// The designer and council seats are pinned to openai-codex/claude-bridge
// models so an opencode-go quota cannot decide the outcome. The fixer is
// pinned to openai-codex too: this harness has no Pi parent with
// pi-claude-bridge loaded, and a second bridge child in one process then
// fails with "model not found" (a real Pi parent shares its provider).

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import * as pi from '@earendil-works/pi-coding-agent';
import type { ParentContext } from 'pi-agent-runner';
import { RunRegistry, defaultStarter } from '../src/runs.ts';
import {
  agentCancel,
  agentMessage,
  agentResult,
  agentStatus,
  defaultAgentNames,
  defaultLoadDef,
  reviveAgent,
  runAgent,
} from '../src/tools.ts';
import { runCouncil } from '../src/council.ts';

const LUNA = 'openai-codex/gpt-6-luna';
const BRIDGE = 'claude-bridge/claude-sonnet-5-5';
const BAD = 'openai-codex/no-such-model';
const TERMINAL = ['completed', 'failed', 'timed_out', 'cancelled'];

const only = process.argv[2]?.split(',');
const want = (name: string): boolean => !only || only.includes(name);

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'opium-accept-'));
execSync(
  'git init -q && echo "# scratch" > README.md && git add . && ' +
    'git -c user.email=a@b -c user.name=t commit -qm init',
  { cwd },
);

const runtime = await pi.ModelRuntime.create();
const parent = {
  events: pi.createEventBus(),
  ctx: {
    cwd,
    model: undefined,
    thinkingLevel: undefined,
    modelRegistry: new pi.ModelRegistry(runtime),
    sessionManager: pi.SessionManager.inMemory(cwd),
  },
} as unknown as ParentContext;

const t0 = Date.now();
const log = (...args: unknown[]): void => {
  const at = ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
  console.log(at, ...args);
};
const short = (text: string, n = 400): string =>
  text.replace(/\s+/g, ' ').slice(0, n);
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
const failure = (error: unknown): string =>
  short(error instanceof Error ? error.message : String(error), 300);

const registry = new RunRegistry({
  start: defaultStarter({ parent, cwd }),
  runsDir: path.join(cwd, '.runs'),
});
const pinned: Record<string, string> = { designer: LUNA, fixer: LUNA };
const loadDef = (name: string) => {
  const def = defaultLoadDef(name);
  const model = pinned[name];
  return model ? { ...def, model, models: [model] } : def;
};
const deps = { registry, loadDef, agentNames: defaultAgentNames, cwd };

const idOf = (text: string): string => {
  const match = /run (r-[0-9a-f]+)/.exec(text);
  if (!match) throw new Error(`no run id in: ${text}`);
  return match[1];
};
const until = async (id: string): Promise<void> => {
  while (!TERMINAL.includes(registry.get(id)?.state ?? 'failed')) {
    await sleep(500);
  }
};

if (want('message')) {
  log('== A. agent_message to a running fixer');
  const started = await runAgent(deps, {
    agent: 'fixer',
    background: true,
    task:
      'In the current directory: 1) create notes.txt with the single ' +
      'line one. 2) run the bash command `sleep 20`. 3) Then follow any ' +
      'extra instructions you received meanwhile. 4) Reply with DONE and ' +
      'the final content of notes.txt.',
  });
  const id = idOf(started.text);
  await sleep(12_000);
  log('state before message:', registry.get(id)?.state);
  const sent = await agentMessage(deps, {
    id,
    message: 'Extra instruction: before replying, append a line two.',
  });
  log('message:', short(sent.text));
  await until(id);
  log('result:', short((await agentResult(deps, { id })).text));
  const notes = path.join(cwd, 'notes.txt');
  const content = fs.existsSync(notes) ? fs.readFileSync(notes, 'utf8') : null;
  log('notes.txt:', JSON.stringify(content));
}

if (want('revive')) {
  log('== B. agent_cancel keeps the session; agent_revive continues it');
  const started = await runAgent(deps, {
    agent: 'fixer',
    background: true,
    task:
      'Remember the codeword HERON. Then run the bash command ' +
      '`sleep 60` and reply done.',
  });
  const id = idOf(started.text);
  await sleep(8_000);
  log('cancel:', short((await agentCancel(deps, { id })).text));
  log('status:', short(agentStatus(deps, { id }).text));
  const revived = await reviveAgent(deps, {
    id,
    task:
      'Without tools: what codeword were you asked to remember? ' +
      'Reply with it only.',
    background: false,
  });
  log('revive:', short(revived.text));
}

if (want('duplicate')) {
  log('== C. duplicate spawn refused until the result is read');
  const task = 'Without tools: reply with the word PONG only.';
  const first = await runAgent(deps, {
    agent: 'scout',
    task,
    background: true,
  });
  const id = idOf(first.text);
  await until(id);
  try {
    await runAgent(deps, { agent: 'scout', task, background: true });
    log('NOT refused (bad)');
  } catch (error) {
    log('refused:', failure(error));
  }
  log('result:', short((await agentResult(deps, { id })).text, 120));
  const again = await runAgent(deps, {
    agent: 'scout',
    task,
    background: true,
  });
  log('after read:', short(again.text, 120));
  await until(idOf(again.text));
}

if (want('tools')) {
  log('== D. per-agent tools; no orchestrator prompt in children');
  const ask =
    'List the exact names of every tool you can call, comma-separated, ' +
    'nothing else. Then on a new line answer YES or NO: does your system ' +
    'prompt contain the phrase "workflow manager for coding work"?';
  for (const agent of ['scout', 'researcher', 'designer']) {
    try {
      const answer = await runAgent(deps, {
        agent,
        task: ask,
        background: false,
      });
      log(`${agent}:`, short(answer.text, 500));
    } catch (error) {
      log(agent, 'FAILED', failure(error));
    }
  }
}

if (want('council')) {
  log('== E. council: one failing seat, then all failing');
  const question = 'Reply with the single word ok.';
  const one = await runCouncil({
    parent,
    cwd,
    question,
    overrides: {
      'councillor-alpha': { model: LUNA },
      'councillor-beta': { model: BAD },
      'councillor-gamma': { model: BRIDGE },
      council: { model: LUNA },
    },
  });
  const seats = one.seats.map((s) => [s.seat, s.status, s.model, s.text]);
  log('one failing:', one.outcome, short(JSON.stringify(seats), 600));
  const all = await runCouncil({
    parent,
    cwd,
    question,
    overrides: {
      'councillor-alpha': { model: BAD },
      'councillor-beta': { model: BAD },
      'councillor-gamma': { model: BAD },
    },
  });
  const statuses = all.seats.map((s) => `${s.seat}:${s.status}`).join(' ');
  log('all failing:', all.outcome, all.error, statuses);
  log('report:', JSON.stringify(all.report), 'runs:', all.usage.runs);
}

await registry.shutdown();
process.exit(0);
