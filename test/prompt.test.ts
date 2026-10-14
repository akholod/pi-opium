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

test('deepwork skill orders phases by fidelity and defers polish', () => {
  const skill = readFileSync(
    new URL('../skills/deepwork/SKILL.md', import.meta.url),
    'utf8',
  );
  assert.match(skill, /Value productivity/);
  assert.match(skill, /order phases by fidelity/);
  assert.match(skill, /broad validation once/);
});
