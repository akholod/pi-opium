import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  JSON_ERROR_PATTERNS,
  JSON_ERROR_REMINDER_MARKER,
  LOOP_GUARD_MARKER,
  MAX_TRACKED,
  WAIT_GUARD_MARKER,
  fingerprint,
  remindJsonErrors,
  toolGuards,
} from '../src/guards.ts';

/* eslint-disable @typescript-eslint/no-explicit-any, max-len */
type Handler = (event: any) => any;

const setup = () => {
  const handlers = new Map<string, Handler>();
  toolGuards({
    on: (name: string, handler: Handler) => handlers.set(name, handler),
  } as unknown as ExtensionAPI);
  let n = 0;
  const emit = (name: string, event: object) =>
    handlers.get(name)?.({ type: name, ...event });
  // one full call: tool_call then tool_result; returns block and result text
  const call = (
    toolName: string,
    input: Record<string, unknown>,
    output: string,
    id = `c${n++}`,
  ) => {
    const blocked = emit('tool_call', { toolName, toolCallId: id, input });
    if (blocked?.block) return { blocked, text: '' };
    const result = emit('tool_result', {
      toolName,
      toolCallId: id,
      input,
      content: [{ type: 'text', text: output }],
      isError: false,
    });
    const text = (result?.content ?? [{ text: output }])
      .map((p: { text: string }) => p.text)
      .join('\n');
    return { blocked: undefined, text };
  };
  return { emit, call };
};

const result = (toolName: string, text: string) => ({
  toolName,
  toolCallId: 'x',
  input: {},
  content: [{ type: 'text', text }],
  isError: true,
});

test('json recovery: patterns append the reminder, others do not', () => {
  const { emit } = setup();
  for (const text of [
    'JSON Parse error: Unexpected EOF',
    'failed to parse json',
    'Invalid JSON',
    'malformed json here',
    'Unexpected end of JSON input',
    'SyntaxError: Unexpected token } in JSON at position 3',
    "json body expected '}'",
    'json stream unexpected EOF',
  ]) {
    const out = emit('tool_result', result('edit', text));
    assert.equal(out.content.length, 2, text);
    assert.ok(out.content[1].text.includes(JSON_ERROR_REMINDER_MARKER));
  }
  assert.equal(JSON_ERROR_PATTERNS.length, 8);
  assert.equal(
    emit('tool_result', result('edit', 'file not found')),
    undefined,
  );
});

test('json recovery: excluded tools and existing marker are skipped', () => {
  const { emit } = setup();
  for (const tool of ['bash', 'read', 'fetch_content', 'web_search']) {
    assert.equal(emit('tool_result', result(tool, 'invalid json')), undefined);
  }
  const text = `invalid json ${JSON_ERROR_REMINDER_MARKER}`;
  assert.equal(emit('tool_result', result('edit', text)), undefined);
});

const failure = (args: string) =>
  `Validation failed for tool "edit":\n  - path: required\n\nReceived arguments:\n${args}`;
const toolResultMsg = (toolName: string, text: string, isError = true) => ({
  role: 'toolResult',
  toolCallId: 'x',
  toolName,
  isError,
  content: [{ type: 'text', text }],
  timestamp: 0,
});

test('context: validation failure with {} gets the reminder', () => {
  const messages = [toolResultMsg('edit', failure('{}'))];
  const snapshot = structuredClone(messages);
  const out = remindJsonErrors(messages);
  assert.equal(out?.[0].content.length, 2);
  assert.ok(out?.[0].content[1].text.includes(JSON_ERROR_REMINDER_MARKER));
  assert.deepEqual(messages, snapshot);
  // idempotent on a second pass
  assert.equal(remindJsonErrors(out ?? []), undefined);
  // wired through the context event
  const { emit } = setup();
  assert.equal(emit('context', { messages })?.messages[0].content.length, 2);
});

test('context: validation with real args, non-errors, excluded tools', () => {
  assert.equal(
    remindJsonErrors([toolResultMsg('edit', failure('{\n  "path": 1\n}'))]),
    undefined,
  );
  assert.equal(
    remindJsonErrors([toolResultMsg('edit', failure('{}'), false)]),
    undefined,
  );
  assert.equal(
    remindJsonErrors([toolResultMsg('bash', 'invalid json', true)]),
    undefined,
  );
  const out = remindJsonErrors([
    toolResultMsg('edit', 'invalid json'),
    { role: 'user', content: 'invalid json', timestamp: 0 },
  ]);
  assert.equal(out?.[0].content.length, 2);
  assert.equal(out?.[1].content, 'invalid json');
});

test('loop guard: warns on the 3rd identical call only', () => {
  const { call } = setup();
  assert.ok(!call('grep', { p: 'a' }, 'out').text.includes(LOOP_GUARD_MARKER));
  assert.ok(!call('grep', { p: 'a' }, 'out').text.includes(LOOP_GUARD_MARKER));
  assert.ok(call('grep', { p: 'a' }, 'out').text.includes(LOOP_GUARD_MARKER));
});

test('loop guard: key order is irrelevant, differing output resets', () => {
  assert.equal(
    fingerprint('x', { a: 1, b: 2 }),
    fingerprint('x', { b: 2, a: 1 }),
  );
  const { call } = setup();
  call('grep', { a: 1, b: 2 }, 'out');
  call('grep', { b: 2, a: 1 }, 'out');
  assert.ok(
    call('grep', { a: 1, b: 2 }, 'out').text.includes(LOOP_GUARD_MARKER),
  );
  const { call: other } = setup();
  other('grep', { p: 1 }, 'one');
  other('grep', { p: 1 }, 'two');
  assert.ok(!other('grep', { p: 1 }, 'three').text.includes(LOOP_GUARD_MARKER));
});

