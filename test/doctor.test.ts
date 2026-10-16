import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { installedRunnerVersion } from '../src/doctor-env.ts';
import { createOpium } from '../extensions/opium.ts';
import type { AgentOverrides } from '../src/agents.ts';
import {
  RUNNER_EXPORTS,
  countChecks,
  formatDoctor,
  runDoctor,
  summaryLine,
  type Check,
  type DoctorDeps,
  type DoctorReport,
  type ModelInfo,
} from '../src/doctor.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const agentDirs = [join(root, 'agents')];

const model = (ref: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({
  ref,
  images: true,
  authenticated: true,
  ...extra,
});

// distinct models per council seat, so the setup is healthy
const healthyOverrides: AgentOverrides = {
  'councillor-alpha': { model: 'a/alpha' },
  'councillor-beta': { model: 'b/beta' },
  'councillor-gamma': { model: 'c/gamma' },
};

const runnerExports = (): Record<string, unknown> =>
  Object.fromEntries(RUNNER_EXPORTS.map((name) => [name, () => undefined]));

const known: Record<string, ModelInfo> = {
  'a/alpha': model('a/alpha'),
  'b/beta': model('b/beta'),
  'c/gamma': model('c/gamma'),
  'v/vision': model('v/vision'),
};

const makeDeps = (over: Partial<DoctorDeps> = {}): DoctorDeps => ({
  configPath: '/home/u/.pi/agent/opium.json',
  configExists: () => true,
  readOverrides: () => ({ overrides: healthyOverrides, errors: [] }),
  activePreset: () => 'cheap',
  orchestrator: () => true,
  wake: () => ({ enabled: true, intervalMs: 300_000 }),
  sessionModel: model('s/session'),
  resolveModel: (ref) => known[ref],
  skills: async () => () => true,
  builtinMcp: () => ({ disabled: false, servers: ['codegraph'] }),
  resolveMcp: () => ({ tools: [], errors: [] }),
  installedPackages: () => ['npm:pi-web-access', 'npm:pi-mcp-adapter@1.0.0'],
  runner: () => ({ exports: runnerExports(), version: '0.9.0' }),
  ...over,
});

const run = (over: Partial<DoctorDeps> = {}, live = false) =>
  runDoctor({ live, agentDirs }, makeDeps(over));

const all = (report: DoctorReport): Check[] =>
  report.sections.flatMap((section) => section.checks);

const section = (report: DoctorReport, name: string): Check[] => {
  const found = report.sections.find((s) => s.name === name);
  assert.ok(found, `section ${name}`);
  return found.checks;
};

const problems = (report: DoctorReport, status: Check['status']): string[] =>
  all(report)
    .filter((c) => c.status === status)
    .map((c) => `${c.title} ${c.detail ?? ''}`);

test('a healthy setup has only ok checks', async () => {
  const report = await run();
  assert.deepEqual(problems(report, 'fail'), []);
  assert.deepEqual(problems(report, 'warn'), []);
  assert.equal(
    report.sections.map((s) => s.name).join(),
    'Config,Agents,Council,Skills,MCP,Extensions,Images,Runner,Orchestrator',
  );
  const agents = section(report, 'Agents').map((c) => c.title);
  assert.ok(agents.includes('scout: inherit (s/session), thinking default'));
  assert.ok(agents.includes('council: inherit (s/session), thinking default'));
  assert.ok(agents.some((t) => t.startsWith('councillor-beta: b/beta')));
  assert.ok(section(report, 'Config').some((c) => c.title === 'preset: cheap'));
});

test('an unknown model fails with "model not found"', async () => {
  const report = await run({
    readOverrides: () => ({
      overrides: {
        ...healthyOverrides,
        fixer: { model: 'x/nope', fallbackModels: ['a/alpha'] },
      },
      errors: [],
    }),
  });
  const fixer = section(report, 'Agents').find((c) =>
    c.title.startsWith('fixer:'),
  );
  assert.equal(fixer?.status, 'fail');
  assert.match(fixer?.title ?? '', /x\/nope → a\/alpha/);
  assert.match(fixer?.detail ?? '', /x\/nope: model not found/);
});

test('a model without credentials fails with the login hint', async () => {
  const report = await run({
    resolveModel: (ref) =>
      ref === 'a/alpha' ? model(ref, { authenticated: false }) : known[ref],
  });
  const alpha = section(report, 'Agents').find((c) =>
    c.title.startsWith('councillor-alpha:'),
  );
  assert.equal(alpha?.status, 'fail');
  assert.match(alpha?.detail ?? '', /no credentials for a/);
  assert.equal(alpha?.fix, 'run /login a');
});

test('inherit without a session model fails', async () => {
  const report = await run({ sessionModel: undefined });
  const scout = section(report, 'Agents').find((c) =>
    c.title.startsWith('scout:'),
  );
  assert.equal(scout?.status, 'fail');
  assert.match(scout?.detail ?? '', /no model/);
});

test('config errors are reported; a legacy name only warns', async () => {
  const path = '/home/u/.pi/agent/opium.json';
  const report = await run({
    readOverrides: () => ({
      overrides: healthyOverrides,
      errors: [
        `${path}: override for "fixer": unknown field "colour"`,
        `${path}: agent "oracle" was renamed to "senior"; rename the key`,
        `${path}: preset "x" not found (available: none)`,
      ],
    }),
    configExists: () => false,
  });
  const config = section(report, 'Config');
  assert.equal(config[0].status, 'warn');
  const byTitle = Object.fromEntries(config.map((c) => [c.title, c.status]));
  assert.equal(byTitle['override for "fixer": unknown field "colour"'], 'fail');
  assert.equal(
    byTitle['agent "oracle" was renamed to "senior"; rename the key'],
    'warn',
  );
  assert.equal(byTitle['preset "x" not found (available: none)'], 'fail');
});

test('seats on the same model warn with the council note', async () => {
  const report = await run({
    readOverrides: () => ({ overrides: {}, errors: [] }),
  });
  const [check] = section(report, 'Council');
  assert.equal(check.status, 'warn');
  assert.match(check.title, /^all council seats use the same model/);
});

test('a missing skill warns for the agent', async () => {
  const report = await run({
    readOverrides: () => ({
      overrides: { ...healthyOverrides, senior: { skills: ['simplify'] } },
      errors: [],
    }),
    skills: async () => () => false,
  });
  assert.deepEqual(
    section(report, 'Skills').map((c) => [c.status, c.title]),
    [['warn', 'skill simplify not found for senior']],
  );
});

test('MCP: builtin, adapter, missing codegraph, missing user server', async () => {
  const overrides: AgentOverrides = {
    ...healthyOverrides,
    scout: { mcpServers: ['codegraph'] },
    fixer: { mcpServers: ['codegraph', 'mine'] },
    senior: { mcpServers: ['codegraph', 'notes', 'ghost', 'broken'] },
  };
  const report = await run({
    readOverrides: () => ({ overrides, errors: [] }),
    builtinMcp: () => ({ disabled: false, servers: ['mine'] }),
    resolveMcp: ([server]) => {
      if (server === 'notes') {
        return { tools: ['notes_a', 'notes_b'], errors: [] };
      }
      const errors =
        server === 'broken' ? ['"broken" has no direct tools'] : [];
      return { tools: [], errors };
    },
  });
  const byTitle = new Map(
    section(report, 'MCP').map((c) => [c.title, c] as const),
  );
  const get = (title: string) => byTitle.get(title)?.status;
  assert.equal(get('builtin MCP is enabled (mine)'), 'ok');
  assert.equal(get('fixer: MCP mine via builtin MCP'), 'ok');
  assert.equal(get('senior: MCP notes via pi-mcp-adapter (2 tools)'), 'ok');
  assert.equal(
    get('scout: MCP codegraph not configured, agent works without it'),
    'ok',
  );
  assert.equal(
    get('senior: MCP ghost not found; the agent runs without it'),
    'warn',
  );
  assert.equal(get('senior: MCP broken is configured but unusable'), 'warn');
});

test('MCP: the docs servers are optional like codegraph', async () => {
  const report = await run({
    readOverrides: () => ({
      overrides: {
        ...healthyOverrides,
        researcher: { mcpServers: ['context7', 'gh_grep'] },
      },
      errors: [],
    }),
  });
  const titles = section(report, 'MCP').map((c) => `${c.status} ${c.title}`);
  for (const server of ['context7', 'gh_grep']) {
    assert.ok(
      titles.includes(
        `ok researcher: MCP ${server} not configured, agent works without it`,
      ),
      server,
    );
  }
});

test('extensions: a missing pi-lens warns, an installed one is ok', async () => {
  const overrides: AgentOverrides = {
    ...healthyOverrides,
    senior: { extensions: ['pi-lens'] },
    fixer: { extensions: ['pi-lens'] },
  };
  const missing = await run({
    readOverrides: () => ({ overrides, errors: [] }),
  });
  const lens = section(missing, 'Extensions').find((c) =>
    c.title.startsWith('pi-lens'),
  );
  assert.equal(lens?.status, 'warn');
  assert.match(lens?.title ?? '', /pi-lens is not installed \(fixer, senior\)/);
  assert.equal(lens?.fix, 'pi install npm:pi-lens');
  const installed = await run({
    readOverrides: () => ({ overrides, errors: [] }),
    installedPackages: () => ['npm:pi-web-access', 'npm:pi-lens@4.4.3'],
  });
  const found = section(installed, 'Extensions').find((c) =>
    c.title.startsWith('pi-lens'),
  );
  assert.equal(found?.status, 'ok');
});

test('MCP: builtin disabled sends the server to the adapter', async () => {
  const report = await run({
    readOverrides: () => ({
      overrides: { ...healthyOverrides, scout: { mcpServers: ['mine'] } },
      errors: [],
    }),
    builtinMcp: () => ({ disabled: true, servers: ['mine'] }),
    resolveMcp: () => ({ tools: ['mine_x'], errors: [] }),
    installedPackages: () => ['npm:pi-web-access'],
  });
  const titles = section(report, 'MCP').map((c) => `${c.status} ${c.title}`);
  assert.ok(titles.includes('ok builtin MCP is disabled (-builtin:mcp)'));
  assert.ok(
    titles.includes(
      'warn scout: MCP mine needs pi-mcp-adapter, which is not installed',
    ),
  );
});

test('a missing pi-web-access warns for the researcher', async () => {
  const report = await run({ installedPackages: () => ['npm:pi-simplify'] });
  const [check] = section(report, 'Extensions');
  assert.equal(check.status, 'warn');
  assert.match(check.title, /pi-web-access is not installed \(researcher\)/);
  assert.equal(
    check.fix,
    'researcher cannot search the web: pi install npm:pi-web-access',
  );
});

test('a local path package counts as installed by its folder name', async () => {
  const report = await run({
    installedPackages: () => ['../../tools/pi-web-access'],
  });
  assert.equal(section(report, 'Extensions')[0].status, 'ok');
});

test('images: a seeing session model skips vision', async () => {
  const report = await run();
  const [check] = section(report, 'Images');
  assert.equal(check.status, 'ok');
  assert.match(check.title, /sees images; the vision agent is skipped/);
});

test('images: vision on a text-only model fails', async () => {
  const text = model('s/session', { images: false });
  const report = await run({ sessionModel: text });
  const [check] = section(report, 'Images');
  assert.equal(check.status, 'fail');
  assert.match(check.title, /vision model s\/session cannot see them/);
});

test('images: a text-only session uses a seeing vision model', async () => {
  const report = await run({
    sessionModel: model('s/session', { images: false }),
    readOverrides: () => ({
      overrides: { ...healthyOverrides, vision: { model: 'v/vision' } },
      errors: [],
    }),
  });
  const [check] = section(report, 'Images');
  assert.equal(check.status, 'ok');
  assert.match(check.title, /vision \(v\/vision\) reads them/);
});

test('runner: a missing export fails with the restart hint', async () => {
  const exports = runnerExports();
  delete exports.mountRunsView;
  exports.liveRuns = 'not a function';
  const report = await run({
    runner: () => ({ exports, version: '0.9.0' }),
  });
  const [check] = section(report, 'Runner');
  assert.equal(check.status, 'fail');
  assert.match(check.title, /missing liveRuns, mountRunsView/);
  assert.match(
    check.detail ?? '',
    /loaded in this Pi process is older than the installed 0\.9\.0/,
  );
  assert.equal(check.fix, 'restart Pi (a /reload is not enough)');
});

test('runner: every export is present', async () => {
  const [check] = section(await run(), 'Runner');
  assert.equal(check.status, 'ok');
  assert.match(check.title, /pi-agent-runner 0\.9\.0/);
});

test('RUNNER_EXPORTS lists every value Opium imports from the runner', () => {
  const files = [
    ...readdirSync(join(root, 'src')).map((f) => join(root, 'src', f)),
    join(root, 'extensions', 'opium.ts'),
  ].filter((f) => f.endsWith('.ts'));
  const imported = new Set<string>();
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const re = /import\s+(type\s+)?\{([^}]*)\}\s+from\s+'pi-agent-runner'/g;
    for (const match of text.matchAll(re)) {
      if (match[1]) continue;
      for (const part of match[2].split(',')) {
        const name = part.trim();
        if (name && !name.startsWith('type ')) imported.add(name);
      }
    }
  }
  // the doctor itself reads the runner as a namespace
  imported.add('startAgent');
  assert.deepEqual([...imported].sort(), [...RUNNER_EXPORTS].sort());
});

