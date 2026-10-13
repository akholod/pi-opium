// Path guards, ported from oh-my-opencode-slim (absolute-path-rescue and
// search-path-guard hooks) into one pre-flight tool_call handler.
//
//   - Absolute path rescue: a missing absolute `path` argument of
//     read/grep/find/ls whose tail re-anchors unambiguously onto the
//     workspace is rewritten in place. Slim rescues after an ENOENT; Pi
//     has no such hook, so existence is checked up front.
//   - Search path guard: grep/find/ls with a path that still does not
//     exist are refused before they run. read is left alone (it reports
//     its own error). ffgrep/fffind take a path *constraint* (prefix,
//     filename or glob), not a directory, so they are not guarded.
//
// Rescue runs first, then the guard, in the same handler.

/* eslint-disable max-len, consistent-return */
// max-len: the model-facing reason stays on a single line.
// consistent-return: Pi treats a bare undefined as "no change".

import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import type {
  ExtensionAPI,
  ExtensionFactory,
} from '@earendil-works/pi-coding-agent';

// Pi's read/grep/find/ls all name their argument `path`.
const PATH_ARG = 'path';
const RESCUED_TOOLS = new Set(['read', 'grep', 'find', 'ls']);
const GUARDED_TOOLS = new Set(['grep', 'find', 'ls']);

type Exists = (p: string) => boolean;

const defaultExists: Exists = (p) => {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
};

// Only ENOENT counts as absent; other stat errors keep their own meaning.
const isMissing = (p: string): boolean => {
  try {
    statSync(p);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
};

// Resolve like Pi's resolveToCwd: strip a leading `@`, expand `~`.
export const resolveToolPath = (raw: string, cwd: string): string => {
  let p = raw.startsWith('@') ? raw.slice(1) : raw;
  if (p === '~') p = homedir();
  else if (p.startsWith('~/')) p = path.join(homedir(), p.slice(2));
  return path.isAbsolute(p) ? path.resolve(p) : path.resolve(cwd, p);
};

// Re-anchor a guessed absolute path onto the workspace: the anchor is the
// longest contiguous suffix of the workspace path found in the guess; it
// must occur exactly once and its FULL tail must exist.
export const findRescuedSuffix = (
  raw: string,
  workspace: string,
  exists: Exists = defaultExists,
): string | null => {
  const root = path.resolve(workspace);
  const resolvedRaw = path.resolve(raw);
  if (resolvedRaw === root || resolvedRaw.startsWith(`${root}${path.sep}`)) {
    return null;
  }
  const guess = raw.split(path.sep).filter((s) => s.length > 0);
  if (guess.some((s) => s === '..' || s === '.')) return null;
  const rootSegments = root.split(path.sep).filter((s) => s.length > 0);

  for (let len = rootSegments.length; len >= 1; len -= 1) {
    const anchor = rootSegments.slice(rootSegments.length - len);
    const hits: number[] = [];
    for (let i = 0; i + len <= guess.length; i += 1) {
      if (anchor.every((seg, j) => guess[i + j] === seg)) hits.push(i);
    }
    if (hits.length === 0) continue;
    if (hits.length > 1) return null;
    const candidate = path.join(root, ...guess.slice(hits[0] + len));
    const inside =
      candidate === root || candidate.startsWith(`${root}${path.sep}`);
    return inside && exists(candidate) ? candidate : null;
  }
  return null;
};

export const pathGuards: ExtensionFactory = (pi: ExtensionAPI): void => {
  pi.on('tool_call', (event, ctx) => {
    const tool = event.toolName.toLowerCase();
    if (!RESCUED_TOOLS.has(tool)) return undefined;
    const input = event.input as Record<string, unknown> | undefined;
    if (!input || typeof input !== 'object') return undefined;
    const given = input[PATH_ARG];
    if (typeof given !== 'string' || given === '') return undefined;
    let raw: string = given;

    if (path.isAbsolute(raw) && isMissing(raw)) {
      const rescued = findRescuedSuffix(raw, ctx.cwd);
      if (rescued !== null) {
        input[PATH_ARG] = rescued;
        raw = rescued;
      }
    }

    if (!GUARDED_TOOLS.has(tool)) return undefined;
    const resolved = resolveToolPath(raw, ctx.cwd);
    if (!isMissing(resolved)) return undefined;
    return {
      block: true,
      reason: `Search path does not exist: ${resolved} (from "${raw}"). The ${tool} call was blocked before it ran. Check the location with ls or find from the workspace root (${ctx.cwd}) and retry with the correct path.`,
    };
  });
};
