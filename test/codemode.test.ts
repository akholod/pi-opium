import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultCodemodeWorkers,
  effectiveCodemodeWorkers,
} from '../src/codemode.ts';

test('an unset limit is raised to 6', () => {
  const env: Record<string, string | undefined> = {};
  assert.equal(defaultCodemodeWorkers(env), true);
  assert.equal(env.PI_CODEMODE_MAX_WORKERS, '6');
});

test("the user's value is never changed", () => {
  for (const value of ['2', '12', '', 'abc']) {
    const env: Record<string, string | undefined> = {
      PI_CODEMODE_MAX_WORKERS: value,
    };
    assert.equal(defaultCodemodeWorkers(env), false);
    assert.equal(env.PI_CODEMODE_MAX_WORKERS, value);
  }
});

test('the effective limit follows the host rule', () => {
  const limit = (value?: string) =>
    effectiveCodemodeWorkers({ PI_CODEMODE_MAX_WORKERS: value });
  assert.equal(limit(undefined), 2);
  assert.equal(limit('6'), 6);
  assert.equal(limit('0'), 2);
  assert.equal(limit('-1'), 2);
  assert.equal(limit('1.5'), 2);
  assert.equal(limit('abc'), 2);
});
