// pi-opium: oh-my-opencode-slim daily workflow for pi.
//   - orchestrator system prompt section on every turn (toggle with
//     /orchestrator on|off|status; persisted in ~/.pi/agent/opium.json)
//   - agent, agent_status, agent_result, agent_message, agent_cancel,
//     agent_revive: specialist agents (agents/*.md, overridable in
//     ~/.pi/agent/agents/) run in-process through pi-agent-runner;
//     background results are delivered back to this session
//   - /council <question> and the `council` tool: three councillors on
//     different models in parallel, then a synthesized report

import { join } from 'node:path';
import { Type } from 'typebox';
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { humanWaitTracker } from 'pi-agent-runner';
import { buildOrchestratorPrompt } from '../src/prompt.ts';
import { readState, statePath, writeState } from '../src/state.ts';
import { readAgentOverrides } from '../src/agents.ts';
import { RunRegistry, defaultStarter, type Starter } from '../src/runs.ts';
import { createDelivery, type Delivery } from '../src/delivery.ts';
import {
  defaultAgentNames,
  defaultLoadDef,
  registerAgentTools,
} from '../src/tools.ts';
import { renderSeats, runCouncil, type CouncilResult } from '../src/council.ts';

const SECTION = 'orchestrator';

const agentOverrides = (path: string) =>
  readAgentOverrides(path, join(getAgentDir(), 'settings.json'));

const formatUsage = ({ usage }: CouncilResult): string => {
  const tokens = usage.input + usage.output;
  const cost = usage.cost.toFixed(4);
  return `usage: ${usage.runs} runs, ${tokens} tokens, $${cost}`;
};

const outcomeLine = (result: CouncilResult): string =>
  `${result.outcome}${result.error ? `: ${result.error}` : ''}`;

// Report for the transcript / tool result. Failed synthesis still shows
// the raw councillor answers rather than nothing.
const renderCouncil = (result: CouncilResult): string => {
  const lines = [`# Council: ${result.question}`, ''];
  if (result.outcome === 'completed') {
    lines.push(result.report);
  } else {
    lines.push(`council ${outcomeLine(result)}`, '', renderSeats(result.seats));
  }
  lines.push('', formatUsage(result));
  return lines.join('\n');
};

export interface OpiumDeps {
  // runs an agent; defaults to pi-agent-runner's startAgent
  starter?: Starter;
  // run metadata and transcripts; defaults to ~/.pi/agent/opium/runs
  runsDir?: string;
}

