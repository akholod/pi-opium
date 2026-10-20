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

// Tools a package registers that an agent gets without listing them in
// extraTools: read-only navigation and diagnostics; the mutating
// ast_grep_replace is left to extraTools.
const PACKAGE_TOOLS: Readonly<Record<string, readonly string[]>> = {
  'pi-lens': [
    'lsp_navigation',
    'lens_diagnostics',
    'ast_grep_search',
    'ast_grep_outline',
    'symbol_search',
    'read_symbol',
    'read_enclosing',
  ],
};

// Packages that register tools inactive until asked for: pi-lens turns its
// "situational" tools off at session start and pi_lens_activate_tools only
// brings them back on the next prompt, which a child (one prompt per
// generation) never gets.
const LAZY_PACKAGES = new Set(['pi-lens']);

const allowedBy = (patterns: readonly string[]) => {
  const exact = new Set(patterns.filter((p) => !p.includes('*')));
  const prefixes = patterns
    .filter((p) => p.endsWith('*') && p.indexOf('*') === p.length - 1)
    .map((p) => p.slice(0, -1));
  return (name: string): boolean =>
    exact.has(name) || prefixes.some((prefix) => name.startsWith(prefix));
};

// Before each generation, switches on every registered tool the allowlist
// names that is still inactive.
export const activateAllowed =
  (allowed: readonly string[]): ExtensionFactory =>
  (pi) => {
    const isAllowed = allowedBy(allowed);
    pi.on('before_agent_start', () => {
      const active = pi.getActiveTools();
      const missing = pi
        .getAllTools()
        .map((tool) => tool.name)
        .filter((name) => !active.includes(name) && isAllowed(name));
      if (missing.length) pi.setActiveTools([...active, ...missing]);
      return undefined;
    });
  };

// lsp_navigation can also rename symbols and files and run code actions; an
// agent that cannot edit files must not edit them through it.
const MUTATING_LSP = new Set([
  'rename',
  'rename_file',
  'codeAction',
  'executeCommand',
]);

export const readOnlyLsp: ExtensionFactory = (pi) => {
  pi.on('tool_call', (event) => {
    const { operation } = event.input as { operation?: unknown };
    const mutating =
      event.toolName === 'lsp_navigation' &&
      typeof operation === 'string' &&
      MUTATING_LSP.has(operation);
    return mutating
      ? {
          block: true,
          reason:
            `lsp_navigation ${String(operation)} changes files; ` +
            'this agent is read-only',
        }
      : undefined;
  });
};

// A single `ctx7 library|docs ...` (or via npx) with no shell syntax: no
// separators, pipes, redirects, substitution, variables or newlines.
export const CTX7_COMMAND = new RegExp(
  '^\\s*(?:ctx7|npx(?:\\s+(?:-y|--yes))?\\s+ctx7(?:@[\\w.-]+)?)' +
    '\\s+(?:library|docs)(?:\\s[^;&|`$<>\\r\\n]*)?\\s*$',
);

// researcher gets a shell only to read library docs through the Context7
// CLI; everything else is refused.
export const ctx7OnlyBash: ExtensionFactory = (pi) => {
  pi.on('tool_call', (event) => {
    const { command } = event.input as { command?: unknown };
    const allowed =
      event.toolName !== 'bash' ||
      (typeof command === 'string' && CTX7_COMMAND.test(command));
    return allowed
      ? undefined
      : {
          block: true,
          reason:
            'bash is limited to a single `ctx7 library <name> "<query>"` ' +
            'or `ctx7 docs <libraryId> "<query>"` call (optionally via ' +
            '`npx -y ctx7@latest`), with no pipes, redirects, `;`, `&`, ' +
            'substitution or variables',
        };
  });
};

// Agents whose bash tool is restricted, and how.
const BASH_GUARDS: Readonly<Record<string, ExtensionFactory>> = {
  researcher: ctx7OnlyBash,
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

  if (tools !== undefined) {
    const added = [
      ...packages.flatMap((name) => PACKAGE_TOOLS[name] ?? []),
      ...def.extraTools,
    ];
    for (const tool of added) {
      if (!tools.includes(tool)) tools.push(tool);
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
    extensionFactories: sessionGuards,
  };
  const readOnly =
    tools?.includes('lsp_navigation') &&
    !tools.includes('edit') &&
    !tools.includes('write');
  const lazy =
    tools !== undefined && packages.some((name) => LAZY_PACKAGES.has(name));
  const bashGuard = tools?.includes('bash') ? BASH_GUARDS[def.name] : undefined;
  if (vision || readOnly || lazy || bashGuard) {
    start.extensionFactories = [
      ...sessionGuards,
      ...(vision ? [vision.tool(def.name)] : []),
      ...(readOnly ? [readOnlyLsp] : []),
      ...(bashGuard ? [bashGuard] : []),
      ...(lazy && tools ? [activateAllowed(tools)] : []),
    ];
  }
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
