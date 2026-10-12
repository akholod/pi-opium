// pi-opium: oh-my-opencode-slim daily workflow for pi.
//   - orchestrator system prompt section on every turn (toggle with
//     /orchestrator on|off|status; persisted in ~/.pi/agent/opium.json)
//   - /council <question> and the `council` tool: three councillors on
//     different models in parallel, then a synthesized report
// Specialist agents live in ~/.pi/agent/agents/*.md (pi-subagents);
// the council runs in-process through pi-agent-runner.

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
import { RunRegistry, defaultStarter } from '../src/runs.ts';
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

export default function opiumExtension(pi: ExtensionAPI) {
  const path = statePath(CONFIG_DIR_NAME);
  // watch permission dialogs from the start so a run never misses one
  humanWaitTracker(pi.events);
  let state = readState(path);
  const prompt = buildOrchestratorPrompt();
  // Background pi-subagents children load ambient extensions too; a
  // specialist must not be told to orchestrate and delegate.
  const isSubagentChild = process.env.PI_SUBAGENT_CHILD === '1';

  // One run registry per parent session, created on first tool use. Its
  // starter reads the latest context so new runs use the current model.
  let registry: RunRegistry | undefined;
  let latestCtx: ExtensionContext | undefined;
  const getRegistry = (ctx: ExtensionContext): RunRegistry => {
    latestCtx = ctx;
    registry ??= new RunRegistry({
      start: (def, options) =>
        defaultStarter({
          parent: {
            events: pi.events,
            get ctx() {
              return latestCtx ?? ctx;
            },
          },
          cwd: ctx.cwd,
        })(def, options),
      onTerminal: () => {},
    });
    return registry;
  };
  pi.on('session_start', (_event, ctx) => {
    latestCtx = ctx;
  });
  pi.on('session_shutdown', async () => {
    const current = registry;
    registry = undefined;
    latestCtx = undefined;
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
}
