import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadAgent,
  loadAgents,
  readAgentOverrides,
  type AgentDefinition,
} from '../src/agents.ts';
import { formatToolName, resolveMcpTools } from '../src/mcp.ts';

const agentsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'agents');

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
  assert.equal(explorer.background, true);
  assert.deepEqual(explorer.mcpServers, ['codegraph']);
  assert.deepEqual(explorer.packages, ['pi-mcp-adapter']);
  assert.deepEqual(explorer.tools, ['read', 'grep', 'find', 'ls']);
  assert.deepEqual(get('librarian').packages, ['pi-web-access']);
  assert.deepEqual(get('council').tools, []);
  const designer = get('designer');
  assert.equal(designer.tools, undefined);
  assert.equal(designer.contextFiles, true);
  assert.deepEqual(designer.skills, ['make-interfaces-feel-better']);
  assert.equal(get('fast-generic').gitGuard, false);
  assert.equal(get('fixer').gitGuard, true);
  assert.equal(get('oracle').thinking, 'xhigh');
  assert.equal(get('observer').background, false);
});

test('field parsing accepts strings and lists', () => {
  const dir = dirWith({
    x: doc(
      'background: "true"\ntimeoutMs: "5000"\nskills: [a, b]\n' +
        'tools: read, mcp:s, web_search\nfallbackModels: p/a, p/b\n' +
        'model: p/a\npermissionAsks: deny\ndefaultContext: fork\n',
    ),
  });
  const agent = loadAgent('x', { dirs: [dir] });
  assert.equal(agent.background, true);
  assert.equal(agent.timeoutMs, 5000);
  assert.deepEqual(agent.skills, ['a', 'b']);
  assert.deepEqual(agent.tools, ['read', 'web_search']);
  assert.deepEqual(agent.packages, ['pi-mcp-adapter', 'pi-web-access']);
  assert.deepEqual(agent.models, ['p/a', 'p/b']);
  assert.equal(agent.permissionAsks, 'deny');
});

test('invalid frontmatter names the file and the field', () => {
  const cases: [string, RegExp][] = [
    [doc('bogus: 1\n'), /unknown field "bogus"/],
    [doc('thinking: ludicrous\n'), /thinking must be one of/],
    [doc('model: nope\n'), /model must look like provider\/id/],
    [doc('model: p/\n'), /model must look like provider\/id/],
    [doc('async: true\nbackground: true\n'), /background and legacy async/],
    [doc('name: other\n'), /name "other" must equal the file name/],
    ['---\nmodel: a/b\n---\nbody\n', /description is required/],
    [doc('gitGuard: maybe\n'), /gitGuard must be true or false/],
    [doc('timeoutMs: -1\n'), /timeoutMs must be a positive number/],
    [doc('acceptanceRole: boss\n'), /acceptanceRole must be one of/],
    [doc('permissionAsks: ask\n'), /permissionAsks must be one of/],
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
  const user = dirWith({ x: doc('model: u/m\n') });
  const pkg = dirWith({ x: doc('model: p/m\nthinking: high\n'), y: doc('') });
  const { agents } = loadAgents({ dirs: [user, pkg] });
  assert.equal(agents.get('x')?.model, 'u/m');
  assert.equal(agents.get('x')?.thinking, undefined);
  assert.ok(agents.has('y'));
  assert.equal(loadAgent('x', { dirs: [user, pkg] }).model, 'u/m');
});

test('overrides apply on top of the file and recompute models', () => {
  const dir = dirWith({ x: doc('model: p/m\nthinking: low\n') });
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

test('readAgentOverrides: opium.json wins per field, settings is limited', () => {
  const dir = tmp();
  const opium = join(dir, 'opium.json');
  const settings = join(dir, 'settings.json');
  writeFileSync(
    opium,
    JSON.stringify({
      orchestrator: true,
      agents: {
        a: { model: 'o/m' },
        b: { fallbackModels: ['o/f'] },
      },
    }),
  );
  writeFileSync(
    settings,
    JSON.stringify({
      subagents: {
        agentOverrides: {
          a: { model: 's/m', thinking: 'low', fallbackModels: ['s/f'] },
          b: { model: 's/b', tools: ['x'] },
        },
      },
    }),
  );
  const { overrides, errors } = readAgentOverrides(opium, settings);
  assert.deepEqual(errors, []);
  assert.deepEqual(overrides.a, { model: 'o/m', thinking: 'low' });
  assert.deepEqual(overrides.b, { model: 's/b', fallbackModels: ['o/f'] });
});

test('readAgentOverrides reports invalid entries without throwing', () => {
  const dir = tmp();
  const opium = join(dir, 'opium.json');
  writeFileSync(
    opium,
    JSON.stringify({ agents: { a: { model: 'bad', zzz: 1 }, b: 5 } }),
  );
  const { overrides, errors } = readAgentOverrides(
    opium,
    join(dir, 'missing.json'),
  );
  assert.equal(errors.length, 3);
  assert.ok(errors.every((e) => e.startsWith(opium)));
  assert.deepEqual(overrides.a, {});
  const broken = join(dir, 'broken.json');
  writeFileSync(broken, '{nope');
  assert.match(readAgentOverrides(broken, broken).errors[0], /invalid JSON/);
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
