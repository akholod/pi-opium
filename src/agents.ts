// Opium's own agent definitions: agents/*.md with YAML frontmatter, loaded
// from the user directory first, then the package. The files hold the prompt
// and structural metadata only (name, description, tools, advertise,
// contextFiles); runtime values (model, thinking, timeouts, ...) come from
// opium.json, with the built-in fallbacks below when it sets nothing.

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
  wrapUpMs?: number;
  idleTimeoutMs?: number;
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
  timeoutMs?: number;
  wrapUpMs?: number;
  idleTimeoutMs?: number;
  toolTimeoutMs?: number;
  background?: boolean;
  permissionAsks?: PermissionAsks;
  gitGuard?: boolean;
  skills?: string[];
}

export type AgentOverrides = Record<string, AgentOverride>;

// Former agent names, still accepted by the agent tools, saved run records
// and opium.json keys; they resolve to the current name and are never
// advertised.
export const LEGACY_AGENT_NAMES: Readonly<Record<string, string>> = {
  explorer: 'scout',
  librarian: 'researcher',
  oracle: 'senior',
  observer: 'vision',
};

export const resolveAgentName = (name: string): string =>
  Object.hasOwn(LEGACY_AGENT_NAMES, name)
    ? (LEGACY_AGENT_NAMES[name] ?? name)
    : name;

// Moves overrides keyed by a legacy agent name onto the current name (the
// current key wins per field) and reports each renamed key once.
export const migrateLegacyOverrides = (
  path: string,
  scope: string,
  overrides: AgentOverrides,
  errors: string[],
): AgentOverrides => {
  const out: AgentOverrides = {};
  const legacy: [string, string, AgentOverride][] = [];
  for (const [name, override] of Object.entries(overrides)) {
    const current = resolveAgentName(name);
    if (current === name) out[name] = { ...out[name], ...override };
    else legacy.push([name, current, override]);
  }
  for (const [name, current, override] of legacy) {
    errors.push(
      `${path}: ${scope}agent "${name}" was renamed to "${current}"; ` +
        'rename the key',
    );
    out[current] = { ...override, ...out[current] };
  }
  return out;
};

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
  'tools',
  'advertise',
  'contextFiles',
  'inheritProjectContext',
  // legacy pi-subagents fields: validated, not used
  'acceptanceRole',
  'defaultContext',
]);

// Runtime values that live in opium.json `agents.<name>`, not in the .md.
// The legacy `async` was the old name of `background`.
const OPIUM_JSON_KEYS: Record<string, string> = {
  model: 'model',
  fallbackModels: 'fallbackModels',
  thinking: 'thinking',
  timeoutMs: 'timeoutMs',
  wrapUpMs: 'wrapUpMs',
  idleTimeoutMs: 'idleTimeoutMs',
  toolTimeoutMs: 'toolTimeoutMs',
  background: 'background',
  async: 'background',
  permissionAsks: 'permissionAsks',
  gitGuard: 'gitGuard',
  skills: 'skills',
};

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
    const target = OPIUM_JSON_KEYS[key];
    if (target !== undefined) {
      throw new Error(
        `field "${key}" is not allowed in agent .md files; set ` +
          `"${target}" in opium.json under agents.${name}`,
      );
    }
    if (!KNOWN_KEYS.has(key)) throw new Error(`unknown field "${key}"`);
  }
  if (fm.name !== undefined && fm.name !== name) {
    throw new Error(`name "${String(fm.name)}" must equal the file name`);
  }
  if (typeof fm.description !== 'string' || !fm.description.trim()) {
    throw new Error('description is required');
  }
  exclusive(fm, 'contextFiles', 'inheritProjectContext');

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

  const contextFiles = fm.contextFiles ?? fm.inheritProjectContext;
  const agent: AgentDefinition = {
    name,
    description: fm.description.trim(),
    prompt: body.trim(),
    fallbackModels: [],
    models: computeModels(undefined, []),
    mcpServers,
    packages,
    skills: [],
    background: false,
    advertise: optionalBoolean('advertise', fm.advertise, false),
    contextFiles: optionalBoolean(
      fm.contextFiles === undefined ? 'inheritProjectContext' : 'contextFiles',
      contextFiles,
      false,
    ),
    permissionAsks: 'forward',
    gitGuard: true,
    file,
  };
  if (tools !== undefined) agent.tools = tools;
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
  if (override.timeoutMs !== undefined) merged.timeoutMs = override.timeoutMs;
  if (override.wrapUpMs !== undefined) merged.wrapUpMs = override.wrapUpMs;
  if (override.idleTimeoutMs !== undefined) {
    merged.idleTimeoutMs = override.idleTimeoutMs;
  }
  if (override.toolTimeoutMs !== undefined) {
    merged.toolTimeoutMs = override.toolTimeoutMs;
  }
  if (override.background !== undefined) {
    merged.background = override.background;
  }
  if (override.permissionAsks !== undefined) {
    merged.permissionAsks = override.permissionAsks;
  }
  if (override.gitGuard !== undefined) merged.gitGuard = override.gitGuard;
  if (override.skills !== undefined) merged.skills = [...override.skills];
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

