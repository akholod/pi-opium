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
        senior: { model: 'b/x' },
      },
      'bad name': {},
      typo: { fixer: { modle: 'a/b' } },
    },
  };
  const ok = resolvePreset(raw, 'child');
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.overrides, {
    fixer: { model: 'a/two', thinking: 'low' },
    senior: { model: 'b/x' },
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

test('precedence: preset < agents, field-wise, including new fields', () => {
  const d = dir();
  const opium = join(d, 'opium.json');
  write(opium, {
    preset: 'p',
    presets: {
      p: {
        fixer: {
          model: 'p/m',
          thinking: 'high',
          timeoutMs: 5,
          idleTimeoutMs: 6,
          wrapUpMs: 7,
          gitGuard: false,
        },
        senior: { skills: ['s1'], permissionAsks: 'deny' },
        scout: { mcpServers: ['idx'] },
      },
    },
    agents: {
      fixer: { model: 'a/m', timeoutMs: 9, wrapUpMs: 11, background: true },
      senior: { skills: ['s2'] },
      scout: { mcpServers: ['idx2', 'idx3'] },
    },
  });
  write(join(d, 'settings.json'), {
    subagents: { agentOverrides: { fixer: { model: 's/m' }, x: {} } },
  });
  const { overrides, errors } = readAgentOverrides(opium);
  assert.deepEqual(errors, []);
  assert.deepEqual(overrides.fixer, {
    model: 'a/m',
    thinking: 'high',
    timeoutMs: 9,
    idleTimeoutMs: 6,
    wrapUpMs: 11,
    gitGuard: false,
    background: true,
  });
  assert.deepEqual(overrides.senior, {
    skills: ['s2'],
    permissionAsks: 'deny',
  });
  assert.deepEqual(overrides.scout, { mcpServers: ['idx2', 'idx3'] });
  assert.equal(overrides.x, undefined);
});

test('a preset validates mcpServers like skills', () => {
  const opium = join(dir(), 'opium.json');
  write(opium, {
    preset: 'p',
    presets: { p: { scout: { mcpServers: 5 }, fixer: { mcpServers: 'a, b' } } },
  });
  const { overrides, errors } = readAgentOverrides(opium);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /mcpServers/);
  assert.deepEqual(overrides.fixer, { mcpServers: ['a', 'b'] });
  assert.deepEqual(overrides.scout, {});
});

test('presets.<p>.<legacy> applies to the new agent with a warning; the new key wins', () => {
  const opium = join(dir(), 'opium.json');
  write(opium, {
    preset: 'p',
    presets: {
      base: { librarian: { model: 'b/m', thinking: 'low' } },
      p: {
        extends: 'base',
        observer: { model: 'o/old', skills: ['s'] },
        vision: { model: 'o/new' },
      },
    },
  });
  const { overrides, errors } = readAgentOverrides(opium);
  assert.deepEqual(errors, [
    `${opium}: preset "base": agent "librarian" was renamed to ` +
      '"researcher"; rename the key',
    `${opium}: preset "p": agent "observer" was renamed to "vision"; ` +
      'rename the key',
  ]);
  assert.deepEqual(overrides, {
    researcher: { model: 'b/m', thinking: 'low' },
    vision: { model: 'o/new', skills: ['s'] },
  });
  const listed = listPresets(opium).presets.find((p) => p.name === 'p');
  assert.deepEqual(Object.keys(listed?.agents ?? {}).sort(), [
    'researcher',
    'vision',
  ]);
});

test('unknown active preset reports an error and applies nothing', () => {
  const d = dir();
  const opium = join(d, 'opium.json');
  write(opium, {
    preset: 'nope',
    presets: { p: { fixer: { model: 'p/m' } } },
  });
  const { overrides, errors } = readAgentOverrides(opium);
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
      c: { extends: 'b', senior: { model: 'o/m' } },
    },
  });
  const list = listPresets(opium);
  assert.equal(list.active, 'c');
  const c = list.presets.find((p) => p.name === 'c');
  assert.equal(c?.parent, 'b');
  assert.equal(c?.active, true);
  assert.deepEqual(c?.agents, { fixer: 'a/m (low)', senior: 'o/m' });
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
  write(opium, CONFIG);
  const agentsDir = join(d, 'agents');
  mkdirSync(agentsDir);
  writeFileSync(
    join(agentsDir, 'fixer.md'),
    '---\nname: fixer\ndescription: d\n---\nbody\n',
  );
  const loadDef = (name: string) =>
    loadAgent(name, {
      dirs: [agentsDir],
      overrides: readAgentOverrides(opium).overrides,
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
  assert.deepEqual(started, [undefined, 'c/fixer']);
});
