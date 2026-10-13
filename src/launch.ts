// Turns an AgentDefinition into runner options: system prompt with its
// skills inlined, tool allowlist (plus MCP tool names), extensions, limits.

import { readFileSync } from 'node:fs';
import {
  DefaultPackageManager,
  SettingsManager,
  getAgentDir,
  loadSkills,
  stripFrontmatter,
} from '@earendil-works/pi-coding-agent';
import type {
  ParentContext,
  StartAgentOptions,
  TurnOptions,
} from 'pi-agent-runner';
import type { AgentDefinition } from './agents.ts';
import { sessionGuards } from './guards.ts';
import { resolveMcpTools } from './mcp.ts';

export interface ResolvedSkill {
  path: string;
  content: string;
}

export interface LaunchContext {
  parent: ParentContext;
  cwd: string;
  resolveMcp?: typeof resolveMcpTools;
  resolveSkill?: (name: string, cwd: string) => ResolvedSkill | undefined;
}

export interface Launch {
  start: Omit<StartAgentOptions, 'transcriptPath' | 'resumeFrom' | 'signal'>;
  turn: Pick<TurnOptions, 'timeoutMs' | 'toolTimeoutMs'>;
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

  let tools: string[] | undefined;
  if (def.tools !== undefined) {
    tools = [...def.tools];
    if (def.mcpServers.length) {
      try {
        const mcp = resolveMcp(def.mcpServers);
        warnings.push(...mcp.errors);
        for (const tool of mcp.tools) {
          if (!tools.includes(tool)) tools.push(tool);
        }
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : String(error));
      }
    }
  }

  const start: Launch['start'] = {
    parent: ctx.parent,
    cwd: ctx.cwd,
    label: { name: def.name, context: 'opium' },
    systemPrompt,
    model: def.models[0],
    extensions: def.packages.length ? { packages: def.packages } : 'none',
    noContextFiles: !def.contextFiles,
    noSkills: true,
    permissionAsks: def.permissionAsks,
    gitGuard: def.gitGuard,
    // path, loop and JSON error guards in every child, as in slim
    extensionFactories: sessionGuards,
  };
  if (tools !== undefined) start.tools = tools;
  if (def.thinking !== undefined) start.thinking = def.thinking;

  const turn: Launch['turn'] = {};
  if (def.timeoutMs !== undefined) turn.timeoutMs = def.timeoutMs;
  if (def.toolTimeoutMs !== undefined) turn.toolTimeoutMs = def.toolTimeoutMs;
  return { start, turn, warnings };
};
