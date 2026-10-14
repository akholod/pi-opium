import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ContextEvent,
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { createOpium } from '../extensions/opium.ts';
import {
  COUNCIL_MODE_BLOCK,
  PHASE_REMINDER,
  injectReminders,
  matchesCouncilTrigger,
} from '../src/reminders.ts';

type Messages = ContextEvent['messages'];

const user = (content: unknown) =>
  ({ role: 'user', content, timestamp: 1 }) as unknown as Messages[number];

const texts = (message: Messages[number]): string[] =>
  ((message as { content: { text: string }[] }).content ?? []).map(
    (p) => p.text,
  );

test('council trigger matrix', () => {
  for (const text of [
    'convene the council please',
    '@council what do you think',
    'I want a consensus',
    'need a second opinion',
    'ask a multi-model panel',
    '需要共识',
    'нужен совет моделей',
    'Хочу второе мнение',
    'Нужен КОНСЕНСУС',
    'спроси несколько моделей',
    'мнения разных моделей?',
  ]) {
    assert.equal(matchesCouncilTrigger(text), true, text);
  }
  for (const text of [
    'see ```\ncouncil\n``` here',
    'run `council` now',
    '/council question about consensus',
    'good counsel is rare',
    'unrelated text',
  ]) {
    assert.equal(matchesCouncilTrigger(text), false, text);
  }
});

test('injects phase reminder into every user message, council on trigger', () => {
  const messages = [
    user('plain question'),
    user([{ type: 'text', text: 'give me a second opinion' }]),
    user([
      { type: 'image', data: 'x', mimeType: 'image/png' },
      { type: 'text', text: 'hello' },
      { type: 'text', text: 'and a consensus' },
    ]),
    user('/council consensus please'),
  ];
  const out = injectReminders(messages);
  assert.deepEqual(texts(out[0]), ['plain question', PHASE_REMINDER]);
  assert.deepEqual(texts(out[1]), [
    'give me a second opinion',
    PHASE_REMINDER,
    COUNCIL_MODE_BLOCK,
  ]);
  assert.deepEqual(texts(out[2]).slice(-2), [
    PHASE_REMINDER,
    COUNCIL_MODE_BLOCK,
  ]);
  assert.deepEqual(texts(out[3]), [
    '/council consensus please',
    PHASE_REMINDER,
  ]);
});

test('does not mutate input and is idempotent', () => {
  const messages = [
    user('consensus?'),
    user([{ type: 'text', text: 'hi' }]),
    { role: 'assistant', content: [{ type: 'text', text: 'council' }] },
  ] as unknown as Messages;
  const snapshot = structuredClone(messages);
  const once = injectReminders(messages);
  assert.deepEqual(messages, snapshot);
  assert.notEqual(once, messages);
  const twice = injectReminders(once);
  assert.deepEqual(twice, once);
  assert.deepEqual(injectReminders(messages), once);
});

test('non-user messages are untouched', () => {
  const others = [
    { role: 'assistant', content: [{ type: 'text', text: 'council' }] },
    { role: 'toolResult', content: [{ type: 'text', text: 'consensus' }] },
    { role: 'custom', customType: 'x', content: 'consensus' },
  ] as unknown as Messages;
  const out = injectReminders(others);
  assert.deepEqual(out, others);
  out.forEach((m, i) => assert.equal(m, others[i]));
});

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

const setup = (orchestrator: boolean) => {
  const home = mkdtempSync(join(tmpdir(), 'opium-rem-'));
  mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
  writeFileSync(
    join(home, '.pi', 'agent', 'opium.json'),
    JSON.stringify({ orchestrator }),
  );
  const handlers = new Map<string, Handler[]>();
  const pi = {
    events: { emit() {}, on: () => () => {} },
    on: (name: string, fn: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), fn]);
    },
    registerTool() {},
    registerCommand() {},
    sendMessage() {},
  } as unknown as ExtensionAPI;
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    createOpium(pi, { runsDir: join(home, 'runs') });
  } finally {
    process.env.HOME = previous;
  }
  return async (messages: Messages) => {
    const results: unknown[] = [];
    for (const fn of handlers.get('context') ?? []) {
      results.push(
        await fn({ type: 'context', messages }, {} as ExtensionContext),
      );
    }
    return results as { messages?: Messages }[];
  };
};

