import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadAgent,
  loadAgents,
  parseOverride,
  readAgentOverrides,
  type AgentDefinition,
} from '../src/agents.ts';
import { formatToolName, resolveMcpTools } from '../src/mcp.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const agentsDir = join(root, 'agents');
const defaultsFile = join(root, 'defaults', 'opium.json');

const tmp = (): string => mkdtempSync(join(tmpdir(), 'opium-ag-'));

const dirWith = (files: Record<string, string>): string => {
  const dir = tmp();
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(dir, `${name}.md`), text);
  }
  return dir;
};

const doc = (fm: string): string => `---\ndescription: d\n${fm}---\nbody\n`;

test('every repo agent file loads', () => {
  const { agents, errors } = loadAgents({ dirs: [agentsDir] });
  assert.deepEqual(errors, []);
  const get = (name: string): AgentDefinition => {
    const agent = agents.get(name);
    assert.ok(agent, name);
    return agent;
  };
  assert.equal(agents.size, 11);
  const explorer = get('explorer');
  assert.deepEqual(explorer.mcpServers, ['codegraph']);
  assert.deepEqual(explorer.packages, ['pi-mcp-adapter']);
  assert.deepEqual(explorer.tools, ['read', 'grep', 'find', 'ls']);
  assert.deepEqual(get('librarian').packages, ['pi-web-access']);
  assert.deepEqual(get('council').tools, []);
  const designer = get('designer');
  assert.equal(designer.tools, undefined);
  assert.equal(designer.contextFiles, true);
  assert.equal(get('observer').contextFiles, false);
});

test('an agent with no opium.json entry gets the built-in fallbacks', () => {
  const { agents } = loadAgents({ dirs: [agentsDir] });
  for (const agent of agents.values()) {
    assert.equal(agent.model, undefined, agent.name);
    assert.deepEqual(agent.models, ['inherit'], agent.name);
    assert.deepEqual(agent.fallbackModels, [], agent.name);
    assert.equal(agent.thinking, undefined, agent.name);
    assert.equal(agent.timeoutMs, undefined, agent.name);
    assert.equal(agent.toolTimeoutMs, undefined, agent.name);
    assert.equal(agent.background, false, agent.name);
    assert.equal(agent.permissionAsks, 'forward', agent.name);
    assert.equal(agent.gitGuard, true, agent.name);
    assert.deepEqual(agent.skills, [], agent.name);
  }
});

test('defaults/opium.json parses and carries the original values', () => {
  const { overrides, errors } = readAgentOverrides(defaultsFile);
  assert.deepEqual(errors, []);
  const names = [...loadAgents({ dirs: [agentsDir] }).agents.keys()];
  assert.deepEqual(Object.keys(overrides).sort(), names.sort());
  assert.equal(names.length, 11);
  for (const [name, override] of Object.entries(overrides)) {
    assert.ok(override.model, name);
    assert.ok(override.thinking, name);
    assert.ok(override.timeoutMs, name);
  }
  const { agents } = loadAgents({ dirs: [agentsDir], overrides });
  const get = (name: string): AgentDefinition => {
    const agent = agents.get(name);
    assert.ok(agent, name);
    return agent;
  };
  assert.equal(get('explorer').model, 'openai-codex/gpt-6-luna');
  assert.equal(get('explorer').thinking, 'low');
  assert.equal(get('explorer').background, true);
  assert.equal(get('explorer').timeoutMs, 600000);
  assert.equal(get('fast-generic').gitGuard, false);
  assert.equal(get('fixer').gitGuard, true);
  assert.deepEqual(get('fixer').skills, ['pnpm']);
  assert.deepEqual(get('designer').skills, ['make-interfaces-feel-better']);
  assert.equal(get('designer').timeoutMs, 1800000);
  assert.deepEqual(get('oracle').skills, ['simplify']);
  assert.equal(get('oracle').thinking, 'xhigh');
  assert.equal(get('observer').background, false);
  assert.equal(get('council').model, 'opencode-go/kimi-k3');
  assert.equal(get('councillor-alpha').model, 'openai-codex/gpt-6-luna');
  assert.equal(get('councillor-beta').model, 'opencode-go/deepseek-v4-pro');
  assert.equal(get('councillor-gamma').model, 'opencode-go/glm-5.3');
});