test('loop guard: blocks the 6th read after 5 confirmed, not bash', () => {
  const { call } = setup();
  for (let i = 0; i < 5; i++) {
    assert.equal(call('read', { path: 'a' }, 'same').blocked, undefined);
  }
  const blocked = call('read', { path: 'a' }, 'same').blocked;
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /Refusing to execute "read"/);
  // a different call clears the run
  assert.equal(call('read', { path: 'b' }, 'same').blocked, undefined);

  const { call: b } = setup();
  for (let i = 0; i < 8; i++) {
    assert.equal(b('bash', { command: 'ls' }, 'same').blocked, undefined);
  }
});

test('loop guard: exempt tools are ignored', () => {
  const { call } = setup();
  for (const tool of [
    'agent',
    'agent_cancel',
    'agent_message',
    'agent_revive',
    'council',
  ]) {
    for (let i = 0; i < 6; i++) {
      const r = call(tool, { x: 1 }, 'same');
      assert.equal(r.blocked, undefined);
      assert.ok(!r.text.includes(LOOP_GUARD_MARKER), tool);
    }
  }
});

test('loop guard: parallel calls are paired by id and never inflate', () => {
  const { emit } = setup();
  const content = [{ type: 'text', text: 'same' }];
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
    const r = emit('tool_call', {
      toolName: 'read',
      toolCallId: id,
      input: { path: 'p' },
    });
    assert.equal(r, undefined);
  }
  const texts = ['a', 'b', 'c'].map(
    (id) =>
      emit('tool_result', {
        toolName: 'read',
        toolCallId: id,
        input: { path: 'p' },
        content,
        isError: false,
      })?.content.length,
  );
  assert.deepEqual(texts, [undefined, undefined, 2]);
  // a result with an unknown id is stale and ignored
  assert.equal(
    emit('tool_result', {
      toolName: 'read',
      toolCallId: 'zzz',
      input: { path: 'p' },
      content,
      isError: false,
    }),
    undefined,
  );
});

const running = (id: string) => `run ${id} is still running (generation 1)`;

test('supervision: warn-only per run id, reset by another tool', () => {
  const { call } = setup();
  for (let i = 0; i < 2; i++) {
    assert.ok(
      !call('agent_result', { id: 'r-1' }, running('r-1')).text.includes(
        LOOP_GUARD_MARKER,
      ),
    );
  }
  const third = call(
    'agent_status',
    { id: 'r-1' },
    'run r-1 (fixer) running, generation 1',
  );
  assert.ok(third.text.includes(LOOP_GUARD_MARKER));
  for (let i = 0; i < 10; i++) {
    const r = call('agent_result', { id: 'r-1' }, running('r-1'));
    assert.equal(r.blocked, undefined);
  }
  // another run id has its own stream
  assert.ok(
    !call('agent_result', { id: 'r-2' }, running('r-2')).text.includes(
      LOOP_GUARD_MARKER,
    ),
  );
  // a non-supervision call resets
  call('bash', { command: 'ls' }, 'x');
  assert.ok(
    !call('agent_result', { id: 'r-1' }, running('r-1')).text.includes(
      LOOP_GUARD_MARKER,
    ),
  );
  // lifecycle change restarts the stream
  call('agent_result', { id: 'r-1' }, running('r-1'));
  const done = call(
    'agent_result',
    { id: 'r-1' },
    'run r-1 (fixer) completed, generation 1',
  );
  assert.ok(!done.text.includes(LOOP_GUARD_MARKER));
});

test('wait_for_user: warn on 2nd, refuse 3rd', () => {
  const { call } = setup();
  assert.ok(
    !call('wait_for_user', { reason: 'a' }, 'ok').text.includes(
      WAIT_GUARD_MARKER,
    ),
  );
  assert.ok(
    call('wait_for_user', { reason: 'b' }, 'ok').text.includes(
      WAIT_GUARD_MARKER,
    ),
  );
  const third = call('wait_for_user', { reason: 'c' }, 'ok');
  assert.equal(third.blocked.block, true);
  assert.match(third.blocked.reason, /wait tool/);
});

test('resets: user input, agent_end and session_start', () => {
  for (const reset of [
    (emit: ReturnType<typeof setup>['emit']) =>
      emit('input', { source: 'interactive', text: 'hi' }),
    (emit: ReturnType<typeof setup>['emit']) => emit('agent_end', {}),
    (emit: ReturnType<typeof setup>['emit']) => emit('session_start', {}),
  ]) {
    const { emit, call } = setup();
    call('wait_for_user', {}, 'ok');
    call('wait_for_user', {}, 'ok');
    reset(emit);
    assert.equal(call('wait_for_user', {}, 'ok').blocked, undefined);
  }
  // extension-sourced input does not reset
  const { emit, call } = setup();
  call('wait_for_user', {}, 'ok');
  call('wait_for_user', {}, 'ok');
  emit('input', { source: 'extension', text: 'wake' });
  assert.equal(call('wait_for_user', {}, 'ok').blocked?.block, true);

  // session_start also clears the loop run
  const s = setup();
  s.call('read', { p: 1 }, 'same');
  s.call('read', { p: 1 }, 'same');
  s.emit('session_start', {});
  assert.ok(!s.call('read', { p: 1 }, 'same').text.includes(LOOP_GUARD_MARKER));
});

test('pending calls that never finish are bounded', () => {
  const { emit, call } = setup();
  for (let i = 0; i < MAX_TRACKED + 10; i++) {
    emit('tool_call', { toolName: 'ls', toolCallId: `p${i}`, input: { i } });
  }
  assert.equal(call('ls', {}, 'x').blocked, undefined);
});
