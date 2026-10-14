// Concrete direct-tool names pi-mcp-adapter registers for MCP servers, so an
// agent's `mcp:<server>` entry can become an exact tool allowlist. Mirrors
// pi-mcp-adapter: types.ts (getServerPrefix, formatToolName,
// resolveToolPrefix), direct-tool-surface.ts (resolveDirectTools).

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

export type ToolPrefix = 'server' | 'none' | 'short' | 'mcp';

const PREFIXES: readonly string[] = ['server', 'none', 'short', 'mcp'];

export interface McpToolOptions {
  // default ~/.config/mcp/mcp.json
  configPath?: string;
  // default <agent dir>/mcp-cache.json
  cachePath?: string;
}

export interface McpTools {
  tools: string[];
  errors: string[];
}

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readJson = (path: string): Json => {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid JSON: ${message}`, { cause: error });
  }
  if (!isRecord(value)) throw new Error('not a JSON object');
  return value;
};

// types.ts sanitizeServerPrefix: keep [A-Za-z0-9_-], escape the rest as _hex_
const sanitize = (name: string): string =>
  Array.from(name, (char) =>
    /^[A-Za-z0-9_-]$/.test(char)
      ? char
      : `_${char.codePointAt(0)?.toString(16)}_`,
  ).join('');

// types.ts getServerPrefix
export const serverPrefix = (name: string, mode: ToolPrefix): string => {
  if (mode === 'none') return '';
  if (mode === 'short') return sanitize(name.replace(/-?mcp$/i, '')) || 'mcp';
  if (mode === 'mcp') return `mcp__${sanitize(name)}`;
  return sanitize(name);
};

// types.ts formatToolName
export const formatToolName = (
  tool: string,
  server: string,
  mode: ToolPrefix,
): string => {
  const prefix = serverPrefix(server, mode);
  const name = tool.replace(/\./g, '_');
  const owned = prefix && name.startsWith(`${prefix}_`);
  if (owned && name.length > prefix.length + 1) return name;
  return prefix ? `${prefix}_${name}` : name;
};

export const resolveMcpTools = (
  servers: readonly string[],
  options: McpToolOptions = {},
): McpTools => {
  const configPath =
    options.configPath ?? join(homedir(), '.config', 'mcp', 'mcp.json');
  const cachePath = options.cachePath ?? join(getAgentDir(), 'mcp-cache.json');
  const tools: string[] = [];
  const errors: string[] = [];
  if (servers.length === 0) return { tools, errors };

  const read = (path: string, what: string): Json | string => {
    try {
      if (!existsSync(path)) throw new Error('file not found');
      return readJson(path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `${path}: cannot read ${what}: ${message}`;
    }
  };
  // MCP is optional: without a config, or without the server in it, the
  // agent simply works without those tools
  if (!existsSync(configPath)) return { tools, errors };
  const config = read(configPath, 'MCP config');
  if (typeof config === 'string') return { tools, errors: [config] };
  const cache = read(cachePath, 'MCP metadata cache');
  if (typeof cache === 'string') return { tools, errors: [cache] };

  const settings = isRecord(config.settings) ? config.settings : {};
  const defs = isRecord(config.mcpServers) ? config.mcpServers : {};
  const cached = isRecord(cache.servers) ? cache.servers : {};
  for (const server of servers) {
    const def = defs[server];
    if (!isRecord(def)) continue;
    if (def.disabled === true) {
      errors.push(`${configPath}: MCP server "${server}" is disabled`);
      continue;
    }
    // per-server directTools overrides settings.directTools
    const selected =
      def.directTools !== undefined ? def.directTools : settings.directTools;
    if (selected === undefined || selected === false) {
      errors.push(
        `${configPath}: MCP server "${server}" has no direct tools ` +
          '(set directTools)',
      );
      continue;
    }
    const entry = cached[server];
    if (!isRecord(entry) || !Array.isArray(entry.tools)) {
      errors.push(
        `${cachePath}: MCP server "${server}" is not in the metadata ` +
          'cache (connect it once)',
      );
      continue;
    }
    const prefixValue = def.toolPrefix ?? settings.toolPrefix ?? 'server';
    if (typeof prefixValue !== 'string' || !PREFIXES.includes(prefixValue)) {
      errors.push(
        `${configPath}: MCP server "${server}" has invalid toolPrefix`,
      );
      continue;
    }
    const prefix = prefixValue as ToolPrefix;
    // directTools: true | "search" (lazy, still real tools) | string[] filter
    const filter: unknown = Array.isArray(selected) ? selected : undefined;
    const before = tools.length;
    for (const tool of entry.tools) {
      if (!isRecord(tool) || typeof tool.name !== 'string') continue;
      if (Array.isArray(filter) && !filter.includes(tool.name)) continue;
      // tools marked app-only are not exposed to the model
      const { uiVisibility } = tool;
      if (Array.isArray(uiVisibility) && !uiVisibility.includes('model')) {
        continue;
      }
      const name = formatToolName(tool.name, server, prefix);
      if (!tools.includes(name)) tools.push(name);
    }
    if (tools.length === before) {
      errors.push(`MCP server "${server}" exposes no direct tools`);
    }
  }
  return { tools, errors };
};
