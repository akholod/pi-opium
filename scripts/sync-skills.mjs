// Refresh the vendored skills from the mtga project (single source of truth).
// Usage: node scripts/sync-skills.mjs [path-to-mtga]   (default: ../mtga)

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILLS = ['write-tests', 'review-tests'];

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, process.argv[2] ?? '../mtga');
const target = join(root, 'skills');

const missing = SKILLS.map((name) =>
  join(source, 'skills', name, 'SKILL.md'),
).filter((file) => !existsSync(file));
if (missing.length > 0) {
  console.error('sync-skills: source skill files not found:');
  for (const file of missing) console.error(`  ${file}`);
  console.error('Pass the mtga checkout as the first argument.');
  process.exit(1);
}

mkdirSync(target, { recursive: true });
for (const name of SKILLS) {
  const from = join(source, 'skills', name);
  const to = join(target, name);
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
  console.log(`copied ${from} -> ${to}`);
}
