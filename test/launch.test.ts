import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BuiltinMcpServer, ParentContext } from 'pi-agent-runner';
import {
  loadAgent,
  type AgentDefinition,
  type AgentOverride,
} from '../src/agents.ts';
import {
  activateAllowed,
  buildLaunch,
  ctx7OnlyBash,
  readOnlyLsp,
  skillResolver,
  type LaunchContext,
} from '../src/launch.ts';
import { sessionGuards } from '../src/guards.ts';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const parent = {} as ParentContext;

// fm is the .md frontmatter; runtime values come from an opium.json override
const agent = (
  fm: string,
  override: AgentOverride = {},
  body = 'PROMPT',
): AgentDefinition => {
  const dir = mkdtempSync(join(tmpdir(), 'opium-ln-'));
  writeFileSync(join(dir, 'a.md'), `---\ndescription: d\n${fm}---\n${body}\n`);
  return loadAgent('a', { dirs: [dir], overrides: { a: override } });
};

const base = { parent, cwd: '/work' };

test('defaults: no tools, no extensions, no context files', () => {
  const { start, turn, warnings } = buildLaunch(agent(''), base);
  assert.equal(start.tools, undefined);
  assert.equal(start.systemPrompt, 'PROMPT');
  assert.equal(start.extensions, 'none');
  assert.equal(start.noContextFiles, true);
  assert.equal(start.noSkills, true);
  assert.equal(start.model, 'inherit');
  assert.equal(start.permissionAsks, 'forward');
  assert.equal(start.gitGuard, true);
  assert.equal(start.extensionFactories, sessionGuards);
  assert.deepEqual(start.label, { name: 'a', context: 'opium' });
  assert.equal(start.cwd, '/work');
  assert.equal(start.parent, parent);
  assert.deepEqual(turn, {});
  assert.deepEqual(warnings, []);
});

const builtin = (
  ...servers: [string, boolean][]
): Pick<LaunchContext, 'builtinMcpServers' | 'builtinMcpDisabled'> => ({
  builtinMcpServers: () =>
    servers.map(([name, enabled]) => ({ name, enabled }) as BuiltinMcpServer),
  builtinMcpDisabled: () => false,
});

const noAdapter: LaunchContext['resolveMcp'] = () => {
  throw new Error('adapter must not be consulted');
};

test('a built-in MCP server goes to the runner, not the adapter', () => {
  const def = agent('tools: read\n', { mcpServers: ['codegraph'] });
  const { start, warnings } = buildLaunch(def, {
    ...base,
    ...builtin(['codegraph', true]),
    resolveMcp: noAdapter,
  });
  assert.deepEqual(start.mcpServers, ['codegraph']);
  assert.deepEqual(start.tools, ['read']);
  assert.equal(start.extensions, 'none');
  assert.deepEqual(warnings, []);
});

test('an adapter-only server adds tool names and the adapter package', () => {
  const def = agent('tools: read, mcp:codegraph\n');
  const { start, warnings } = buildLaunch(def, {
    ...base,
    ...builtin(),
    resolveMcp: (servers) => {
      assert.deepEqual(servers, ['codegraph']);
      return { tools: ['codegraph_search'], errors: ['no cache'] };
    },
  });
  assert.deepEqual(start.tools, ['read', 'codegraph_search']);
  assert.deepEqual(start.extensions, { packages: ['pi-mcp-adapter'] });
  assert.equal(start.mcpServers, undefined);
  assert.deepEqual(warnings, ['no cache']);
});

test('built-in MCP disabled sends the server to the adapter', () => {
  const def = agent('tools: read\n', { mcpServers: ['codegraph'] });
  const { start } = buildLaunch(def, {
    ...base,
    builtinMcpServers: () => [{ name: 'codegraph', enabled: true }],
    builtinMcpDisabled: () => true,
    resolveMcp: () => ({ tools: ['codegraph_search'], errors: [] }),
  });
  assert.equal(start.mcpServers, undefined);
  assert.deepEqual(start.tools, ['read', 'codegraph_search']);
  assert.deepEqual(start.extensions, { packages: ['pi-mcp-adapter'] });
});

test('a disabled built-in server falls back to the adapter', () => {
  const def = agent('tools: read\n', { mcpServers: ['codegraph'] });
  const { start } = buildLaunch(def, {
    ...base,
    ...builtin(['codegraph', false]),
    resolveMcp: () => ({ tools: ['codegraph_search'], errors: [] }),
  });
  assert.equal(start.mcpServers, undefined);
  assert.deepEqual(start.tools, ['read', 'codegraph_search']);
});

test('an unknown server is skipped without a warning', () => {
  const def = agent('tools: read\n', { mcpServers: ['ghost'] });
  const { start, warnings } = buildLaunch(def, {
    ...base,
    ...builtin(['other', true]),
    resolveMcp: () => ({ tools: [], errors: [] }),
  });
  assert.equal(start.mcpServers, undefined);
  assert.deepEqual(start.tools, ['read']);
  assert.equal(start.extensions, 'none');
  assert.deepEqual(warnings, []);
});

