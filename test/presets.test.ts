import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { AgentHandle } from 'pi-agent-runner';
import { loadAgent, readAgentOverrides } from '../src/agents.ts';
import { listPresets, resolvePreset, setActivePreset } from '../src/presets.ts';
import { RunRegistry, type Starter } from '../src/runs.ts';
import { createOpium } from '../extensions/opium.ts';

const dir = () => mkdtempSync(join(tmpdir(), 'opium-presets-'));
const write = (path: string, value: unknown) =>
  writeFileSync(path, JSON.stringify(value));
const read = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

test('resolvePreset: names, strict fields, extends chain', () => {
  const raw = {
    presets: {
      base: { fixer: { model: 'a/one', thinking: 'low' } },
      child: {
        extends: 'base',
        fixer: { model: 'a/two' },
        oracle: { model: 'b/x' },
      },
      'bad name': {},
      typo: { fixer: { modle: 'a/b' } },
    },
  };
  const ok = resolvePreset(raw, 'child');
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.overrides, {
    fixer: { model: 'a/two', thinking: 'low' },
    oracle: { model: 'b/x' },
  });
  for (const name of ['bad name', '__proto__', 'constructor', 'prototype']) {
    assert.match(resolvePreset(raw, name).errors[0], /invalid preset name/);
  }
  assert.match(resolvePreset(raw, 'typo').errors[0], /unknown field "modle"/);
});

test('resolvePreset: cycle, missing parent, unknown preset apply nothing', () => {
  const raw = {
    presets: {
      a: { extends: 'b', fixer: { model: 'a/m' } },
      b: { extends: 'a' },
      orphan: { extends: 'ghost', fixer: { model: 'a/m' } },
    },
  };
  const cycle = resolvePreset(raw, 'a');
  assert.match(cycle.errors[0], /cycle: a -> b -> a/);
  assert.deepEqual(cycle.overrides, {});
  const orphan = resolvePreset(raw, 'orphan');
  assert.match(orphan.errors[0], /parent of "orphan" "ghost" not found/);
  assert.deepEqual(orphan.overrides, {});
  assert.match(resolvePreset(raw, 'nope').errors[0], /"nope" not found/);
});

test('precedence: settings < preset < agents, per field', () => {
  const d = dir();
  const opium = join(d, 'opium.json');
  const settings = join(d, 'settings.json');
  write(settings, {
    subagents: {
      agentOverrides: {
        fixer: { model: 's/m', thinking: 'low' },
        oracle: { model: 's/o' },
      },
    },
  });
  write(opium, {
    preset: 'p',
    presets: { p: { fixer: { model: 'p/m', thinking: 'high' } } },
    agents: { fixer: { model: 'a/m' } },
  });
  const { overrides, errors } = readAgentOverrides(opium, settings);
  assert.deepEqual(errors, []);
  assert.deepEqual(overrides.fixer, { model: 'a/m', thinking: 'high' });
  assert.deepEqual(overrides.oracle, { model: 's/o' });
});

test('unknown active preset reports an error and applies nothing', () => {
  const d = dir();
  const opium = join(d, 'opium.json');
  write(opium, {
    preset: 'nope',
    presets: { p: { fixer: { model: 'p/m' } } },
  });
  const { overrides, errors } = readAgentOverrides(opium, join(d, 'x.json'));
  assert.deepEqual(overrides, {});
  assert.match(errors[0], /"nope" not found/);
});

test('setActivePreset keeps other keys, validates, clears on undefined', () => {
  const d = dir();
  const opium = join(d, 'opium.json');
  write(opium, {
    orchestrator: false,
    agents: { fixer: { model: 'a/m' } },
    presets: { p: { fixer: { model: 'p/m' } } },
  });
  assert.throws(() => setActivePreset(opium, 'nope'), /not found/);
  assert.equal(read(opium).preset, undefined);
  setActivePreset(opium, 'p');
  const set = read(opium);
  assert.equal(set.preset, 'p');
  assert.equal(set.orchestrator, false);
  assert.deepEqual(set.agents, { fixer: { model: 'a/m' } });
  setActivePreset(opium, undefined);
  const cleared = read(opium);
  assert.ok(!('preset' in cleared));
  assert.equal(cleared.orchestrator, false);
});

test('listPresets reports parent, active and inherited summary', () => {
  const d = dir();
  const opium = join(d, 'opium.json');
  write(opium, {
    preset: 'c',
    presets: {
      b: { fixer: { model: 'a/m', thinking: 'low' } },
      c: { extends: 'b', oracle: { model: 'o/m' } },
    },
  });
  const list = listPresets(opium);
  assert.equal(list.active, 'c');
  const c = list.presets.find((p) => p.name === 'c');
  assert.equal(c?.parent, 'b');
  assert.equal(c?.active, true);
  assert.deepEqual(c?.agents, { fixer: 'a/m (low)', oracle: 'o/m' });
});

