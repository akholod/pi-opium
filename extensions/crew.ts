// pi-crew: oh-my-opencode-slim daily workflow for pi.
//   - orchestrator system prompt section on every turn (toggle with
//     /orchestrator on|off|status; persisted in ~/.pi/agent/crew.json)
//   - /council <question> and the `council` tool: three councillors on
//     different models in parallel, then a synthesized report
// Specialist agents live in ~/.pi/agent/agents/*.md (pi-subagents).

import { Type } from 'typebox';
import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';
import { buildOrchestratorPrompt } from '../src/prompt.ts';
import { readState, statePath, writeState } from '../src/state.ts';
import { renderSeats, runCouncil, type CouncilResult } from '../src/council.ts';

const SECTION = 'orchestrator';

const formatUsage = (result: CouncilResult): string =>
  `usage: ${result.usage.runs} runs, ${result.usage.input + result.usage.output} tokens, $${result.usage.cost.toFixed(4)}`;

// Report for the transcript / tool result. Failed synthesis still shows
// the raw councillor answers rather than nothing.
const renderCouncil = (result: CouncilResult): string => {
  const lines = [`# Council: ${result.question}`, ''];
  if (result.outcome === 'completed') lines.push(result.report);
  else {
    lines.push(
      `council ${result.outcome}${result.error ? `: ${result.error}` : ''}`,
      '',
      renderSeats(result.seats),
    );
  }
  lines.push('', formatUsage(result));
  return lines.join('\n');
};

export default function crewExtension(pi: ExtensionAPI) {
  const path = statePath(CONFIG_DIR_NAME);
  let state = readState(path);
  const prompt = buildOrchestratorPrompt();

  pi.on('before_agent_start', (event) => {
    if (!state.orchestrator) return;
    event.systemPromptOptions.sections[SECTION] = prompt;
  });

  pi.registerCommand('orchestrator', {
    description:
      'Toggle the crew orchestrator prompt: /orchestrator on | off | status',
    handler: async (args, ctx) => {
      const word = args.trim().toLowerCase();
      if (word === 'on' || word === 'off') {
        state = { orchestrator: word === 'on' };
        writeState(path, state);
      } else if (word !== '' && word !== 'status') {
        ctx.ui.notify('usage: /orchestrator on | off | status', 'error');
        return;
      }
      ctx.ui.notify(
        `[crew] orchestrator prompt is ${state.orchestrator ? 'ON' : 'OFF'} (${path})`,
        'info',
      );
    },
  });

  pi.registerCommand('council', {
    description:
      'Ask the multi-model council: three councillors answer independently, the council synthesizes',
    handler: async (args, ctx) => {
      const question = args.trim();
      if (question === '') {
        ctx.ui.notify('usage: /council <question>', 'error');
        return;
      }
      ctx.ui.notify('[council] convening alpha, beta, gamma', 'info');
      const result = await runCouncil({
        pi,
        cwd: ctx.cwd,
        question,
        signal: ctx.signal,
        onProgress: (message) => ctx.ui.notify(`[${message}]`, 'info'),
      });
      pi.sendMessage(
        {
          customType: 'crew-council',
          content: renderCouncil(result),
          display: true,
          details: { outcome: result.outcome, question },
        },
        { triggerTurn: false },
      );
      if (result.outcome !== 'completed') {
        ctx.ui.notify(
          `[council] ${result.outcome}${result.error ? `: ${result.error}` : ''}`,
          'error',
        );
      }
    },
  });

  pi.registerTool({
    name: 'council',
    label: 'Council',
    description:
      'Multi-model consensus: three read-only councillors on different models answer the question independently, then a synthesizer returns a structured report (Council Response, Per-Councillor Details, Council Summary). Slow and expensive; use for high-stakes decisions, not routine work.',
    promptSnippet: 'Multi-model council for high-stakes decisions',
    promptGuidelines: [
      'Use the council tool only for critical decisions that benefit from several independent model perspectives, or when the user asks for council, consensus or multiple opinions.',
      'Pass the full question and the relevant context (paths, constraints, options under consideration).',
      'Preserve the report structure when relaying it; state the recommendation briefly before acting on it.',
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
        pi,
        cwd: ctx.cwd,
        question: params.question,
        context: params.context,
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
