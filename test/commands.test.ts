import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerWorkflowCommands } from '../src/commands.ts';

type Handler = (args: string, ctx: unknown) => Promise<void> | void;

const setup = () => {
  const commands = new Map<string, Handler>();
  const sent: string[] = [];
  const notes: string[] = [];
  const pi = {
    registerCommand: (name: string, o: { handler: Handler }) =>
      commands.set(name, o.handler),
    sendUserMessage: (text: string) => sent.push(text),
  } as unknown as ExtensionAPI;
  registerWorkflowCommands(pi);
  const branch = Array.from({ length: 30 }, (_, i) => ({
    type: 'message',
    message:
      i % 2
        ? { role: 'toolResult', toolName: 'agent_result', content: `res-${i}` }
        : { role: 'user', content: [{ type: 'text', text: `msg-${i}` }] },
  }));
  const ctx = {
    sessionManager: {
      getSessionId: () => 'sess-1',
      getSessionFile: () => '/tmp/sess-1.jsonl',
      getBranch: () => branch,
    },
    ui: { notify: (m: string) => notes.push(m) },
  };
  return { commands, sent, notes, ctx };
};

test('registers reflect and deepwork', () => {
  const { commands } = setup();
  assert.deepEqual([...commands.keys()].sort(), ['deepwork', 'reflect']);
});

test('/reflect default uses 50, includes principles and Opium tools', async () => {
  const { commands, sent, ctx } = setup();
  await commands.get('reflect')!('', ctx);
  assert.equal(sent.length, 1);
  const text = sent[0];
  assert.match(text, /last 50 session entries/);
  assert.match(text, /change nothing is a valid result/);
  assert.match(text, /ask before changing/);
  for (const t of [
    'agent_status',
    'agent_revive',
    'council',
    'wait_for_user',
  ]) {
    assert.ok(text.includes(t), t);
  }
  assert.match(text, /agent_result: res-29/);
  assert.match(text, /\/tmp\/sess-1\.jsonl/);
});

test('/reflect --last 10 digests only 10 entries and keeps focus', async () => {
  const { commands, sent, ctx } = setup();
  await commands.get('reflect')!('--last 10 delegation habits', ctx);
  const text = sent[0];
  assert.match(text, /last 10 session entries/);
  assert.match(text, /Focus:\ndelegation habits/);
  assert.equal(text.match(/^- (user|toolResult)/gm)?.length, 10);
  assert.ok(!text.includes('msg-0'));
});

test('/reflect --last caps at 100 and ignores invalid values', async () => {
  const { commands, sent, ctx } = setup();
  await commands.get('reflect')!('--last 5000', ctx);
  assert.match(sent[0], /last 100 session entries/);
  await commands.get('reflect')!('--last abc', ctx);
  assert.match(sent[1], /last 50 session entries/);
  assert.match(sent[1], /--last abc/);
  await commands.get('reflect')!('--last 0', ctx);
  assert.match(sent[2], /last 1 session entries/);
});

test('/deepwork without a task shows usage and sends nothing', async () => {
  const { commands, sent, notes, ctx } = setup();
  await commands.get('deepwork')!('   ', ctx);
  assert.equal(sent.length, 0);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /\/deepwork <task>/);
});

test('/deepwork with a task sends one pinned-state message', async () => {
  const { commands, sent, ctx } = setup();
  await commands.get('deepwork')!('migrate the db layer', ctx);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /migrate the db layer/);
  assert.match(sent[0], /`deepwork` skill/);
  assert.ok(sent[0].includes('.opium/deepwork/sess-1.md'));
});

test('deepwork SKILL.md has valid frontmatter and no slim leftovers', () => {
  const raw = readFileSync(
    new URL('../skills/deepwork/SKILL.md', import.meta.url),
    'utf8',
  );
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(fm, 'frontmatter');
  assert.match(fm[1], /^name: deepwork$/m);
  assert.match(fm[1], /^description: .+/m);
  assert.ok(!raw.includes('.slim/'));
  assert.ok(!/@(senior|scout|council|fixer|designer|researcher)/.test(raw));
});