type Handler = (args: string, ctx: unknown) => Promise<void> | void;
interface Tool {
  execute: (...args: unknown[]) => Promise<{
    content: { text: string }[];
  }>;
}

const setup = (config: Record<string, unknown>) => {
  const home = dir();
  mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
  const opium = join(home, '.pi', 'agent', 'opium.json');
  write(opium, config);
  const commands = new Map<string, Handler>();
  const tools = new Map<string, Tool>();
  const notes: { message: string; level: string }[] = [];
  const pi = {
    events: { emit() {}, on: () => () => {} },
    on() {},
    registerCommand: (n: string, o: { handler: Handler }) =>
      commands.set(n, o.handler),
    registerTool: (t: { name: string }) => tools.set(t.name, t as never),
    registerShortcut() {},
    sendMessage() {},
    sendUserMessage() {},
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: home,
    ui: {
      notify: (message: string, level: string) =>
        notes.push({ message, level }),
    },
  };
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    createOpium(pi, { runsDir: join(home, 'runs') });
  } finally {
    process.env.HOME = previous;
  }
  const withHome = async <T>(fn: () => Promise<T> | T): Promise<T> => {
    const before = process.env.HOME;
    process.env.HOME = home;
    try {
      return await fn();
    } finally {
      process.env.HOME = before;
    }
  };
  return { home, opium, commands, tools, notes, ctx, withHome };
};

const CONFIG = {
  presets: {
    cheap: { fixer: { model: 'c/fixer' } },
    deep: { fixer: { model: 'd/fixer', thinking: 'high' } },
  },
};

test('/opium-preset: list, switch, off, unknown', async () => {
  const t = setup(CONFIG);
  const run = (args: string) =>
    t.withHome(() => t.commands.get('opium-preset')!(args, t.ctx));
  await run('');
  assert.match(t.notes[0].message, /presets \(active: none\)/);
  assert.match(t.notes[0].message, /- cheap/);
  await run('cheap');
  assert.equal(
    t.notes[1].message,
    '[opium] preset cheap active; applies to new runs',
  );
  assert.equal(read(t.opium).preset, 'cheap');
  await run('');
  assert.match(t.notes[2].message, /\* cheap/);
  assert.match(t.notes[2].message, /fixer: c\/fixer/);
  await run('off');
  assert.match(t.notes[3].message, /preset cleared/);
  assert.ok(!('preset' in read(t.opium)));
  await run('ghost');
  assert.equal(t.notes[4].level, 'error');
  assert.match(t.notes[4].message, /available presets: cheap, deep/);
});

test('opium_preset tool lists, switches, clears and rejects', async () => {
  const t = setup(CONFIG);
  const call = (params: Record<string, unknown>) =>
    t.withHome(() =>
      t.tools
        .get('opium_preset')!
        .execute('c', params, undefined, undefined, t.ctx),
    );
  assert.match((await call({})).content[0].text, /presets \(active: none\)/);
  assert.equal(
    (await call({ name: 'deep' })).content[0].text,
    'preset deep active; applies to new runs',
  );
  assert.equal(read(t.opium).preset, 'deep');
  assert.match((await call({ name: 'off' })).content[0].text, /cleared/);
  await assert.rejects(call({ name: 'ghost' }), /available presets/);
});

test('a switch affects only runs started afterwards', async () => {
  const d = dir();
  const opium = join(d, 'opium.json');
  const settings = join(d, 'settings.json');
  write(opium, CONFIG);
  const agentsDir = join(d, 'agents');
  mkdirSync(agentsDir);
  writeFileSync(
    join(agentsDir, 'fixer.md'),
    '---\nname: fixer\ndescription: d\nmodel: base/fixer\n---\nbody\n',
  );
  const loadDef = (name: string) =>
    loadAgent(name, {
      dirs: [agentsDir],
      overrides: readAgentOverrides(opium, settings).overrides,
    });
  const started: (string | undefined)[] = [];
  const starter: Starter = (def) => {
    started.push(def.model);
    return Promise.resolve({
      handle: {} as unknown as AgentHandle,
      turn: {},
      warnings: [],
    });
  };
  const registry = new RunRegistry({
    runsDir: join(d, 'runs'),
    start: starter,
  });
  const first = registry.spawn(loadDef('fixer'), 'one', {
    background: true,
    cwd: d,
  });
  setActivePreset(opium, 'cheap');
  const second = registry.spawn(loadDef('fixer'), 'two', {
    background: true,
    cwd: d,
  });
  await new Promise<void>((r) => {
    setImmediate(r);
  });
  void first;
  void second;
  assert.deepEqual(started, ['base/fixer', 'c/fixer']);
});
