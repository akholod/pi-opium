// Model-facing tools over the run registry: agent, agent_status,
// agent_result, agent_message, agent_cancel, agent_revive. The handlers are
// pure over injected dependencies; registerAgentTools wires them into Pi.

import { join } from 'node:path';
import { Type } from 'typebox';
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {
  loadAgent,
  loadAgents,
  readAgentOverrides,
  type AgentDefinition,
} from './agents.ts';
import { RunRefusal, type RunRegistry, type RunRecord } from './runs.ts';
import { statePath } from './state.ts';

export interface ToolDeps {
  registry: RunRegistry;
  // fresh definition (with overrides) for a callable agent
  loadDef: (name: string) => AgentDefinition;
  // names of the callable (advertised) agents
  agentNames: () => string[];
  cwd: string;
  now?: () => number;
}

export interface ToolOutput {
  text: string;
  details: Record<string, unknown>;
}

const OBJECTIVE_LIMIT = 120;

const seconds = (ms: number): string => `${Math.round(ms / 100) / 10}s`;

const truncate = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit - 1)}…` : text;

const out = (
  text: string,
  run?: RunRecord,
  extra: Record<string, unknown> = {},
): ToolOutput => ({
  text,
  details: run
    ? { id: run.id, agent: run.agent, state: run.state, ...extra }
    : extra,
});

const isTerminal = (run: RunRecord): boolean =>
  run.state !== 'starting' && run.state !== 'running';

const header = (run: RunRecord): string =>
  `run ${run.id} (${run.agent}) ${run.state}, generation ${run.generation}`;

const valueText = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return JSON.stringify(value, null, 2);
};

// Shared result format for terminal runs.
export const formatRun = (run: RunRecord): string => {
  const lines = [header(run)];
  const { result } = run;
  const error = run.error ?? result?.error;
  const answer = result ? valueText(result.value) : '';
  if (answer !== '') lines.push(answer);
  if (error) lines.push(`error: ${error}`);
  if (result?.dropped.length) {
    lines.push(`dropped messages: ${result.dropped.join(' | ')}`);
  }
  if (run.warnings.length) lines.push(`warnings: ${run.warnings.join('; ')}`);
  if (result) {
    const { usage } = result;
    lines.push(
      `tokens ${usage.input + usage.output}, ` +
        `$${usage.cost.toFixed(4)}, ${usage.durationMs / 1000}s`,
    );
  }
  return lines.join('\n');
};

const callable = (deps: ToolDeps, name: string): AgentDefinition => {
  const names = deps.agentNames();
  if (!names.includes(name)) {
    throw new Error(
      `unknown agent "${name}"; available: ${names.join(', ') || 'none'}`,
    );
  }
  return deps.loadDef(name);
};

const requireRun = (deps: ToolDeps, id: string): RunRecord => {
  const run = deps.registry.get(id);
  if (!run) throw new Error(`unknown run "${id}"`);
  return run;
};

export interface AgentParams {
  agent: string;
  task: string;
  background?: boolean;
  resume?: string;
}

export interface Hooks {
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

const follow = async (
  deps: ToolDeps,
  spawned: { run: RunRecord; done: Promise<RunRecord> },
  background: boolean,
  hooks: Hooks,
): Promise<ToolOutput> => {
  const { run, done } = spawned;
  run.background = background;
  if (background) {
    done.catch(() => undefined);
    return out(
      `run ${run.id} (${run.agent}) started in the background; its result ` +
        `is delivered when it finishes; use agent_status / agent_result ${
          run.id
        }`,
      run,
      { background: true },
    );
  }
  hooks.onProgress?.(`${run.agent}: running`);
  const cancel = (): void => {
    void deps.registry.cancel(run.id).catch(() => undefined);
  };
  const { signal } = hooks;
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  let final: RunRecord;
  try {
    final = await done;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
  hooks.onProgress?.(`${final.agent}: ${final.state}`);
  deps.registry.markRead(final.id);
  const text = formatRun(final);
  if (final.state !== 'completed') throw new Error(text);
  return out(text, final, { background: false });
};

const reviveRun = async (
  deps: ToolDeps,
  id: string,
  task: string,
  agent: string | undefined,
  background: boolean | undefined,
  hooks: Hooks,
): Promise<ToolOutput> => {
  const owner = deps.registry.agentOf(id);
  const name = owner ?? agent;
  if (!name) throw new Error(`unknown run "${id}"`);
  if (owner && agent && agent !== owner) {
    throw new Error(`run ${id} belongs to agent "${owner}", not "${agent}"`);
  }
  const def = callable(deps, name);
  let spawned;
  try {
    spawned = deps.registry.revive(id, task, def);
  } catch (error) {
    if (error instanceof RunRefusal) {
      throw new Error(
        `cannot revive run ${id}: ${error.message}; ` +
          'do not retry as a new spawn',
        { cause: error },
      );
    }
    throw error;
  }
  return follow(deps, spawned, background ?? def.background, hooks);
};

export const runAgent = async (
  deps: ToolDeps,
  params: AgentParams,
  hooks: Hooks = {},
): Promise<ToolOutput> => {
  if (params.resume) {
    return reviveRun(
      deps,
      params.resume,
      params.task,
      params.agent,
      params.background,
      hooks,
    );
  }
  const def = callable(deps, params.agent);
  const background = params.background ?? def.background;
  let spawned;
  try {
    spawned = deps.registry.spawn(def, params.task, {
      background,
      cwd: deps.cwd,
    });
  } catch (error) {
    if (error instanceof RunRefusal) {
      throw new Error(error.message, { cause: error });
    }
    throw error;
  }
  return follow(deps, spawned, background, hooks);
};

export const reviveAgent = (
  deps: ToolDeps,
  params: {
    id: string;
    task: string;
    agent?: string;
    background?: boolean;
  },
  hooks: Hooks = {},
): Promise<ToolOutput> =>
  reviveRun(
    deps,
    params.id,
    params.task,
    params.agent,
    params.background,
    hooks,
  );

const statusLine = (run: RunRecord, now: number): string => {
  const flags = [
    run.background ? 'background' : 'foreground',
    run.unread ? 'unread' : '',
    run.retained ? 'retained' : 'not retained',
  ].filter(Boolean);
  const age = seconds(now - run.startedAt);
  return (
    `${run.id} ${run.agent} ${run.state} gen ${run.generation} ` +
    `[${flags.join(', ')}] ${age} ago: ${truncate(
      run.objective,
      OBJECTIVE_LIMIT,
    )}`
  );
};

export const agentStatus = (
  deps: ToolDeps,
  params: { id?: string },
): ToolOutput => {
  const now = (deps.now ?? Date.now)();
  if (params.id === undefined) {
    const runs = deps.registry.list();
    const text = runs.length
      ? runs.map((run) => statusLine(run, now)).join('\n')
      : 'no runs';
    return out(text, undefined, { runs: runs.map((run) => run.id) });
  }
  const run = requireRun(deps, params.id);
  const end = run.endedAt ?? now;
  const lines = [
    header(run),
    `background: ${run.background}, unread: ${run.unread}, ` +
      `retained: ${run.retained}`,
    `age: ${seconds(now - run.startedAt)}, ` +
      `${isTerminal(run) ? 'duration' : 'running for'}: ${seconds(
        end - run.startedAt,
      )}`,
    `objective: ${truncate(run.objective, OBJECTIVE_LIMIT)}`,
  ];
  if (run.warnings.length) lines.push(`warnings: ${run.warnings.join('; ')}`);
  return out(lines.join('\n'), run);
};

export const agentResult = (
  deps: ToolDeps,
  params: { id: string },
): ToolOutput => {
  const run = requireRun(deps, params.id);
  if (!isTerminal(run)) {
    return out(
      `run ${run.id} is still running (generation ${run.generation})`,
      run,
    );
  }
  deps.registry.result(run.id);
  return out(formatRun(run), run);
};

export const agentMessage = async (
  deps: ToolDeps,
  params: { id: string; message: string; mode?: 'queue' | 'steer' },
): Promise<ToolOutput> => {
  const outcome = await deps.registry.message(
    params.id,
    params.message,
    params.mode ?? 'queue',
  );
  const id = params.id;
  switch (outcome) {
    case 'unknown':
      throw new Error(`unknown run "${id}"`);
    case 'queued':
      return out(
        `message to run ${id}: queued (accepted, not yet consumed; it is ` +
          'delivered within the current generation or reported as dropped)',
        undefined,
        { id, disposition: outcome },
      );
    case 'idle':
      return out(
        `message to run ${id}: idle (the run is not running; use ` +
          'agent_revive to give it a new instruction)',
        undefined,
        { id, disposition: outcome },
      );
    default:
      return out(
        `message to run ${id}: ${outcome} (the session is no longer live; ` +
          'use agent_revive)',
        undefined,
        { id, disposition: outcome },
      );
  }
};

export const agentCancel = async (
  deps: ToolDeps,
  params: { id: string },
): Promise<ToolOutput> => {
  const outcome = await deps.registry.cancel(params.id);
  const id = params.id;
  if (outcome === 'unknown') throw new Error(`unknown run "${id}"`);
  if (outcome === 'cancelled') {
    return out(
      `run ${id} cancelled; the session is kept; continue it with ` +
        'agent_revive',
      undefined,
      { id, outcome },
    );
  }
  return out(`run ${id} is not running`, undefined, { id, outcome });
};

// ---- Pi registration ----

export const defaultLoadDef = (name: string): AgentDefinition => {
  const { overrides } = readAgentOverrides(
    statePath(CONFIG_DIR_NAME),
    join(getAgentDir(), 'settings.json'),
  );
  return loadAgent(name, { overrides });
};

export const defaultAgentNames = (): string[] =>
  [...loadAgents().agents.values()]
    .filter((agent) => agent.advertise)
    .map((agent) => agent.name)
    .sort();

const content = ({ text, details }: ToolOutput) => ({
  content: [{ type: 'text' as const, text }],
  details,
});

// getContext receives the context of the current tool call and returns the
// dependencies (creating the session's registry on first use).
export const registerAgentTools = (
  pi: ExtensionAPI,
  getContext: (ctx: ExtensionContext) => ToolDeps,
): void => {
  const progress =
    (onUpdate?: (update: ReturnType<typeof content>) => void) =>
    (message: string): void =>
      onUpdate?.(content(out(message)));

  pi.registerTool({
    name: 'agent',
    label: 'Agent',
    description:
      'Run a specialist agent on a task, in the foreground (wait for the ' +
      'answer) or in the background (returns a run id immediately). Pass ' +
      '`resume` with a run id to continue that run with a new instruction.',
    promptSnippet: 'Delegate a task to a specialist agent',
    promptGuidelines: [
      'Give the agent a complete, self-contained task: goal, relevant ' +
        'paths, constraints and the expected output.',
      'Background runs return a run id; read the outcome with ' +
        'agent_result and check progress with agent_status.',
      'To continue an earlier run, use `resume` (or agent_revive) with ' +
        'its run id instead of spawning a duplicate.',
    ],
    parameters: Type.Object({
      agent: Type.String({ description: 'Name of the agent to run' }),
      task: Type.String({
        description: 'The complete task or, with `resume`, the new instruction',
      }),
      background: Type.Optional(
        Type.Boolean({
          description:
            "Run in the background; defaults to the agent's own setting",
        }),
      ),
      resume: Type.Optional(
        Type.String({
          description: 'Run id of a finished run to continue with `task`',
        }),
      ),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const result = await runAgent(getContext(ctx), params, {
        signal,
        onProgress: progress(onUpdate),
      });
      return content(result);
    },
  });

  pi.registerTool({
    name: 'agent_status',
    label: 'Agent status',
    description:
      'Show one run (state, generation, age, objective) by id, or all ' +
      'runs newest first when no id is given. Does not mark results read.',
    promptSnippet: 'List agent runs or inspect one',
    parameters: Type.Object({
      id: Type.Optional(
        Type.String({ description: 'Run id; omit to list all runs' }),
      ),
    }),
    execute(_id, params, _signal, _onUpdate, ctx) {
      return Promise.resolve(content(agentStatus(getContext(ctx), params)));
    },
  });

  pi.registerTool({
    name: 'agent_result',
    label: 'Agent result',
    description:
      'Get the result of a run. A running run reports that it is still ' +
      'running; a finished run returns its answer and is marked read.',
    promptSnippet: 'Read the result of an agent run',
    parameters: Type.Object({
      id: Type.String({ description: 'Run id' }),
    }),
    execute(_id, params, _signal, _onUpdate, ctx) {
      return Promise.resolve(content(agentResult(getContext(ctx), params)));
    },
  });

  pi.registerTool({
    name: 'agent_message',
    label: 'Agent message',
    description:
      'Send a message to a running agent: queued after its current step ' +
      "(default) or steering it immediately. Reports the message's " +
      'disposition.',
    promptSnippet: 'Send a message to a running agent',
    parameters: Type.Object({
      id: Type.String({ description: 'Run id' }),
      message: Type.String({ description: 'Message text' }),
      mode: Type.Optional(
        Type.Union([Type.Literal('queue'), Type.Literal('steer')], {
          description: "'queue' (default) follows up; 'steer' interrupts",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return content(await agentMessage(getContext(ctx), params));
    },
  });

  pi.registerTool({
    name: 'agent_cancel',
    label: 'Agent cancel',
    description:
      'Cancel a running agent. Its session is kept and can be continued ' +
      'with agent_revive.',
    promptSnippet: 'Cancel a running agent',
    parameters: Type.Object({
      id: Type.String({ description: 'Run id' }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return content(await agentCancel(getContext(ctx), params));
    },
  });

  pi.registerTool({
    name: 'agent_revive',
    label: 'Agent revive',
    description:
      'Continue a finished run with a new instruction, keeping its ' +
      'context. Refused while the run is still running.',
    promptSnippet: 'Continue a finished agent run with a new instruction',
    parameters: Type.Object({
      id: Type.String({ description: 'Run id of a finished run' }),
      task: Type.String({ description: 'The new instruction' }),
      agent: Type.Optional(
        Type.String({
          description:
            'Agent name; needed only when the run is no longer in memory',
        }),
      ),
      background: Type.Optional(
        Type.Boolean({
          description:
            "Run in the background; defaults to the agent's own setting",
        }),
      ),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const result = await reviveAgent(getContext(ctx), params, {
        signal,
        onProgress: progress(onUpdate),
      });
      return content(result);
    },
  });
};
