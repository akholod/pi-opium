import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ParentContext } from 'pi-agent-runner';
import {
  loadAgent,
  type AgentDefinition,
  type AgentOverride,
} from '../src/agents.ts';
import { buildLaunch, skillResolver } from '../src/launch.ts';
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

test('tools get MCP names; packages become extensions', () => {
  const def = agent('tools: read, mcp:codegraph\n');
  const { start, warnings } = buildLaunch(def, {
    ...base,
    resolveMcp: (servers) => {
      assert.deepEqual(servers, ['codegraph']);
      return { tools: ['codegraph_search'], errors: ['no cache'] };
    },
  });
  assert.deepEqual(start.tools, ['read', 'codegraph_search']);
  assert.deepEqual(start.extensions, { packages: ['pi-mcp-adapter'] });
  assert.deepEqual(warnings, ['no cache']);
});

test('MCP resolution throwing still launches', () => {
  const def = agent('tools: read, mcp:x\n');
  const { start, warnings } = buildLaunch(def, {
    ...base,
    resolveMcp: () => {
      throw new Error('boom');
    },
  });
  assert.deepEqual(start.tools, ['read']);
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