test('field parsing accepts strings and lists', () => {
  const dir = dirWith({
    x: doc(
      'tools: read, mcp:s, web_search\ncontextFiles: "true"\n' +
        'defaultContext: fork\n',
    ),
  });
  const agent = loadAgent('x', { dirs: [dir] });
  assert.deepEqual(agent.tools, ['read', 'web_search']);
  assert.deepEqual(agent.mcpServers, ['s']);
  assert.deepEqual(agent.packages, ['pi-mcp-adapter', 'pi-web-access']);
  assert.equal(agent.contextFiles, true);
});

test('runtime keys in an .md are an error pointing at opium.json', () => {
  const keys = [
    'model: p/m',
    'fallbackModels: p/a, p/b',
    'thinking: high',
    'timeoutMs: 5000',
    'toolTimeoutMs: 5000',
    'background: true',
    'permissionAsks: deny',
    'gitGuard: false',
    'skills: pnpm',
  ];
  for (const line of keys) {
    const key = line.split(':')[0];
    const dir = dirWith({ x: doc(`${line}\n`) });
    const file = join(dir, 'x.md');
    assert.throws(
      () => loadAgent('x', { dirs: [dir] }),
      (error: Error) =>
        error.message.startsWith(`${file}: `) &&
        error.message.includes(`field "${key}"`) &&
        error.message.includes(`"${key}" in opium.json under agents.x`),
      line,
    );
  }
  // the legacy name of background points at the current one
  const legacy = dirWith({ x: doc('async: true\n') });
  assert.throws(
    () => loadAgent('x', { dirs: [legacy] }),
    /field "async".*"background" in opium\.json under agents\.x/,
  );
  // loadAgents reports it and keeps the good files
  const mixed = dirWith({ good: doc(''), bad: doc('model: p/m\n') });
  const { agents, errors } = loadAgents({ dirs: [mixed] });
  assert.deepEqual([...agents.keys()], ['good']);
  assert.match(errors[0], /bad\.md: field "model" is not allowed/);
});

test('invalid frontmatter names the file and the field', () => {
  const cases: [string, RegExp][] = [
    [doc('bogus: 1\n'), /unknown field "bogus"/],
    [doc('name: other\n'), /name "other" must equal the file name/],
    ['---\ntools: read\n---\nbody\n', /description is required/],
    [doc('advertise: maybe\n'), /advertise must be true or false/],
    [doc('acceptanceRole: boss\n'), /acceptanceRole must be one of/],
    [
      doc('contextFiles: true\ninheritProjectContext: true\n'),
      /contextFiles and legacy inheritProjectContext/,
    ],
  ];
  for (const [text, pattern] of cases) {
    const dir = dirWith({ x: text });
    const file = join(dir, 'x.md');
    assert.throws(
      () => loadAgent('x', { dirs: [dir] }),
      (error: Error) =>
        error.message.startsWith(`${file}: `) && pattern.test(error.message),
      text,
    );
  }
});

test('loadAgents keeps good files when one is bad', () => {
  const dir = dirWith({ good: doc(''), bad: doc('bogus: 1\n') });
  const { agents, errors } = loadAgents({ dirs: [dir] });
  assert.deepEqual([...agents.keys()], ['good']);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /bad\.md: unknown field "bogus"/);
});

test('a user file overrides the package file as a whole', () => {
  const user = dirWith({ x: doc('tools: read\n') });
  const pkg = dirWith({ x: doc('tools: grep\nadvertise: true\n'), y: doc('') });
  const { agents } = loadAgents({ dirs: [user, pkg] });
  assert.deepEqual(agents.get('x')?.tools, ['read']);
  assert.equal(agents.get('x')?.advertise, false);
  assert.ok(agents.has('y'));
  assert.deepEqual(loadAgent('x', { dirs: [user, pkg] }).tools, ['read']);
});

