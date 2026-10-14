// pi-opium: oh-my-opencode-slim daily workflow for pi.
//   - orchestrator system prompt section on every turn (toggle with
//     /orchestrator on|off|status; persisted in ~/.pi/agent/opium.json)
//   - agent, agent_status, agent_result, agent_message, agent_cancel,
//     agent_revive: specialist agents (agents/*.md, overridable in
//     ~/.pi/agent/agents/) run in-process through pi-agent-runner;
//     background results are delivered back to this session
//   - /council <question> and the `council` tool: three councillors on
//     different models in parallel, then a synthesized report

import { Type } from 'typebox';
import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { humanWaitTracker, mountRunsView } from 'pi-agent-runner';
import { buildOrchestratorPrompt } from '../src/prompt.ts';
import {
  readState,
  readWakeSettings,
  seedDefaults,
  statePath,
  writeState,
} from '../src/state.ts';
import { readAgentOverrides } from '../src/agents.ts';
import {
  RunRegistry,
  defaultStarter,
  type RunRecord,
  type Starter,
} from '../src/runs.ts';
import { createDelivery, type Delivery } from '../src/delivery.ts';
import {
  defaultAgentNames,
  defaultLoadDef,
  registerAgentTools,
} from '../src/tools.ts';
import { boardFingerprint, formatBoard } from '../src/board.ts';
import {
  EXTENSION_INPUT_ENTRY,
  extensionInputHashes,
  hashInput,
  injectReminders,
} from '../src/reminders.ts';
import { createWake, type Wake } from '../src/wake.ts';
import {
  VISION_AGENT,
  VISION_REFUSAL,
  imageInput,
  orchestratorAgents,
  supportsImages,
} from '../src/vision.ts';
import { sessionGuards } from '../src/guards.ts';
import { registerWorkflowCommands } from '../src/commands.ts';
import { applyPresetCommand } from '../src/presets.ts';
import {
  SAME_MODEL_NOTE,
  renderSeats,
  runCouncil,
  sharedSeatModel,
  type CouncilResult,
} from '../src/council.ts';

const SECTION = 'orchestrator';
const CONTINUE = { action: 'continue' } as const;

const agentOverrides = (path: string) => readAgentOverrides(path);

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
  // shipped defaults copied to opium.json on first run; tests inject theirs
  defaultsPath?: string;
  // idle-wake timing; tests inject fake timers
  wake?: {
    intervalMs?: number;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
  };
}

const WAIT_REASON_LIMIT = 500;

const branchOf = (
  ctx: ExtensionContext | undefined,
): ReturnType<ExtensionContext['sessionManager']['getBranch']> | undefined =>
  ctx?.sessionManager?.getBranch();

