// Opium's own agent definitions: agents/*.md with YAML frontmatter, loaded
// from the user directory first, then the package. The files still use the
// pi-subagents field names (until they are migrated), so the loader maps
// legacy names to the Opium ones.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAgentDir, parseFrontmatter } from '@earendil-works/pi-coding-agent';
import type { ThinkingLevel } from 'pi-agent-runner';
import { resolvePreset } from './presets.ts';

export type PermissionAsks = 'forward' | 'deny';

export interface AgentDefinition {
  name: string;
  description: string;
  // system prompt (body, trimmed)
  prompt: string;
  model?: string;
  fallbackModels: string[];
  // requested models in order: [model ?? 'inherit', ...fallbackModels], deduped
  models: string[];
  thinking?: ThinkingLevel;
  // plain tool names; undefined = Pi's default tools; [] = no tools
  tools?: string[];
  // servers named by `mcp:<server>` entries in tools
  mcpServers: string[];
  // extension packages the agent needs
  packages: string[];
  skills: string[];
  timeoutMs?: number;
  toolTimeoutMs?: number;
  background: boolean;
  advertise: boolean;
  contextFiles: boolean;
  permissionAsks: PermissionAsks;
  gitGuard: boolean;
  // path the definition was loaded from
  file: string;
}

export interface AgentOverride {
  model?: string;
  thinking?: ThinkingLevel;
  fallbackModels?: string[];
}

export type AgentOverrides = Record<string, AgentOverride>;

export interface LoadAgentOptions {
  dirs?: readonly string[];
  overrides?: AgentOverrides;
}

const LEVELS: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

export const THINKING_LEVELS: readonly string[] = LEVELS;

const WEB_TOOLS = [
  'web_search',
  'fetch_content',
  'get_search_content',
  'source_check',
];

const KNOWN_KEYS = new Set([
  'name',
  'description',
  'model',
  'fallbackModels',
  'thinking',
  'tools',
  'skills',
  'timeoutMs',
  'toolTimeoutMs',
  'background',
  'async',
  'advertise',
  'contextFiles',
  'inheritProjectContext',
  'permissionAsks',
  'gitGuard',
  // legacy pi-subagents fields: validated, not used
  'acceptanceRole',
  'defaultContext',
]);

const PACKAGE_AGENTS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'agents',
);

// Directories searched in order: the user override, then the package.
export const defaultAgentDirs = (): string[] => [
  join(getAgentDir(), 'agents'),
  PACKAGE_AGENTS_DIR,
];

export const isModelId = (value: string): boolean => {
  const slash = value.indexOf('/');
  return slash > 0 && slash < value.length - 1;
};

export const parseThinking = (value: unknown): ThinkingLevel | undefined =>
  typeof value === 'string' && THINKING_LEVELS.includes(value)
    ? (value as ThinkingLevel)
    : undefined;

export const computeModels = (
  model: string | undefined,
  fallbackModels: readonly string[],
): string[] => [...new Set([model ?? 'inherit', ...fallbackModels])];

// ---- field parsers; each throws a message without the file prefix ----

const parseBoolean = (key: string, value: unknown): boolean => {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${key} must be true or false`);
};

const optionalBoolean = (
  key: string,
  value: unknown,
  fallback: boolean,
): boolean => (value === undefined ? fallback : parseBoolean(key, value));

const parsePositive = (key: string, value: unknown): number => {
  const n =
    typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
    throw new Error(`${key} must be a positive number`);
  }
  return n;
};

// YAML list or comma-separated string; null/empty -> []
const parseList = (key: string, value: unknown): string[] => {
  if (value === null || value === undefined) return [];
  let entries: unknown[];
  if (typeof value === 'string') entries = value.split(',');
  else if (Array.isArray(value)) entries = value;
  else throw new Error(`${key} must be a comma-separated string or a list`);
  const out: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'string') {
      throw new Error(`${key} entries must be strings`);
    }
    const item = entry.trim();
    if (item) out.push(item);
  }
  return out;
};

const parseModelId = (key: string, value: unknown): string => {
  if (typeof value !== 'string' || !isModelId(value.trim())) {
    throw new Error(`${key} must look like provider/id`);
  }
  return value.trim();
};

const parseEnum = <T extends string>(
  key: string,
  value: unknown,
  allowed: readonly T[],
): T => {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${key} must be one of ${allowed.join('|')}`);
  }
  return value as T;
};

const exclusive = (
  fm: Record<string, unknown>,
  current: string,
  legacy: string,
): void => {
  if (fm[current] !== undefined && fm[legacy] !== undefined) {
    throw new Error(`${current} and legacy ${legacy} are both set; use one`);
  }
};

