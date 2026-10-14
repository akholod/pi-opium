// Turns an AgentDefinition into runner options: system prompt with its
// skills inlined, tool allowlist (plus MCP tool names), extensions, limits.

import { readFileSync } from 'node:fs';
import {
  DefaultPackageManager,
  type ExtensionFactory,
  SettingsManager,
  getAgentDir,
  loadSkills,
  stripFrontmatter,
} from '@earendil-works/pi-coding-agent';
import { builtinMcpDisabled, builtinMcpServers } from 'pi-agent-runner';
import type {
  ParentContext,
  StartAgentOptions,
  TurnOptions,
} from 'pi-agent-runner';
import type { AgentDefinition } from './agents.ts';
import { sessionGuards } from './guards.ts';
import { resolveMcpTools } from './mcp.ts';
import {
  VISION_DISPATCH_LINE,
  VISION_DISPATCH_ROLES,
  VISION_TOOL,
} from './vision.ts';

export interface ResolvedSkill {
  path: string;
  content: string;
}

export interface LaunchContext {
  parent: ParentContext;
  cwd: string;
  resolveMcp?: typeof resolveMcpTools;
  builtinMcpServers?: typeof builtinMcpServers;
  builtinMcpDisabled?: typeof builtinMcpDisabled;
  resolveSkill?: (name: string, cwd: string) => ResolvedSkill | undefined;
  // Set when the vision agent is callable. The child gets a `vision` tool
  // (and a line telling it to use it) only when it is one of
  // VISION_DISPATCH_ROLES and its own model cannot see images; unknown
  // counts as "cannot see".
  vision?: {
    childSeesImages: boolean | undefined;
    tool: (child: string) => ExtensionFactory;
  };
}

export interface Launch {
  start: Omit<StartAgentOptions, 'transcriptPath' | 'resumeFrom' | 'signal'>;
  turn: Pick<
    TurnOptions,
    'timeoutMs' | 'wrapUpMs' | 'idleTimeoutMs' | 'toolTimeoutMs'
  >;
  warnings: string[];
}

// The skills a `pi` session in cwd would see: Pi's package manager resolves
// every source (~/.pi/agent/skills, ~/.agents/skills, project dirs,
// packages); loadSkills alone covers only the first and .pi/skills.
export const discoverSkills = async (
  cwd: string,
): Promise<Map<string, string>> => {
  const agentDir = getAgentDir();
  const manager = new DefaultPackageManager({
    cwd,
    agentDir,
    settingsManager: SettingsManager.create(cwd, agentDir),
  });
  const resolved = await manager.resolve();
  const { skills } = loadSkills({
    cwd,
    agentDir,
    skillPaths: resolved.skills.filter((s) => s.enabled).map((s) => s.path),
    includeDefaults: false,
  });
  return new Map(skills.map((skill) => [skill.name, skill.filePath]));
};

export const skillResolver =
  (files: Map<string, string>): NonNullable<LaunchContext['resolveSkill']> =>
  (name) => {
    const path = files.get(name);
    let resolved: ResolvedSkill | undefined;
    if (path) {
      try {
        resolved = {
          path,
          content: stripFrontmatter(readFileSync(path, 'utf8')),
        };
      } catch {
        // unreadable: reported as not found
      }
    }
    return resolved;
  };

export const buildLaunch = (
  def: AgentDefinition,
  ctx: LaunchContext,
): Launch => {
  const warnings: string[] = [];
  const resolveSkill = ctx.resolveSkill ?? (() => undefined);
  const resolveMcp = ctx.resolveMcp ?? resolveMcpTools;
  const listBuiltin = ctx.builtinMcpServers ?? builtinMcpServers;
  const isBuiltinDisabled = ctx.builtinMcpDisabled ?? builtinMcpDisabled;

  const vision =
    ctx.vision?.childSeesImages !== true &&
    VISION_DISPATCH_ROLES.includes(def.name)
      ? ctx.vision
      : undefined;

  let systemPrompt = def.prompt;
  for (const name of def.skills) {
    const skill = resolveSkill(name, ctx.cwd);
    if (!skill) {
      warnings.push(`skill ${name} not found`);
      continue;
    }
    const body = skill.content.trim();
    systemPrompt += `\n\n<skill name="${name}">\n${body}\n</skill>`;
  }

  // Per server: Pi's built-in MCP when it has the server, else the
  // pi-mcp-adapter when it is configured there, else the server is skipped.
  const packages = [...def.packages];
  const builtin: string[] = [];
  const viaAdapter: string[] = [];
  if (def.mcpServers.length) {
    const known = new Set<string>();
    if (!isBuiltinDisabled(ctx.cwd)) {
      for (const server of listBuiltin(ctx.cwd)) {
        if (server.enabled) known.add(server.name);
      }
    }
    for (const server of def.mcpServers) {
      (known.has(server) ? builtin : viaAdapter).push(server);
    }
  }

  let tools: string[] | undefined;
  if (def.tools !== undefined) {
    tools = [...def.tools];
    if (viaAdapter.length) {
      try {
        const mcp = resolveMcp(viaAdapter);
        warnings.push(...mcp.errors);
        for (const tool of mcp.tools) {
          if (!tools.includes(tool)) tools.push(tool);
        }
        if (mcp.tools.length && !packages.includes('pi-mcp-adapter')) {
          packages.unshift('pi-mcp-adapter');
        }
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : String(error));
      }
    }
  }

  if (vision) {
    systemPrompt += `\n\n${VISION_DISPATCH_LINE}`;
    if (tools !== undefined && !tools.includes(VISION_TOOL)) {
      tools.push(VISION_TOOL);
    }
  }

  const start: Launch['start'] = {
    parent: ctx.parent,
    cwd: ctx.cwd,
    label: { name: def.name, context: 'opium' },
    systemPrompt,
    model: def.models[0],
    extensions: packages.length ? { packages } : 'none',
    noContextFiles: !def.contextFiles,
    noSkills: true,
    permissionAsks: def.permissionAsks,
    gitGuard: def.gitGuard,
    // path, loop and JSON error guards in every child, as in slim
    extensionFactories: vision
      ? [...sessionGuards, vision.tool(def.name)]
      : sessionGuards,
  };
  if (builtin.length) start.mcpServers = builtin;
  if (tools !== undefined) start.tools = tools;
  if (def.thinking !== undefined) start.thinking = def.thinking;

  const turn: Launch['turn'] = {};
  if (def.timeoutMs !== undefined) turn.timeoutMs = def.timeoutMs;
  if (def.wrapUpMs !== undefined) turn.wrapUpMs = def.wrapUpMs;
  if (def.idleTimeoutMs !== undefined) turn.idleTimeoutMs = def.idleTimeoutMs;
  if (def.toolTimeoutMs !== undefined) turn.toolTimeoutMs = def.toolTimeoutMs;
  return { start, turn, warnings };
};