const OVERRIDE_KEYS = [
  'model',
  'fallbackModels',
  'thinking',
  'timeoutMs',
  'wrapUpMs',
  'idleTimeoutMs',
  'toolTimeoutMs',
  'background',
  'permissionAsks',
  'gitGuard',
  'skills',
];

export const parseOverride = (
  path: string,
  agent: string,
  value: unknown,
  errors: string[],
): AgentOverride => {
  const out: AgentOverride = {};
  if (!isRecord(value)) {
    errors.push(`${path}: override for "${agent}" must be an object`);
    return out;
  }
  const fail = (message: string) =>
    errors.push(`${path}: override for "${agent}": ${message}`);
  for (const [key, field] of Object.entries(value)) {
    if (!OVERRIDE_KEYS.includes(key)) {
      fail(`unknown field "${key}"`);
      continue;
    }
    try {
      if (key === 'model') {
        out.model = parseModelId('model', field);
      } else if (key === 'thinking') {
        out.thinking = parseEnum('thinking', field, LEVELS);
      } else if (key === 'fallbackModels') {
        out.fallbackModels = parseList('fallbackModels', field).map((entry) =>
          parseModelId('fallbackModels entry', entry),
        );
      } else if (
        key === 'timeoutMs' ||
        key === 'wrapUpMs' ||
        key === 'idleTimeoutMs' ||
        key === 'toolTimeoutMs'
      ) {
        out[key] = parsePositive(key, field);
      } else if (key === 'background' || key === 'gitGuard') {
        out[key] = parseBoolean(key, field);
      } else if (key === 'permissionAsks') {
        out.permissionAsks = parseEnum<PermissionAsks>(
          'permissionAsks',
          field,
          ['forward', 'deny'],
        );
      } else {
        out.skills = parseList('skills', field);
      }
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
  return out;
};

// Per field, lowest to highest: the built-in fallbacks < the active
// opium.json preset < opium.json `agents`. This returns the last two.
export const readAgentOverrides = (opiumPath: string): ReadOverrides => {
  const errors: string[] = [];
  const overrides: AgentOverrides = {};

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
      const own: AgentOverrides = {};
      for (const [agent, value] of Object.entries(fromOpium)) {
        own[agent] = parseOverride(opiumPath, agent, value, errors);
      }
      const current = migrateLegacyOverrides(opiumPath, '', own, errors);
      for (const [agent, value] of Object.entries(current)) {
        overrides[agent] = { ...overrides[agent], ...value };
      }
    } else {
      errors.push(`${opiumPath}: agents must be an object`);
    }
  }
  return { overrides, errors };
};