test('overrides apply on top of the fallbacks and recompute models', () => {
  const dir = dirWith({ x: doc('') });
  const agent = loadAgent('x', {
    dirs: [dir],
    overrides: {
      x: { model: 'q/n', thinking: 'high', fallbackModels: ['q/o', 'q/n'] },
    },
  });
  assert.equal(agent.model, 'q/n');
  assert.equal(agent.thinking, 'high');
  assert.deepEqual(agent.models, ['q/n', 'q/o']);
});

test('every override field applies over the built-in fallbacks', () => {
  const dir = dirWith({ x: doc('') });
  const agent = loadAgent('x', {
    dirs: [dir],
    overrides: {
      x: {
        timeoutMs: 111,
        toolTimeoutMs: 222,
        background: true,
        permissionAsks: 'deny',
        gitGuard: false,
        skills: ['a', 'b'],
      },
    },
  });
  assert.equal(agent.timeoutMs, 111);
  assert.equal(agent.toolTimeoutMs, 222);
  assert.equal(agent.background, true);
  assert.equal(agent.permissionAsks, 'deny');
  assert.equal(agent.gitGuard, false);
  assert.deepEqual(agent.skills, ['a', 'b']);
});

test('parseOverride accepts the full field list', () => {
  const errors: string[] = [];
  const out = parseOverride(
    'o.json',
    'a',
    {
      model: 'p/m',
      fallbackModels: ['p/f'],
      thinking: 'high',
      timeoutMs: 5,
      toolTimeoutMs: '7',
      background: 'true',
      permissionAsks: 'deny',
      gitGuard: false,
      skills: 'x, y',
    },
    errors,
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(out, {
    model: 'p/m',
    fallbackModels: ['p/f'],
    thinking: 'high',
    timeoutMs: 5,
    toolTimeoutMs: 7,
    background: true,
    permissionAsks: 'deny',
    gitGuard: false,
    skills: ['x', 'y'],
  });
});

test('parseOverride: an invalid value is an error and the field is ignored', () => {
  const bad: Record<string, unknown> = {
    model: 'nope',
    fallbackModels: ['nope'],
    thinking: 'wild',
    timeoutMs: -1,
    toolTimeoutMs: 'x',
    background: 'maybe',
    permissionAsks: 'ask',
    gitGuard: 3,
    skills: 5,
  };
  for (const [key, value] of Object.entries(bad)) {
    const errors: string[] = [];
    const out = parseOverride('o.json', 'a', { [key]: value }, errors);
    assert.equal(errors.length, 1, key);
    assert.match(errors[0], new RegExp(key), key);
    assert.deepEqual(out, {}, key);
  }
});

test('readAgentOverrides reads only opium.json; settings.json is ignored', () => {
  const dir = tmp();
  const opium = join(dir, 'opium.json');
  writeFileSync(
    opium,
    JSON.stringify({
      orchestrator: true,
      agents: { a: { model: 'o/m' }, b: { fallbackModels: ['o/f'] } },
    }),
  );
  writeFileSync(
    join(dir, 'settings.json'),
    JSON.stringify({
      subagents: {
        agentOverrides: { a: { model: 's/m', thinking: 'low' }, c: {} },
      },
    }),
  );
  const { overrides, errors } = readAgentOverrides(opium);
  assert.deepEqual(errors, []);
  assert.deepEqual(overrides, {
    a: { model: 'o/m' },
    b: { fallbackModels: ['o/f'] },
  });
});

test('readAgentOverrides reports invalid entries without throwing', () => {
  const dir = tmp();
  const opium = join(dir, 'opium.json');
  writeFileSync(
    opium,
    JSON.stringify({ agents: { a: { model: 'bad', zzz: 1 }, b: 5 } }),
  );
  const { overrides, errors } = readAgentOverrides(opium);
  assert.equal(errors.length, 3);
  assert.ok(errors.every((e) => e.startsWith(opium)));
  assert.deepEqual(overrides.a, {});
  const broken = join(dir, 'broken.json');
  writeFileSync(broken, '{nope');
  assert.match(readAgentOverrides(broken).errors[0], /invalid JSON/);
});

// ---- MCP tool resolution ----

const mcpFixture = (
  settings: Record<string, unknown>,
  servers: Record<string, unknown>,
) => {
  const dir = tmp();
  mkdirSync(join(dir, 'c'));
  const configPath = join(dir, 'c', 'mcp.json');
  const cachePath = join(dir, 'cache.json');
  writeFileSync(configPath, JSON.stringify({ settings, mcpServers: servers }));
  const tool = (name: string, extra = {}) => ({ name, ...extra });
  writeFileSync(
    cachePath,
    JSON.stringify({
      version: 1,
      servers: {
        'my-mcp': { tools: [tool('do.it'), tool('other')] },
        codegraph: {
          tools: [
            tool('codegraph_explore'),
            tool('search', { uiVisibility: ['app'] }),
          ],
        },
      },
    }),
  );
  return { configPath, cachePath };
};

test('mcp: toolPrefix none keeps the tool names', () => {
  const paths = mcpFixture(
    { toolPrefix: 'server' },
    { codegraph: { directTools: true, toolPrefix: 'none' } },
  );
  assert.deepEqual(resolveMcpTools(['codegraph'], paths), {
    tools: ['codegraph_explore'],
    errors: [],
  });
});

test('mcp: server, short and mcp prefix modes', () => {
  const servers = { 'my-mcp': { directTools: true } };
  const run = (toolPrefix: string) =>
    resolveMcpTools(['my-mcp'], mcpFixture({ toolPrefix }, servers)).tools;
  assert.deepEqual(run('server'), ['my-mcp_do_it', 'my-mcp_other']);
  assert.deepEqual(run('short'), ['my_do_it', 'my_other']);
  assert.deepEqual(run('mcp'), ['mcp__my-mcp_do_it', 'mcp__my-mcp_other']);
  // default prefix is "server"
  assert.deepEqual(resolveMcpTools(['my-mcp'], mcpFixture({}, servers)).tools, [
    'my-mcp_do_it',
    'my-mcp_other',
  ]);
  // a tool already carrying the prefix is not prefixed twice
  assert.equal(
    formatToolName('codegraph_explore', 'codegraph', 'server'),
    'codegraph_explore',
  );
});

test('mcp: directTools list filters; global directTools applies', () => {
  const list = mcpFixture({}, { 'my-mcp': { directTools: ['other'] } });
  assert.deepEqual(resolveMcpTools(['my-mcp'], list).tools, ['my-mcp_other']);
  const global = mcpFixture({ directTools: true }, { 'my-mcp': {} });
  assert.equal(resolveMcpTools(['my-mcp'], global).tools.length, 2);
});

test('mcp: errors for missing, direct-less, uncached servers', () => {
  const paths = mcpFixture(
    {},
    { 'my-mcp': {}, nocache: { directTools: true }, off: { disabled: true } },
  );
  const { tools, errors } = resolveMcpTools(
    ['my-mcp', 'nocache', 'ghost', 'off'],
    paths,
  );
  assert.deepEqual(tools, []);
  assert.equal(errors.length, 4);
  assert.match(errors[0], /"my-mcp" has no direct tools/);
  assert.match(errors[1], /"nocache" is not in the metadata cache/);
  assert.match(errors[2], /"ghost" is not configured/);
  assert.match(errors[3], /"off" is disabled/);
  const missing = resolveMcpTools(['x'], {
    configPath: join(tmp(), 'none.json'),
    cachePath: paths.cachePath,
  });
  assert.match(missing.errors[0], /cannot read MCP config/);
});
