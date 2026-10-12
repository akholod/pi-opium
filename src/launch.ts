// Turns an AgentDefinition into runner options: system prompt with its
// skills inlined, tool allowlist (plus MCP tool names), extensions, limits.

import { readFileSync } from 'node:fs';
import {
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

export const defaultResolveSkill = (
  name: string,
  cwd: string,
): ResolvedSkill | undefined => {
  const { skills } = loadSkills({
    cwd,
    agentDir: getAgentDir(),
    skillPaths: [],
    includeDefaults: true,
  });
  const skill = skills.find((s) => s.name === name);
  let resolved: ResolvedSkill | undefined;
  if (skill) {
    try {
      resolved = {
        path: skill.filePath,
        content: stripFrontmatter(readFileSync(skill.filePath, 'utf8')),
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
  const resolveSkill = ctx.resolveSkill ?? defaultResolveSkill;
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
    systemPrompt,
    model: def.models[0],
    extensions: def.packages.length ? { packages: def.packages } : 'none',
    noContextFiles: !def.contextFiles,
    noSkills: true,
    permissionAsks: def.permissionAsks,
    gitGuard: def.gitGuard,
  };
  if (tools !== undefined) start.tools = tools;
  if (def.thinking !== undefined) start.thinking = def.thinking;

  const turn: Launch['turn'] = {};
  if (def.timeoutMs !== undefined) turn.timeoutMs = def.timeoutMs;
  if (def.toolTimeoutMs !== undefined) turn.toolTimeoutMs = def.toolTimeoutMs;
  return { start, turn, warnings };
};