test('mixed servers: built-in, adapter and unknown', () => {
  const def = agent('tools: read, web_search\n', {
    mcpServers: ['b', 'a', 'ghost'],
  });
  const { start, warnings } = buildLaunch(def, {
    ...base,
    ...builtin(['b', true]),
    resolveMcp: (servers) => {
      assert.deepEqual(servers, ['a', 'ghost']);
      return { tools: ['a_tool'], errors: [] };
    },
  });
  assert.deepEqual(start.mcpServers, ['b']);
  assert.deepEqual(start.tools, ['read', 'web_search', 'a_tool']);
  assert.deepEqual(start.extensions, {
    packages: ['pi-mcp-adapter', 'pi-web-access'],
  });
  assert.deepEqual(warnings, []);
});

test('MCP resolution throwing still launches', () => {
  const def = agent('tools: read, mcp:x\n');
  const { start, warnings } = buildLaunch(def, {
    ...base,
    ...builtin(),
    resolveMcp: () => {
      throw new Error('boom');
    },
  });
  assert.deepEqual(start.tools, ['read']);
  assert.equal(start.extensions, 'none');
  assert.deepEqual(warnings, ['boom']);
});

test('contextFiles, model, thinking, limits', () => {
  const def = agent('contextFiles: true\n', {
    model: 'p/m',
    fallbackModels: ['p/n'],
    thinking: 'high',
    timeoutMs: 5,
    wrapUpMs: 3,
    idleTimeoutMs: 4,
    toolTimeoutMs: 7,
    permissionAsks: 'deny',
    gitGuard: false,
  });
  const { start, turn } = buildLaunch(def, base);
  assert.equal(start.noContextFiles, false);
  assert.equal(start.model, 'p/m');
  assert.equal(start.thinking, 'high');
  assert.equal(start.permissionAsks, 'deny');
  assert.equal(start.gitGuard, false);
  assert.deepEqual(turn, {
    timeoutMs: 5,
    wrapUpMs: 3,
    idleTimeoutMs: 4,
    toolTimeoutMs: 7,
  });
});

test('skills are appended; a missing one warns', () => {
  const def = agent('', { skills: ['one', 'gone'] });
  const { start, warnings } = buildLaunch(def, {
    ...base,
    resolveSkill: (name) =>
      name === 'one' ? { path: '/s/one', content: '\n  Do one.\n' } : undefined,
  });
  assert.equal(
    start.systemPrompt,
    'PROMPT\n\n<skill name="one">\nDo one.\n</skill>',
  );
  assert.deepEqual(warnings, ['skill gone not found']);
});

test('skillResolver reads the skill file without frontmatter', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opium-sk-'));
  const file = join(dir, 'SKILL.md');
  writeFileSync(file, '---\nname: one\ndescription: d\n---\nDo one.\n');
  const resolve = skillResolver(new Map([['one', file]]));
  assert.deepEqual(resolve('one', '/work'), {
    path: file,
    content: 'Do one.',
  });
  assert.equal(resolve('gone', '/work'), undefined);
});

test('extensions merge into packages; pi-lens adds its read-only tools', () => {
  const def = agent('tools: read, grep\n', { extensions: ['pi-lens'] });
  const { start } = buildLaunch(def, base);
  assert.deepEqual(start.extensions, { packages: ['pi-lens'] });
  assert.deepEqual(start.tools, [
    'read',
    'grep',
    'lsp_navigation',
    'lens_diagnostics',
    'ast_grep_search',
    'ast_grep_outline',
    'symbol_search',
    'read_symbol',
    'read_enclosing',
  ]);
  assert.ok(!start.tools?.includes('ast_grep_replace'));
});

test('extraTools patterns are appended once, with or without extensions', () => {
  const def = agent('tools: read, ast_grep_replace\n', {
    extensions: ['pi-lens'],
    extraTools: ['ast_grep_replace', 'lens_*'],
  });
  const { start } = buildLaunch(def, base);
  assert.equal(
    start.tools?.filter((tool) => tool === 'ast_grep_replace').length,
    1,
  );
  assert.ok(start.tools?.includes('lens_*'));
  const alone = buildLaunch(
    agent('tools: read\n', { extraTools: ['x_*'] }),
    base,
  );
  assert.deepEqual(alone.start.tools, ['read', 'x_*']);
  assert.equal(alone.start.extensions, 'none');
});

test('extensions keep the other packages and the adapter, without duplicates', () => {
  const def = agent('tools: read, web_search\n', {
    extensions: ['pi-lens', 'pi-web-access'],
    mcpServers: ['notes'],
  });
  const { start } = buildLaunch(def, {
    ...base,
    ...builtin(),
    resolveMcp: () => ({ tools: ['notes_a'], errors: [] }),
  });
  assert.deepEqual(start.extensions, {
    packages: ['pi-mcp-adapter', 'pi-web-access', 'pi-lens'],
  });
});

