// Model presets: named sets of per-agent overrides in opium.json.
//   { "preset": "cheap",
//     "presets": {
//       "base": { "fixer": { "model": "a/b" } },
//       "cheap": { "extends": "base", "oracle": { "thinking": "low" } } } }
// The active preset sits between the built-in fallbacks and opium.json
// `agents` (same order as oh-my-opencode-slim). Switching only
// rewrites the `preset` key; runs read overrides when they start.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  parseOverride,
  readAgentOverrides,
  type AgentOverride,
  type AgentOverrides,
} from './agents.ts';

const NAME = /^[A-Za-z0-9_-]+$/;
const RESERVED = ['__proto__', 'constructor', 'prototype'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isValidPresetName = (name: string): boolean =>
  NAME.test(name) && !RESERVED.includes(name);

const has = (record: Record<string, unknown>, key: string): boolean =>
  Object.hasOwn(record, key);

export interface ResolvedPreset {
  overrides: AgentOverrides;
  errors: string[];
}

const presetMap = (raw: Record<string, unknown>): Record<string, unknown> => {
  const presets = raw.presets;
  return isRecord(presets) ? presets : {};
};

const mergeInto = (target: AgentOverrides, source: AgentOverrides): void => {
  for (const [agent, override] of Object.entries(source)) {
    target[agent] = { ...target[agent], ...override };
  }
};

// Resolves `name` (parents first, child wins per field). Any failure in the
// chain (bad name, unknown or missing parent, cycle) applies nothing.
export const resolvePreset = (
  raw: Record<string, unknown>,
  name: string,
  path = 'opium.json',
): ResolvedPreset => {
  const errors: string[] = [];
  const presets = presetMap(raw);
  const chain: string[] = [];
  let current: string | undefined = name;
  let from = 'preset';
  while (current !== undefined) {
    if (!isValidPresetName(current)) {
      errors.push(`${path}: invalid preset name "${current}"`);
      return { overrides: {}, errors };
    }
    if (!has(presets, current)) {
      const known = Object.keys(presets).join(', ') || 'none';
      errors.push(
        `${path}: ${from} "${current}" not found (available: ${known})`,
      );
      return { overrides: {}, errors };
    }
    if (chain.includes(current)) {
      errors.push(`${path}: preset cycle: ${[...chain, current].join(' -> ')}`);
      return { overrides: {}, errors };
    }
    chain.push(current);
    const definition = presets[current];
    if (!isRecord(definition)) {
      errors.push(`${path}: preset "${current}" must be an object`);
      return { overrides: {}, errors };
    }
    const parent: unknown = definition.extends;
    if (parent !== undefined && typeof parent !== 'string') {
      errors.push(`${path}: preset "${current}": extends must be a string`);
      return { overrides: {}, errors };
    }
    from = `parent of "${current}"`;
    current = parent;
  }

  const overrides: AgentOverrides = {};
  for (const link of chain.reverse()) {
    const definition = presets[link] as Record<string, unknown>;
    const own: AgentOverrides = {};
    for (const [agent, value] of Object.entries(definition)) {
      if (agent === 'extends') continue;
      if (RESERVED.includes(agent)) {
        errors.push(`${path}: preset "${link}": bad agent name "${agent}"`);
        continue;
      }
      own[agent] = parseOverride(path, `${link}.${agent}`, value, errors);
    }
    mergeInto(overrides, own);
  }
  return { overrides, errors };
};

const readRaw = (path: string): Record<string, unknown> => {
  if (!existsSync(path)) return {};
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
};

export interface PresetInfo {
  name: string;
  parent?: string;
  active: boolean;
  // agent -> "model (thinking)" summary, inherited entries included
  agents: Record<string, string>;
}

export interface PresetList {
  presets: PresetInfo[];
  active?: string;
  errors: string[];
}

const summarize = (override: AgentOverride): string => {
  const parts = [override.model, override.thinking && `(${override.thinking})`];
  return parts.filter(Boolean).join(' ') || '(no model)';
};

export const listPresets = (path: string): PresetList => {
  const raw = readRaw(path);
  const active = typeof raw.preset === 'string' ? raw.preset : undefined;
  const errors: string[] = [];
  const presets: PresetInfo[] = [];
  for (const [name, definition] of Object.entries(presetMap(raw))) {
    const resolved = resolvePreset(raw, name, path);
    errors.push(...resolved.errors);
    const parent =
      isRecord(definition) && typeof definition.extends === 'string'
        ? definition.extends
        : undefined;
    presets.push({
      name,
      ...(parent === undefined ? {} : { parent }),
      active: name === active,
      agents: Object.fromEntries(
        Object.entries(resolved.overrides).map(([agent, o]) => [
          agent,
          summarize(o),
        ]),
      ),
    });
  }
  return { presets, ...(active === undefined ? {} : { active }), errors };
};

// Writes only the `preset` key; `undefined` removes it. Throws when the
// name is not a usable preset.
export const setActivePreset = (
  path: string,
  name: string | undefined,
): void => {
  const raw = readRaw(path);
  if (name === undefined) {
    delete raw.preset;
  } else {
    const resolved = resolvePreset(raw, name, path);
    if (resolved.errors.length > 0) {
      throw new Error(resolved.errors.join('; '));
    }
    raw.preset = name;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
};

export interface PresetReply {
  text: string;
  error: boolean;
}

const effectiveLines = (opiumPath: string): string[] => {
  const { overrides } = readAgentOverrides(opiumPath);
  return Object.entries(overrides)
    .filter(([, o]) => o.model !== undefined || o.thinking !== undefined)
    .map(([agent, o]) => `  ${agent}: ${summarize(o)}`);
};

const renderList = (opiumPath: string): string => {
  const { presets, active, errors } = listPresets(opiumPath);
  if (presets.length === 0) return 'no presets defined in opium.json';
  const lines = [`presets (active: ${active ?? 'none'}):`];
  for (const p of presets) {
    const parent = p.parent ? ` extends ${p.parent}` : '';
    lines.push(`${p.active ? '*' : '-'} ${p.name}${parent}`);
    for (const [agent, summary] of Object.entries(p.agents)) {
      lines.push(`    ${agent}: ${summary}`);
    }
  }
  const effective = effectiveLines(opiumPath);
  if (effective.length > 0) lines.push('effective overrides:', ...effective);
  for (const error of errors) lines.push(`warning: ${error}`);
  return lines.join('\n');
};

// Shared by /opium-preset and the opium_preset tool. No name lists; `off`
// clears; anything else switches.
export const applyPresetCommand = (
  opiumPath: string,
  arg: string | undefined,
): PresetReply => {
  const name = arg?.trim() ?? '';
  if (name === '') {
    return { text: renderList(opiumPath), error: false };
  }
  try {
    if (name === 'off') {
      setActivePreset(opiumPath, undefined);
      return { text: 'preset cleared; applies to new runs', error: false };
    }
    setActivePreset(opiumPath, name);
    return { text: `preset ${name} active; applies to new runs`, error: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const names = listPresets(opiumPath).presets.map((p) => p.name);
    return {
      text: `${message}\navailable presets: ${names.join(', ') || 'none'}`,
      error: true,
    };
  }
};
