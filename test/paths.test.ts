import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { pathGuards } from '../src/paths.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Handler = (event: any, ctx: any) => any;

const setup = () => {
  const cwd = path.join(
    realpathSync(mkdtempSync(path.join(tmpdir(), 'opium-paths-'))),
    'work',
    'proj',
  );
  mkdirSync(path.join(cwd, 'src', 'deep'), { recursive: true });
  writeFileSync(path.join(cwd, 'src', 'a.ts'), '');
  writeFileSync(path.join(cwd, 'src', 'deep', 'b.ts'), '');
  const handlers = new Map<string, Handler>();
  pathGuards({
    on: (name: string, handler: Handler) => handlers.set(name, handler),
  } as unknown as ExtensionAPI);
  const call = (toolName: string, input: Record<string, unknown>) => {
    const result = handlers.get('tool_call')?.(
      { type: 'tool_call', toolName, toolCallId: 'c', input },
      { cwd },
    );
    return { result, input };
  };
  return { cwd, call };
};

test('rescues a wrong absolute prefix to the unique in-workspace file', () => {
  const { cwd, call } = setup();
  for (const tool of ['read', 'grep', 'find', 'ls']) {
    const { result, input } = call(tool, {
      path: '/nowhere/proj/src/a.ts',
    });
    assert.equal(result, undefined, tool);
    assert.equal(input.path, path.join(cwd, 'src', 'a.ts'), tool);
  }
});

test('rescues a dropped-parents guess to the workspace root', () => {
  const { cwd, call } = setup();
  const { result, input } = call('ls', { path: '/other/work/proj' });
  assert.equal(result, undefined);
  assert.equal(input.path, cwd);
});

test('no rescue when the tail is missing; guard then blocks', () => {
  const { call } = setup();
  const { result, input } = call('grep', {
    pattern: 'x',
    path: '/nowhere/proj/src/missing.ts',
  });
  assert.equal(input.path, '/nowhere/proj/src/missing.ts');
  assert.equal(result.block, true);
});

test('no rescue when ambiguous', () => {
  const { call } = setup();
  const guess = '/x/proj/src/a.ts/../proj/src/a.ts';
  const ambiguous = '/x/proj/y/proj/src/a.ts';
  for (const p of [guess, ambiguous]) {
    const { input } = call('read', { path: p });
    assert.equal(input.path, p);
  }
});

test('no rescue for existing, relative, or dot-segment paths', () => {
  const { cwd, call } = setup();
  const existing = path.join(cwd, 'src');
  assert.equal(call('ls', { path: existing }).input.path, existing);
  assert.equal(call('read', { path: 'src/nope.ts' }).input.path, 'src/nope.ts');
  const dotted = '/nowhere/proj/src/../src/a.ts';
  assert.equal(call('read', { path: dotted }).input.path, dotted);
  const dot = '/nowhere/proj/./src/a.ts';
  assert.equal(call('read', { path: dot }).input.path, dot);
});

test('never rescues outside the tool list', () => {
  const { call } = setup();
  const p = '/nowhere/proj/src/a.ts';
  assert.equal(call('bash', { path: p }).input.path, p);
  assert.equal(call('ffgrep', { path: p }).input.path, p);
});

test('guard blocks missing grep/find/ls paths and passes existing ones', () => {
  const { cwd, call } = setup();
  for (const tool of ['grep', 'find', 'ls']) {
    const blocked = call(tool, { path: 'nope' }).result;
    assert.equal(blocked.block, true, tool);
    assert.match(blocked.reason, /does not exist/);
    assert.match(blocked.reason, new RegExp(path.join(cwd, 'nope')));
    assert.equal(call(tool, { path: 'src' }).result, undefined, tool);
    assert.equal(
      call(tool, { path: path.join(cwd, 'src', 'a.ts') }).result,
      undefined,
      tool,
    );
  }
});

test('guard is a no-op for missing or empty path and ignores read/unknown tools', () => {
  const { call } = setup();
  assert.equal(call('grep', { pattern: 'x' }).result, undefined);
  assert.equal(call('find', { pattern: 'x', path: '' }).result, undefined);
  assert.equal(call('read', { path: 'nope.ts' }).result, undefined);
  assert.equal(call('ffgrep', { path: 'nope' }).result, undefined);
  assert.equal(call('bash', { path: 'nope' }).result, undefined);
});