test('without a tool list extensions load but no allowlist appears', () => {
  const { start } = buildLaunch(
    agent('', { extensions: ['pi-lens'], extraTools: ['x'] }),
    base,
  );
  assert.deepEqual(start.extensions, { packages: ['pi-lens'] });
  assert.equal(start.tools, undefined);
});

test('lsp_navigation cannot change files for an agent without edit or write', async () => {
  const readOnly = buildLaunch(
    agent('tools: read, grep\n', { extensions: ['pi-lens'] }),
    base,
  ).start;
  assert.ok(readOnly.extensionFactories?.includes(readOnlyLsp));
  const writer = buildLaunch(
    agent('tools: read, edit, write\n', { extensions: ['pi-lens'] }),
    base,
  ).start;
  assert.ok(!writer.extensionFactories?.includes(readOnlyLsp));

  type Handler = (event: unknown) => unknown;
  let handler: Handler | undefined;
  readOnlyLsp({
    on: (_name: string, fn: Handler) => {
      handler = fn;
    },
  } as never);
  const call = (toolName: string, operation: string) =>
    handler?.({ toolName, input: { operation } });
  assert.equal(call('lsp_navigation', 'definition'), undefined);
  assert.equal(call('lsp_navigation', 'references'), undefined);
  for (const op of ['rename', 'rename_file', 'codeAction', 'executeCommand']) {
    assert.match(
      (call('lsp_navigation', op) as { reason: string }).reason,
      new RegExp(`${op} changes files`),
    );
  }
  assert.equal(call('read', 'rename'), undefined);
});

test('allowlisted tools pi-lens left inactive are switched on before a generation', () => {
  const start = buildLaunch(
    agent('tools: read, grep\n', { extensions: ['pi-lens'] }),
    base,
  ).start;
  assert.ok((start.extensionFactories?.length ?? 0) > sessionGuards.length);

  type Handler = () => unknown;
  let handler: Handler | undefined;
  let active = ['read', 'grep', 'lens_diagnostics'];
  activateAllowed(['read', 'grep', 'lsp_navigation', 'mcp__x__*'])({
    on: (_name: string, fn: Handler) => {
      handler = fn;
    },
    getActiveTools: () => active,
    getAllTools: () =>
      ['read', 'grep', 'lsp_navigation', 'ast_grep_replace', 'mcp__x__a'].map(
        (name) => ({ name }),
      ),
    setActiveTools: (names: string[]) => {
      active = names;
    },
  } as never);
  handler?.();
  assert.deepEqual(active, [
    'read',
    'grep',
    'lens_diagnostics',
    'lsp_navigation',
    'mcp__x__a',
  ]);
});

test('researcher bash is limited to ctx7 library and docs', () => {
  const researcher = (fm: string) => ({
    ...agent(fm),
    name: 'researcher',
  });
  const guarded = buildLaunch(researcher('tools: read, bash\n'), base).start;
  assert.ok(guarded.extensionFactories?.includes(ctx7OnlyBash));
  const noBash = buildLaunch(researcher('tools: read\n'), base).start;
  assert.ok(!noBash.extensionFactories?.includes(ctx7OnlyBash));
  const other = buildLaunch(agent('tools: read, bash\n'), base).start;
  assert.ok(!other.extensionFactories?.includes(ctx7OnlyBash));

  type Handler = (event: unknown) => unknown;
  let handler: Handler | undefined;
  ctx7OnlyBash({
    on: (_name: string, fn: Handler) => {
      handler = fn;
    },
  } as never);
  const bash = (command: unknown) =>
    handler?.({ toolName: 'bash', input: { command } });
  for (const command of [
    'ctx7 library React "hooks"',
    'ctx7 docs /vercel/next.js "app router"',
    'npx -y ctx7@latest docs /x/y "q"',
    'npx ctx7 library Next.js "routing"',
    '  ctx7 docs /a/b "q"  ',
  ]) {
    assert.equal(bash(command), undefined, command);
  }
  for (const command of [
    'ls',
    'ctx7 login',
    'ctx7 docs /a/b "q"; rm -rf x',
    'ctx7 docs /a/b "q" && ls',
    'ctx7 docs /a/b "$(cat ~/.ssh/id_rsa)"',
    'ctx7 docs /a/b "$HOME"',
    'ctx7 docs /a/b "`id`"',
    'ctx7 docs /a/b "q" > out.txt',
    'ctx7 docs /a/b "q"\nls',
    'cat x | ctx7 docs /a/b "q"',
    'ctx7 docs /a/b "q" | sh',
    'npx evil library x',
    'ctx7library x',
    undefined,
  ]) {
    assert.match(
      (bash(command) as { reason: string }).reason,
      /ctx7 library/,
      String(command),
    );
  }
  assert.equal(handler?.({ toolName: 'read', input: {} }), undefined);
});
