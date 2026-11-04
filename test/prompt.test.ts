import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildOrchestratorPrompt } from '../src/prompt.ts';

test('orchestrator prompt weighs delegation cost and values productivity', () => {
  const prompt = buildOrchestratorPrompt();
  assert.match(prompt, /Delegation is not free/);
  assert.match(prompt, /Value productivity/);
  assert.match(prompt, /Build like a painter/);
  assert.match(prompt, /Stop when the request is met/);
  assert.doesNotMatch(prompt, /one isolated, clear, low-risk action/);
  assert.doesNotMatch(prompt, /Choose the path that optimizes/);
  // designer routing stays absolute
  assert.match(prompt, /Never handle UI\/design work directly/);
});

test('roster lists reviewer and tester; senior is not a code reviewer', () => {
  const prompt = buildOrchestratorPrompt();
  assert.match(prompt, /^reviewer$/m);
  assert.match(prompt, /^tester$/m);
  const senior = prompt.match(/^senior\n[\s\S]*?(?=\n\n)/m)?.[0] ?? '';
  assert.ok(senior.length > 0);
  assert.doesNotMatch(senior, /code reviewer/i);
});

test('custom agents are listed after the built-ins', () => {
  const prompt = buildOrchestratorPrompt({
    available: ['scout', 'linter'],
    custom: [{ name: 'linter', description: '  Reviews diffs.\n' }],
  });
  assert.match(prompt, /\n\nlinter\nReviews diffs\.\n\n<\/Agents>/);
  assert.ok(prompt.indexOf('\nscout\n') < prompt.indexOf('\nlinter\n'));
});

test('a custom agent named like a built-in is not duplicated', () => {
  const prompt = buildOrchestratorPrompt({
    available: ['scout'],
    custom: [{ name: 'scout', description: 'Impostor.' }],
  });
  assert.doesNotMatch(prompt, /Impostor/);
  assert.equal(prompt.match(/^scout$/gm)?.length, 1);
});

test('a custom agent that is not available is left out', () => {
  const prompt = buildOrchestratorPrompt({
    available: ['scout'],
    custom: [{ name: 'linter', description: 'Reviews diffs.' }],
  });
  assert.doesNotMatch(prompt, /Reviews diffs/);
});

test('deepwork skill orders phases by fidelity and defers polish', () => {
  const skill = readFileSync(
    new URL('../skills/deepwork/SKILL.md', import.meta.url),
    'utf8',
  );
  assert.match(skill, /Value productivity/);
  assert.match(skill, /order phases by fidelity/);
  assert.match(skill, /broad validation once/);
});