test('orchestrator and wake are reported', async () => {
  const report = await run({
    orchestrator: () => false,
    wake: () => ({ enabled: false, intervalMs: 1000 }),
  });
  assert.deepEqual(
    section(report, 'Orchestrator').map((c) => c.title),
    ['orchestrator prompt off', 'wake off'],
  );
});

test('no model is called without --live', async () => {
  const pings: string[] = [];
  const report = await run({
    ping: async (ref) => {
      pings.push(ref);
    },
  });
  assert.deepEqual(pings, []);
  assert.ok(!report.sections.some((s) => s.name === 'Live'));
  assert.match(formatDoctor(report), /Run \/opium-doctor --live/);
});

test('--live pings distinct models once: ok with latency, 429 fails', async () => {
  const pings: string[] = [];
  let clock = 0;
  const report = await run(
    {
      readOverrides: () => ({
        overrides: {
          ...healthyOverrides,
          // a/alpha repeats; the second fallback is never pinged
          fixer: { model: 'a/alpha', fallbackModels: ['c/gamma', 'b/beta'] },
        },
        errors: [],
      }),
      now: () => (clock += 25),
      ping: async (ref) => {
        pings.push(ref);
        if (ref === 'b/beta') throw new Error('429 quota exceeded');
      },
    },
    true,
  );
  assert.deepEqual([...pings].sort(), [
    'a/alpha',
    'b/beta',
    'c/gamma',
    's/session',
  ]);
  const live = new Map(
    section(report, 'Live').map((c) => [c.title.split(':')[0], c] as const),
  );
  assert.equal(live.get('a/alpha')?.status, 'ok');
  assert.match(live.get('a/alpha')?.title ?? '', /answered in \d+ ms/);
  assert.equal(live.get('b/beta')?.status, 'fail');
  assert.match(live.get('b/beta')?.title ?? '', /429 quota exceeded/);
  assert.equal(formatDoctor(report).includes('--live to ping'), false);
});