export const createOpium = (pi: ExtensionAPI, deps: OpiumDeps = {}): void => {
  const path = statePath(CONFIG_DIR_NAME);
  seedDefaults(path, deps.defaultsPath);
  // watch permission dialogs from the start so a run never misses one
  humanWaitTracker(pi.events);
  // slim guards every session, whether or not the orchestrator is on
  for (const guard of sessionGuards) guard(pi);
  registerWorkflowCommands(pi);
  let state = readState(path);
  // the roster names only agents the `agent` tool can call; vision only for
  // a session model that cannot see images, so it is built per model state
  const prompts = new Map<string, string>();
  const promptFor = (model: ExtensionContext['model']): string => {
    const available = orchestratorAgents(defaultAgentNames(), model);
    const key = available.join(',');
    let prompt = prompts.get(key);
    if (prompt === undefined) {
      prompt = buildOrchestratorPrompt({ available });
      prompts.set(key, prompt);
    }
    return prompt;
  };
  // pi-agent-runner never loads Opium into its children. pi-subagents, if
  // installed alongside, does; its children must not be told to
  // orchestrate and delegate.
  const isSubagentChild = process.env.PI_SUBAGENT_CHILD === '1';

  // One run registry per parent session, created on first tool use. Its
  // starter reads the latest context so new runs use the current model.
  let registry: RunRegistry | undefined;
  let delivery: Delivery | undefined;
  let latestCtx: ExtensionContext | undefined;
  // shared live list of child runs (Spiral and Opium) above the editor
  let runsView: { dispose(): void } | undefined;
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
            vision: {
              loadDef: defaultLoadDef,
              available: () => defaultAgentNames().includes(VISION_AGENT),
            },
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
  const wakeSettings = readWakeSettings(path);
  const isActive = (run: RunRecord): boolean =>
    run.state === 'starting' || run.state === 'running';
  // fingerprint of the job board last injected into the context
  let lastBoard = '';
  const newWake = (): Wake =>
    createWake({
      intervalMs: deps.wake?.intervalMs ?? wakeSettings.intervalMs,
      setTimer: deps.wake?.setTimer,
      clearTimer: deps.wake?.clearTimer,
      snapshot: () => {
        const runs = registry?.list() ?? [];
        return {
          active:
            !isSubagentChild &&
            state.orchestrator &&
            runs.some((run) => isActive(run) || run.unread),
          fingerprint: boardFingerprint(runs),
        };
      },
      // before_agent_start fires only for user prompts, so a wake turn
      // carries the board itself
      send: (text) => {
        const runs = registry?.list() ?? [];
        const now = Date.now();
        const board = formatBoard(runs, now);
        if (board !== undefined) lastBoard = boardFingerprint(runs, now);
        pi.sendMessage(
          {
            customType: 'opium-wake',
            content: board === undefined ? text : `${text}\n\n${board}`,
            display: false,
          },
          { triggerTurn: true },
        );
      },
    });
  let wake = newWake();
  pi.on('session_start', (_event, ctx) => {
    latestCtx = ctx;
    wake.stop();
    wake = newWake();
    lastBoard = '';
    runsView?.dispose();
    runsView = isSubagentChild ? undefined : mountRunsView(ctx);
  });
  pi.on('agent_start', () => {
    wake.busy();
  });
  pi.on('agent_settled', (event) => {
    if (event.aborted || !wakeSettings.enabled) return;
    if (isSubagentChild || !state.orchestrator) return;
    wake.settled();
  });
  pi.on('input', (event, ctx) => {
    if (event.source !== 'extension') {
      wake.userInput();
      // a model that cannot see images gets the files and a pointer to vision
      return (
        (!isSubagentChild && defaultAgentNames().includes(VISION_AGENT)
          ? imageInput(event, ctx)
          : undefined) ?? CONTINUE
      );
    }
    // Pi marks nothing on the resulting user message, so remember the text
    // durably; the context handler then skips it (see src/reminders.ts)
    const hash = hashInput(event.text);
    if (!extensionInputHashes(branchOf(ctx)).has(hash)) {
      pi.appendEntry(EXTENSION_INPUT_ENTRY, { hash });
    }
    return CONTINUE;
  });
  pi.on('session_shutdown', async () => {
    wake.stop();
    runsView?.dispose();
    runsView = undefined;
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
    agentNames: () => orchestratorAgents(defaultAgentNames(), ctx.model),
    refuse: (name) =>
      name === VISION_AGENT && supportsImages(ctx.model) === true
        ? VISION_REFUSAL
        : undefined,
    cwd: ctx.cwd,
  }));

  pi.on('before_agent_start', (event, ctx) => {
    if (isSubagentChild || !state.orchestrator) return {};
    event.systemPromptOptions.sections[SECTION] = promptFor(ctx.model);
    const runs = registry?.list() ?? [];
    const now = Date.now();
    const board = formatBoard(runs, now);
    const fingerprint = board === undefined ? '' : boardFingerprint(runs, now);
    if (board === undefined || fingerprint === lastBoard) {
      lastBoard = fingerprint;
      return {};
    }
    lastBoard = fingerprint;
    return {
      message: {
        customType: 'opium-job-board',
        content: board,
        display: false,
      },
    };
  });

  // request-local: reminders are never persisted into the session
  pi.on('context', (event, ctx) => {
    if (isSubagentChild || !state.orchestrator) return {};
    return {
      messages: injectReminders(
        event.messages,
        extensionInputHashes(branchOf(ctx)),
      ),
    };
  });

  pi.registerTool({
    name: 'wait_for_user',
    label: 'Wait for user',
    description:
      'Pause automatic continuation while waiting for external human ' +
      'action. Final tool action only, after giving the user concrete ' +
      'manual steps; the next user message resumes continuation. For an ' +
      'immediate answer or choice, use a question tool instead. Not for ' +
      'awaiting background agents: their results are delivered ' +
      'automatically.',
    promptSnippet: 'Pause and wait for a manual step by the user',
    parameters: Type.Object({
      reason: Type.String({
        minLength: 1,
        maxLength: WAIT_REASON_LIMIT,
        description: 'Short description of the external human action awaited',
      }),
    }),
    async execute(_id, params) {
      const reason = params.reason.replace(/\s+/g, ' ').trim();
      if (!reason) {
        throw new Error('wait_for_user requires a non-empty reason');
      }
      if (isSubagentChild || !state.orchestrator) {
        throw new Error(
          'wait_for_user can only be used in an orchestrator session',
        );
      }
      const busy = (registry?.list() ?? []).some(isActive);
      if (!busy) wake.waitForUser();
      const text = busy
        ? [
            'state: waiting_for_user_skipped',
            `reason: ${reason}`,
            '',
            'Background agents are still running. Do not block on manual ' +
              'input — end this turn now; results are delivered automatically.',
          ]
        : [
            'state: waiting_for_user',
            `reason: ${reason}`,
            '',
            'End this turn now. Do not call more tools until the user ' +
              'responds.',
          ];
      return {
        content: [{ type: 'text' as const, text: text.join('\n') }],
        details: {
          state: busy ? 'waiting_for_user_skipped' : 'waiting_for_user',
        },
      };
    },
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

  pi.registerCommand('opium-preset', {
    description:
      'Switch the per-agent model preset for new runs: ' +
      '/opium-preset [name|off] (no argument lists presets)',
    handler: async (args, ctx) => {
      const reply = applyPresetCommand(path, args);
      ctx.ui.notify(`[opium] ${reply.text}`, reply.error ? 'error' : 'info');
    },
  });

  pi.registerTool({
    name: 'opium_preset',
    label: 'Opium preset',
    description:
      'Switch the per-agent model preset for new agent runs; list the ' +
      'presets when no name is given. "off" clears the active preset. ' +
      'Runs already started keep their model.',
    promptSnippet: 'Switch the model preset for new agent runs',
    parameters: Type.Object({
      name: Type.Optional(
        Type.String({ description: 'Preset name, or "off"; omit to list' }),
      ),
    }),
    async execute(_toolCallId, params) {
      const reply = applyPresetCommand(path, params.name);
      // pi treats a tool call as failed only when execute throws
      if (reply.error) throw new Error(reply.text);
      return {
        content: [{ type: 'text' as const, text: reply.text }],
        details: {},
      };
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
      if (sharedSeatModel({ overrides })) {
        ctx.ui.notify(`[council] ${SAME_MODEL_NOTE}`, 'warning');
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
      const overrides = agentOverrides(path).overrides;
      const same = sharedSeatModel({ overrides });
      const text =
        renderCouncil(result) + (same ? `\n\nnote: ${SAME_MODEL_NOTE}` : '');
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
