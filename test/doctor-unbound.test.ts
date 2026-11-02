// Runs in its own process (node --test spawns one per file): the runner is
// never bound here, so the real doctor deps meet an unbound runner.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatDoctor, runDoctor } from '../src/doctor.ts';
import { realDoctorDeps } from '../src/doctor-env.ts';

test('the real doctor reports an unbound runner instead of throwing', async () => {
  const home = mkdtempSync(join(tmpdir(), 'opium-unbound-'));
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    const ctx = {
      cwd: home,
      model: undefined,
      modelRegistry: { find: () => undefined, hasConfiguredAuth: () => true },
    };
    const deps = realDoctorDeps(
      ctx as unknown as Parameters<typeof realDoctorDeps>[0],
      join(home, 'opium.json'),
    );
    const report = await runDoctor({ live: false }, deps);
    const runner = report.sections.find((s) => s.name === 'Runner');
    const runtime = runner?.checks.find((c) =>
      c.title.startsWith('Runner runtime'),
    );
    assert.equal(runtime?.status, 'fail');
    assert.equal(runtime?.title, 'Runner runtime: not bound');
    const mcp = report.sections.find((s) => s.name === 'MCP');
    assert.equal(mcp?.checks[0].title, 'builtin MCP could not be checked');
    assert.match(formatDoctor(report), /Runner runtime: not bound/);
  } finally {
    process.env.HOME = previous;
  }
});
