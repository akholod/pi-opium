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
  const [result] = await run([user('hello')]);
  assert.deepEqual(texts(result.messages![0]), ['hello', PHASE_REMINDER]);
});

test('context handler does nothing when orchestrator is off', async () => {
  const run = setup(false);
  const [result] = await run([user('hello')]);
  assert.equal(result.messages, undefined);
});