export const createOpium = (pi: ExtensionAPI, deps: OpiumDeps = {}): void => {
  const path = statePath(CONFIG_DIR_NAME);
  // watch permission dialogs from the start so a run never misses one
  humanWaitTracker(pi.events);
  let state = readState(path);
  // the roster names only agents the `agent` tool can call
  const prompt = buildOrchestratorPrompt({ available: defaultAgentNames() });
  // pi-agent-runner never loads Opium into its children. pi-subagents, if
  // installed alongside, does; its children must not be told to
  // orchestrate and delegate.
  const isSubagentChild = process.env.PI_SUBAGENT_CHILD === '1';

  // One run registry per parent session, created on first tool use. Its
  // starter reads the latest context so new runs use the current model.
  let registry: RunRegistry | undefined;
  let delivery: Delivery | undefined;
  let latestCtx: ExtensionContext | undefined;
  const getRegistry = (ctx: ExtensionContext): RunRegistry => {
    latestCtx = ctx;
    if (registry) return registry;
    // bound to this registry, so a late run of a replaced session is never
    // delivered into the next one
    const sink: { delivery?: Delivery } = {};
    const created: RunRegistry = new RunRegistry({
      runsDir: deps.runsDir,
      start: (def, options) =>
        (
          deps.starter ??
          defaultStarter({
            parent: {
              events: pi.events,
              get ctx() {
                return latestCtx ?? ctx;
              },
            },
            cwd: ctx.cwd,
          })
        )(def, options),
      onTerminal: (run) => sink.delivery?.deliver(run),
    });
    sink.delivery = createDelivery({
      send: (message, options) => pi.sendMessage(message, options),
      markRead: (id) => created.markRead(id),
    });
    delivery = sink.delivery;
    registry = created;
    return created;
  };
  pi.on('session_start', (_event, ctx) => {
    latestCtx = ctx;
  });
  pi.on('session_shutdown', async () => {
    const current = registry;
    registry = undefined;
    latestCtx = undefined;
    // stop first so runs cancelled by the shutdown are never delivered
    delivery?.stop();
    delivery = undefined;
    await current?.shutdown();
  });
  registerAgentTools(pi, (ctx) => ({
    registry: getRegistry(ctx),
    loadDef: defaultLoadDef,
    agentNames: defaultAgentNames,
    cwd: ctx.cwd,
  }));

  pi.on('before_agent_start', (event) => {
    if (isSubagentChild || !state.orchestrator) return;
    event.systemPromptOptions.sections[SECTION] = prompt;
  });

  pi.registerCommand('orchestrator', {
    description:
      'Toggle the opium orchestrator prompt: /orchestrator on | off | status',
    handler: async (args, ctx) => {
      const word = args.trim().toLowerCase();
      if (word === 'on' || word === 'off') {
        state = { orchestrator: word === 'on' };
        writeState(path, state);
      } else if (word !== '' && word !== 'status') {
        ctx.ui.notify('usage: /orchestrator on | off | status', 'error');
        return;
      }
      const mode = state.orchestrator ? 'ON' : 'OFF';
      ctx.ui.notify(`[opium] orchestrator prompt is ${mode} (${path})`, 'info');
    },
  });

  pi.registerCommand('council', {
    description:
      'Ask the multi-model council: three councillors answer ' +
      'independently, the council synthesizes',
    handler: async (args, ctx) => {
      const question = args.trim();
      if (question === '') {
        ctx.ui.notify('usage: /council <question>', 'error');
        return;
      }
      const { overrides, errors } = agentOverrides(path);
      for (const error of errors) {
        ctx.ui.notify(`[council] ${error}`, 'warning');
      }
      ctx.ui.notify('[council] convening alpha, beta, gamma', 'info');
      const result = await runCouncil({
        parent: { events: pi.events, ctx },
        cwd: ctx.cwd,
        question,
        overrides,
        signal: ctx.signal,
        onProgress: (message) => ctx.ui.notify(`[${message}]`, 'info'),
      });
      pi.sendMessage(
        {
          customType: 'opium-council',
          content: renderCouncil(result),
          display: true,
          details: { outcome: result.outcome, question },
        },
        { triggerTurn: false },
      );
      if (result.outcome !== 'completed') {
        ctx.ui.notify(`[council] ${outcomeLine(result)}`, 'error');
      }
    },
  });

  pi.registerTool({
    name: 'council',
    label: 'Council',
    description:
      'Multi-model consensus: three read-only councillors on different ' +
      'models answer the question independently, then a synthesizer ' +
      'returns a structured report (Council Response, Per-Councillor ' +
      'Details, Council Summary). Slow and expensive; use for high-stakes ' +
      'decisions, not routine work.',
    promptSnippet: 'Multi-model council for high-stakes decisions',
    promptGuidelines: [
      'Use the council tool only for critical decisions that benefit ' +
        'from several independent model perspectives, or when the user ' +
        'asks for council, consensus or multiple opinions.',
      'Pass the full question and the relevant context (paths, ' +
        'constraints, options under consideration).',
      'Preserve the report structure when relaying it; state the ' +
        'recommendation briefly before acting on it.',
    ],
    parameters: Type.Object({
      question: Type.String({
        description: 'The decision, trade-off or question to resolve',
      }),
      context: Type.Optional(
        Type.String({
          description:
            'Relevant context: file paths, constraints, options considered',
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const result = await runCouncil({
        parent: { events: pi.events, ctx },
        cwd: ctx.cwd,
        question: params.question,
        context: params.context,
        overrides: agentOverrides(path).overrides,
        signal,
        onProgress: (message) =>
          onUpdate?.({
            content: [{ type: 'text', text: message }],
            details: {},
          }),
      });
      const text = renderCouncil(result);
      // pi treats a tool call as failed only when execute throws
      if (result.outcome !== 'completed') throw new Error(text);
      return {
        content: [{ type: 'text', text }],
        details: {
          outcome: result.outcome,
          seats: result.seats.map((s) => ({
            seat: s.seat,
            status: s.status,
            model: s.model,
          })),
        },
      };
    },
  });
};

export default function opiumExtension(pi: ExtensionAPI) {
  createOpium(pi);
}