const parseDefinition = (
  name: string,
  file: string,
  raw: string,
): AgentDefinition => {
  const { frontmatter: fm, body } =
    parseFrontmatter<Record<string, unknown>>(raw);
  for (const key of Object.keys(fm)) {
    if (!KNOWN_KEYS.has(key)) throw new Error(`unknown field "${key}"`);
  }
  if (fm.name !== undefined && fm.name !== name) {
    throw new Error(`name "${String(fm.name)}" must equal the file name`);
  }
  if (typeof fm.description !== 'string' || !fm.description.trim()) {
    throw new Error('description is required');
  }
  exclusive(fm, 'background', 'async');
  exclusive(fm, 'contextFiles', 'inheritProjectContext');

  const fallbackModels = parseList('fallbackModels', fm.fallbackModels).map(
    (entry) => parseModelId('fallbackModels entry', entry),
  );
  const model =
    fm.model === undefined ? undefined : parseModelId('model', fm.model);

  let tools: string[] | undefined;
  const mcpServers: string[] = [];
  if ('tools' in fm) {
    tools = [];
    for (const entry of parseList('tools', fm.tools)) {
      if (entry.startsWith('mcp:')) {
        const server = entry.slice(4).trim();
        if (!server) throw new Error('tools entry "mcp:" needs a server name');
        if (!mcpServers.includes(server)) mcpServers.push(server);
      } else {
        tools.push(entry);
      }
    }
  }
  const packages: string[] = [];
  if (mcpServers.length) packages.push('pi-mcp-adapter');
  if (tools?.some((tool) => WEB_TOOLS.includes(tool))) {
    packages.push('pi-web-access');
  }

  const background = fm.background ?? fm.async;
  const contextFiles = fm.contextFiles ?? fm.inheritProjectContext;
  const agent: AgentDefinition = {
    name,
    description: fm.description.trim(),
    prompt: body.trim(),
    fallbackModels,
    models: computeModels(model, fallbackModels),
    mcpServers,
    packages,
    skills: parseList('skills', fm.skills),
    background: optionalBoolean(
      fm.background === undefined ? 'async' : 'background',
      background,
      false,
    ),
    advertise: optionalBoolean('advertise', fm.advertise, false),
    contextFiles: optionalBoolean(
      fm.contextFiles === undefined ? 'inheritProjectContext' : 'contextFiles',
      contextFiles,
      false,
    ),
    permissionAsks:
      fm.permissionAsks === undefined
        ? 'forward'
        : parseEnum('permissionAsks', fm.permissionAsks, ['forward', 'deny']),
    gitGuard: optionalBoolean('gitGuard', fm.gitGuard, true),
    file,
  };
  if (model !== undefined) agent.model = model;
  if (tools !== undefined) agent.tools = tools;
  if (fm.thinking !== undefined) {
    agent.thinking = parseEnum('thinking', fm.thinking, LEVELS);
  }
  if (fm.timeoutMs !== undefined) {
    agent.timeoutMs = parsePositive('timeoutMs', fm.timeoutMs);
  }
  if (fm.toolTimeoutMs !== undefined) {
    agent.toolTimeoutMs = parsePositive('toolTimeoutMs', fm.toolTimeoutMs);
  }
  if (fm.acceptanceRole !== undefined) {
    parseEnum('acceptanceRole', fm.acceptanceRole, ['read-only', 'writer']);
  }
  if (fm.defaultContext !== undefined) {
    // fork is not supported by Opium; treated as fresh
    parseEnum('defaultContext', fm.defaultContext, ['fresh', 'fork']);
  }
  return agent;
};

const withOverride = (
  agent: AgentDefinition,
  override: AgentOverride | undefined,
): AgentDefinition => {
  if (!override) return agent;
  const merged = { ...agent };
  if (override.model !== undefined) merged.model = override.model;
  if (override.thinking !== undefined) merged.thinking = override.thinking;
  if (override.fallbackModels !== undefined) {
    merged.fallbackModels = [...override.fallbackModels];
  }
  merged.models = computeModels(merged.model, merged.fallbackModels);
  return merged;
};