test('--live skips models that already failed and honours the timeout', async () => {
  const pings: string[] = [];
  const report = await runDoctor(
    { live: true, agentDirs, pingTimeoutMs: 20 },
    makeDeps({
      readOverrides: () => ({
        overrides: {
          'councillor-alpha': { model: 'x/nope' },
          'councillor-beta': { model: 'b/beta' },
          'councillor-gamma': { model: 'c/gamma' },
        },
        errors: [],
      }),
      ping: (ref, signal) => {
        pings.push(ref);
        return new Promise<void>((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      },
    }),
  );
  assert.ok(!pings.includes('x/nope'));
  const checks = section(report, 'Live');
  assert.ok(checks.length > 0);
  for (const check of checks) {
    assert.equal(check.status, 'fail');
    assert.match(check.title, /no answer within 0 s|aborted/);
  }
});

test('--live runs at most `concurrency` pings at once', async () => {
  let active = 0;
  let peak = 0;
  const refs = ['a/alpha', 'b/beta', 'c/gamma', 'v/vision'];
  const overrides: AgentOverrides = {
    ...healthyOverrides,
    fixer: { model: 'v/vision' },
  };
  await runDoctor(
    { live: true, agentDirs, concurrency: 2 },
    makeDeps({
      readOverrides: () => ({ overrides, errors: [] }),
      ping: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise<void>((r) => {
          setTimeout(r, 5);
        });
        active--;
      },
    }),
  );
  assert.ok(refs.length >= 4);
  assert.equal(peak, 2);
});

test('formatDoctor marks lines and counts statuses', () => {
  const report: DoctorReport = {
    live: true,
    sections: [
      {
        name: 'One',
        checks: [
          { status: 'ok', title: 'fine' },
          { status: 'warn', title: 'hmm', detail: 'l1\nl2', fix: 'do x' },
        ],
      },
      { name: 'Two', checks: [{ status: 'fail', title: 'bad' }] },
    ],
  };
  assert.deepEqual(countChecks(report), { ok: 1, warn: 1, fail: 1 });
  assert.equal(summaryLine(report), '1 ok, 1 warnings, 1 problems');
  assert.equal(
    formatDoctor(report),
    [
      'Opium doctor',
      '',
      'One',
      '  ✓ fine',
      '  ⚠ hmm',
      '      l1',
      '      l2',
      '      fix: do x',
      '',
      'Two',
      '  ✗ bad',
      '',
      '1 ok, 1 warnings, 1 problems',
    ].join('\n'),
  );
});

interface Command {
  description: string;
  handler: (args: string, ctx: unknown) => Promise<void>;
}

test('/opium-doctor sends one message and starts no turn', async () => {
  const home = mkdtempSync(join(tmpdir(), 'opium-doctor-'));
  const defaults = join(home, 'defaults.json');
  writeFileSync(defaults, '{"orchestrator":true,"agents":{}}\n');
  const commands = new Map<string, Command>();
  const sent: { message: Record<string, unknown>; options: unknown }[] = [];
  const pi = {
    events: { emit() {}, on: () => () => {} },
    on() {},
    registerTool() {},
    registerCommand: (name: string, def: never) => commands.set(name, def),
    sendMessage: (message: Record<string, unknown>, options: unknown) =>
      sent.push({ message, options }),
  } as unknown as ExtensionAPI;
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    createOpium(pi, { runsDir: join(home, 'runs'), defaultsPath: defaults });
  } finally {
    process.env.HOME = previous;
  }
  const command = commands.get('opium-doctor');
  assert.ok(command);
  assert.match(command.description, /--live also pings each model/);

  const notes: [string, string | undefined][] = [];
  const ctx = {
    cwd: home,
    model: { provider: 's', id: 'session', input: ['text'] },
    modelRegistry: { find: () => undefined, hasConfiguredAuth: () => true },
    ui: { notify: (m: string, l?: string) => notes.push([m, l]) },
  };
  await command.handler('', ctx);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.customType, 'opium-doctor');
  assert.equal(sent[0].message.display, true);
  assert.match(String(sent[0].message.content), /^Opium doctor/);
  assert.deepEqual(sent[0].options, { triggerTurn: false });
  assert.match(notes.at(-1)?.[0] ?? '', /doctor: \d+ ok, \d+ warnings/);

  await command.handler('--bogus', ctx);
  assert.equal(sent.length, 1);
  assert.deepEqual(notes.at(-1), ['usage: /opium-doctor [--live]', 'error']);
});

test('/opium-doctor is not registered in a subagent child', () => {
  const home = mkdtempSync(join(tmpdir(), 'opium-doctor-'));
  const commands: string[] = [];
  const pi = {
    events: { emit() {}, on: () => () => {} },
    on() {},
    registerTool() {},
    registerCommand: (name: string) => commands.push(name),
    sendMessage() {},
  } as unknown as ExtensionAPI;
  const previous = {
    home: process.env.HOME,
    child: process.env.PI_SUBAGENT_CHILD,
  };
  process.env.HOME = home;
  process.env.PI_SUBAGENT_CHILD = '1';
  try {
    createOpium(pi, { runsDir: join(home, 'runs') });
  } finally {
    process.env.HOME = previous.home;
    if (previous.child === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = previous.child;
  }
  assert.ok(commands.includes('council'));
  assert.ok(!commands.includes('opium-doctor'));
});

test('the installed runner version is read from disk', () => {
  const pkg = join(root, 'node_modules', 'pi-agent-runner', 'package.json');
  const { version } = JSON.parse(readFileSync(pkg, 'utf8')) as {
    version: string;
  };
  assert.equal(installedRunnerVersion(), version);
});