test('context handler injects when orchestrator is on', async () => {
  const run = setup(true);
  // the guards' context handler is registered first
  const result = (await run([user('hello')])).at(-1)!;
  assert.deepEqual(texts(result.messages![0]), ['hello', PHASE_REMINDER]);
});

test('context handler does nothing when orchestrator is off', async () => {
  const run = setup(false);
  // the guards' context handler is registered first
  const result = (await run([user('hello')])).at(-1)!;
  assert.equal(result.messages, undefined);
});

// Extension-originated user messages (pi.sendUserMessage) carry no marker in
// the message; opium records them from the `input` event as session entries.
const setupWithBranch = (branch: unknown[]) => {
  const home = mkdtempSync(join(tmpdir(), 'opium-rem-'));
  mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
  writeFileSync(
    join(home, '.pi', 'agent', 'opium.json'),
    JSON.stringify({ orchestrator: true }),
  );
  const handlers = new Map<string, Handler[]>();
  const pi = {
    events: { emit() {}, on: () => () => {} },
    on: (name: string, fn: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), fn]);
    },
    registerTool() {},
    registerCommand() {},
    sendMessage() {},
    appendEntry: (customType: string, data: unknown) => {
      branch.push({ type: 'custom', customType, data });
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    sessionManager: { getBranch: () => branch },
  } as unknown as ExtensionContext;
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    createOpium(pi, { runsDir: join(home, 'runs') });
  } finally {
    process.env.HOME = previous;
  }
  return {
    input: async (text: string, source: string) => {
      for (const fn of handlers.get('input') ?? []) {
        await fn({ type: 'input', text, source }, ctx);
      }
    },
    context: async (messages: Messages) => {
      let out: Messages | undefined;
      for (const fn of handlers.get('context') ?? []) {
        const result = (await fn({ type: 'context', messages }, ctx)) as
          { messages?: Messages } | undefined;
        if (result?.messages) out = result.messages;
      }
      return out!;
    },
  };
};

const PI_LENS =
  '[pi-lens automated context — not a user request] review src/council.ts ' +
  'for consensus handling';

test('extension-originated user message gets no reminder, typed one does', async () => {
  const branch: unknown[] = [];
  const opium = setupWithBranch(branch);
  await opium.input(PI_LENS, 'extension');
  await opium.input('give me a consensus', 'interactive');
  const messages = [
    user([{ type: 'text', text: PI_LENS }]),
    user('give me a consensus'),
  ];
  const snapshot = structuredClone(messages);
  const out = await opium.context(messages);
  assert.deepEqual(messages, snapshot);
  assert.deepEqual(texts(out[0]), [PI_LENS]);
  assert.deepEqual(texts(out[1]), [
    'give me a consensus',
    PHASE_REMINDER,
    COUNCIL_MODE_BLOCK,
  ]);
  // idempotent
  assert.deepEqual(await opium.context(out), out);
  // only the extension input was recorded, once
  await opium.input(PI_LENS, 'extension');
  assert.equal(branch.length, 1);
});

test('extension-originated skip survives a restart from the same branch', async () => {
  const branch: unknown[] = [];
  const first = setupWithBranch(branch);
  await first.input(PI_LENS, 'extension');
  const messages = [
    user([{ type: 'text', text: PI_LENS }]),
    user('plain question'),
  ];
  const before = await first.context(messages);
  const restarted = setupWithBranch(branch);
  const after = await restarted.context(messages);
  assert.deepEqual(after, before);
  assert.deepEqual(texts(after[0]), [PI_LENS]);
  assert.deepEqual(texts(after[1]), ['plain question', PHASE_REMINDER]);
});

test('unrecorded user messages are still reminded', async () => {
  const opium = setupWithBranch([]);
  const out = await opium.context([user(PI_LENS)]);
  assert.deepEqual(texts(out[0]), [
    PI_LENS,
    PHASE_REMINDER,
    COUNCIL_MODE_BLOCK,
  ]);
});