const loadFile = (
  name: string,
  file: string,
  overrides: AgentOverrides | undefined,
): AgentDefinition => {
  try {
    const agent = parseDefinition(name, file, readFileSync(file, 'utf8'));
    return withOverride(agent, overrides?.[name]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${file}: ${message}`, { cause: error });
  }
};

export const loadAgent = (
  name: string,
  options: LoadAgentOptions = {},
): AgentDefinition => {
  const dirs = options.dirs ?? defaultAgentDirs();
  for (const dir of dirs) {
    const file = join(dir, `${name}.md`);
    if (existsSync(file)) return loadFile(name, file, options.overrides);
  }
  throw new Error(`agent file ${name}.md not found in ${dirs.join(', ')}`);
};

export interface LoadedAgents {
  agents: Map<string, AgentDefinition>;
  errors: string[];
}

export const loadAgents = (options: LoadAgentOptions = {}): LoadedAgents => {
  const dirs = options.dirs ?? defaultAgentDirs();
  const agents = new Map<string, AgentDefinition>();
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    let files: string[];
    try {
      files = readdirSync(dir)
        .filter((f) => f.endsWith('.md'))
        .sort();
    } catch {
      continue;
    }
    for (const file of files) {
      const name = file.slice(0, -3);
      // the first directory wins, even when its file is invalid
      if (seen.has(name)) continue;
      seen.add(name);
      try {
        agents.set(name, loadFile(name, join(dir, file), options.overrides));
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }
  return { agents, errors };
};

// ---- overrides ----

export interface ReadOverrides {
  overrides: AgentOverrides;
  errors: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readJson = (
  path: string,
  errors: string[],
): Record<string, unknown> | undefined => {
  let result: Record<string, unknown> | undefined;
  if (!existsSync(path)) return result;
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (isRecord(value)) result = value;
    else errors.push(`${path}: must contain a JSON object`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`${path}: invalid JSON: ${message}`);
  }
  return result;
};

export const parseOverride = (
  path: string,
  agent: string,
  value: unknown,
  allowFallbacks: boolean,
  errors: string[],
): AgentOverride => {
  const out: AgentOverride = {};
  if (!isRecord(value)) {
    errors.push(`${path}: override for "${agent}" must be an object`);
    return out;
  }
  const fail = (message: string) =>
    errors.push(`${path}: override for "${agent}": ${message}`);
  const allowed = allowFallbacks
    ? ['model', 'thinking', 'fallbackModels']
    : ['model', 'thinking'];
  for (const [key, field] of Object.entries(value)) {
    if (!allowed.includes(key)) {
      // settings.json carries more pi-subagents fields; opium.json is strict
      if (allowFallbacks) fail(`unknown field "${key}"`);
      continue;
    }
    try {
      if (key === 'model') {
        out.model = parseModelId('model', field);
      } else if (key === 'thinking') {
        out.thinking = parseEnum('thinking', field, LEVELS);
      } else {
        out.fallbackModels = parseList('fallbackModels', field).map((entry) =>
          parseModelId('fallbackModels entry', entry),
        );
      }
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
  return out;
};

// Per field, lowest to highest: settings.json `subagents.agentOverrides`
// (model and thinking only) < the active opium.json preset < opium.json
// `agents`.
export const readAgentOverrides = (
  opiumPath: string,
  settingsPath: string,
): ReadOverrides => {
  const errors: string[] = [];
  const overrides: AgentOverrides = {};

  const settings = readJson(settingsPath, errors);
  const subagents = settings?.subagents;
  const fromSettings = isRecord(subagents)
    ? subagents.agentOverrides
    : undefined;
  if (fromSettings !== undefined) {
    if (isRecord(fromSettings)) {
      for (const [agent, value] of Object.entries(fromSettings)) {
        overrides[agent] = parseOverride(
          settingsPath,
          agent,
          value,
          false,
          errors,
        );
      }
    } else {
      errors.push(
        `${settingsPath}: subagents.agentOverrides must be an object`,
      );
    }
  }

  const opium = readJson(opiumPath, errors);
  if (opium?.preset !== undefined) {
    if (typeof opium.preset === 'string') {
      const resolved = resolvePreset(opium, opium.preset, opiumPath);
      errors.push(...resolved.errors);
      for (const [agent, value] of Object.entries(resolved.overrides)) {
        overrides[agent] = { ...overrides[agent], ...value };
      }
    } else {
      errors.push(`${opiumPath}: preset must be a string`);
    }
  }
  const fromOpium = opium?.agents;
  if (fromOpium !== undefined) {
    if (isRecord(fromOpium)) {
      for (const [agent, value] of Object.entries(fromOpium)) {
        overrides[agent] = {
          ...overrides[agent],
          ...parseOverride(opiumPath, agent, value, true, errors),
        };
      }
    } else {
      errors.push(`${opiumPath}: agents must be an object`);
    }
  }
  return { overrides, errors };
};
