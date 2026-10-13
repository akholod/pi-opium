// Multi-model council (oh-my-opencode-slim): councillors answer the same
// question independently and in parallel, then the council agent
// synthesizes a structured report. Runs in-process through
// pi-agent-runner; seats are the agents `councillor-<seat>` (agents/*.md).

import {
  loadAgent,
  type AgentDefinition,
  type AgentOverrides,
} from './agents.ts';
import { toolGuards } from './guards.ts';
import {
  runAgent,
  type ParentContext,
  type RunAgentResult,
  type RunStatus,
} from 'pi-agent-runner';

export const SEATS = ['alpha', 'beta', 'gamma'] as const;
export type Seat = (typeof SEATS)[number];

export const COUNCIL_AGENT = 'council';
export const councillorAgent = (seat: Seat): string => `councillor-${seat}`;

export interface Attempt {
  // requested model id (the list entry)
  model: string;
  status: RunStatus | 'empty';
  error?: string;
}

const SEAT_TOOLS = ['read', 'grep', 'find', 'ls'];

export interface CouncilOptions {
  parent: ParentContext;
  cwd: string;
  question: string;
  // extra context the caller already has (paths, constraints)
  context?: string;
  seats?: readonly Seat[];
  // explicit override; else the agent file's timeoutMs; else 900s
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  // test seams
  runAgent?: typeof runAgent;
  agentDirs?: readonly string[];
  overrides?: AgentOverrides;
}

export interface SeatResult {
  seat: Seat;
  agent: string;
  model?: string;
  status: RunStatus;
  // answer text, or the failure reason
  text: string;
  ok: boolean;
  attempts: Attempt[];
}

export interface CouncilUsage {
  cost: number;
  input: number;
  output: number;
  runs: number;
}

export interface CouncilResult {
  outcome: 'completed' | 'failed' | 'aborted';
  question: string;
  seats: SeatResult[];
  // synthesized report from the council agent
  report: string;
  usage: CouncilUsage;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 900_000;

const usageOf = (responses: RunAgentResult[]): CouncilUsage => {
  const usage: CouncilUsage = { cost: 0, input: 0, output: 0, runs: 0 };
  for (const response of responses) {
    usage.cost += response.usage.cost;
    usage.input += response.usage.input;
    usage.output += response.usage.output;
    usage.runs++;
  }
  return usage;
};

export interface FallbackOutcome {
  status: RunStatus;
  value?: string;
  error?: string;
  // resolved model of the final attempt
  model?: string;
  attempts: Attempt[];
  // every underlying run, for usage accounting
  runs: RunAgentResult[];
}

export type StartAttempt = (
  agent: AgentDefinition,
  task: string,
  tools: string[],
  model: string,
) => Promise<RunAgentResult>;

const isAnswer = (r: RunAgentResult): boolean =>
  r.status === 'completed' &&
  typeof r.value === 'string' &&
  r.value.trim() !== '';

export const runWithFallback = async (
  start: StartAttempt,
  agent: AgentDefinition,
  task: string,
  tools: string[],
  signal?: AbortSignal,
  onProgress?: (message: string) => void,
  label: string = agent.name,
): Promise<FallbackOutcome> => {
  const attempts: Attempt[] = [];
  const runs: RunAgentResult[] = [];
  const models = agent.models.length ? agent.models : ['inherit'];
  let last: RunAgentResult | undefined;
  let lastEmpty = false;
  for (const [index, model] of models.entries()) {
    const next = models[index + 1];
    for (let retry = 0; retry < 2; retry++) {
      const response = await start(agent, task, tools, model);
      runs.push(response);
      last = response;
      if (isAnswer(response)) {
        attempts.push({ model, status: 'completed' });
        return {
          status: 'completed',
          value: (response.value as string).trim(),
          model: response.model ?? model,
          attempts,
          runs,
        };
      }
      const empty = response.status === 'completed';
      lastEmpty = empty;
      const error = empty ? 'empty answer' : response.error;
      attempts.push({
        model,
        status: empty ? 'empty' : response.status,
        ...(error ? { error } : {}),
      });
      if (response.status === 'cancelled' || signal?.aborted) {
        return {
          status: 'cancelled',
          error: response.error,
          model: response.model ?? model,
          attempts,
          runs,
        };
      }
      if (empty && retry === 0) {
        onProgress?.(`council: ${label} empty answer from ${model}, retrying`);
        continue;
      }
      break;
    }
    if (next) {
      const status = lastEmpty ? 'empty answer' : last?.status;
      onProgress?.(`council: ${label} ${status} on ${model}, trying ${next}`);
    }
  }
  const finalModel = models[models.length - 1];
  const base: Pick<FallbackOutcome, 'status' | 'error'> = lastEmpty
    ? { status: 'failed', error: 'empty answer' }
    : { status: last?.status ?? 'failed', error: last?.error };
  return { ...base, model: last?.model ?? finalModel, attempts, runs };
};

export const buildCouncillorTask = (
  question: string,
  context: string | undefined,
): string =>
  [
    '# Council question',
    '',
    question,
    ...(context ? ['', '## Context from the caller', '', context] : []),
    '',
    'Examine the codebase in the working directory where relevant before',
    'answering. Give your independent, complete, well-reasoned answer with',
    'file:line references, assumptions and uncertainties. You will not see',
    'the other councillors.',
  ].join('\n');

export const buildCouncilTask = (
  question: string,
  context: string | undefined,
  seats: SeatResult[],
): string =>
  [
    '# Original question',
    '',
    question,
    ...(context ? ['', '## Context from the caller', '', context] : []),
    '',
    '# Councillor responses',
    '',
    ...seats.flatMap((seat) => [
      `## Councillor ${seat.seat}${seat.model ? ` (${seat.model})` : ''}`,
      '',
      seat.ok ? seat.text : `[no answer: ${seat.text}]`,
      '',
    ]),
    'Produce the council report in the required format: Council Response,',
    'Per-Councillor Details (by seat name), Council Summary.',
  ].join('\n');

export const runCouncil = async (
  options: CouncilOptions,
): Promise<CouncilResult> => {
  const run = options.runAgent ?? runAgent;
  const seats = options.seats ?? SEATS;
  const responses: RunAgentResult[] = [];
  const result = (
    outcome: CouncilResult['outcome'],
    seatResults: SeatResult[],
    report: string,
    error?: string,
  ): CouncilResult => ({
    outcome,
    question: options.question,
    seats: seatResults,
    report,
    usage: usageOf(responses),
    ...(error ? { error } : {}),
  });
  const errorText = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

  const loadOptions = {
    dirs: options.agentDirs,
    overrides: options.overrides,
  };
  let seatAgents: AgentDefinition[];
  let synthesizer: AgentDefinition;
  try {
    seatAgents = seats.map((seat) =>
      loadAgent(councillorAgent(seat), loadOptions),
    );
    synthesizer = loadAgent(COUNCIL_AGENT, loadOptions);
  } catch (error) {
    return result('failed', [], '', errorText(error));
  }
  const start: StartAttempt = (agent, task, tools, model) =>
    run({
      parent: options.parent,
      cwd: options.cwd,
      systemPrompt: agent.prompt,
      task,
      tools,
      model,
      thinking: agent.thinking,
      extensions: 'none',
      extensionFactories: [toolGuards],
      result: { kind: 'text' },
      timeoutMs: options.timeoutMs ?? agent.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal: options.signal,
    });
  const chain = (
    agent: AgentDefinition,
    task: string,
    tools: string[],
    label: string,
  ) =>
    runWithFallback(
      start,
      agent,
      task,
      tools,
      options.signal,
      options.onProgress,
      label,
    );
  const failureOf = (outcome: FallbackOutcome): string => {
    const text = outcome.status + (outcome.error ? `: ${outcome.error}` : '');
    const tried = [...new Set(outcome.attempts.map((a) => a.model))];
    return tried.length > 1 ? `${text} (tried ${tried.join(', ')})` : text;
  };

  options.onProgress?.(`council: asking ${seats.join(', ')} in parallel`);
  let seatResults: SeatResult[];
  try {
    const task = buildCouncillorTask(options.question, options.context);
    const outcomes = await Promise.all(
      seatAgents.map(async (agent, index) => {
        const outcome = await chain(agent, task, SEAT_TOOLS, seats[index]);
        // as each seat finishes, so a slow seat is visible while waiting
        options.onProgress?.(`council: ${seats[index]} ${outcome.status}`);
        return outcome;
      }),
    );
    seatResults = seats.map((seat, index) => {
      const outcome = outcomes[index];
      responses.push(...outcome.runs);
      const ok = outcome.status === 'completed';
      return {
        seat,
        agent: councillorAgent(seat),
        model: outcome.model,
        status: outcome.status,
        text: ok ? (outcome.value as string) : failureOf(outcome),
        ok,
        attempts: outcome.attempts,
      };
    });
  } catch (error) {
    return result('failed', [], '', errorText(error));
  }
  if (
    options.signal?.aborted ||
    seatResults.some((s) => s.status === 'cancelled')
  ) {
    return result('aborted', seatResults, '');
  }
  if (!seatResults.some((s) => s.ok)) {
    return result('failed', seatResults, '', 'no councillor answered');
  }

  options.onProgress?.('council: synthesizing');
  let synthesis: FallbackOutcome;
  try {
    synthesis = await chain(
      synthesizer,
      buildCouncilTask(options.question, options.context, seatResults),
      [],
      'synthesis',
    );
  } catch (error) {
    return result('failed', seatResults, '', errorText(error));
  }
  responses.push(...synthesis.runs);
  if (synthesis.status === 'cancelled') {
    return result('aborted', seatResults, '');
  }
  if (synthesis.status !== 'completed') {
    const detail = synthesis.error ? `: ${synthesis.error}` : '';
    return result(
      'failed',
      seatResults,
      '',
      `council synthesis ${synthesis.status}${detail}`,
    );
  }
  return result('completed', seatResults, synthesis.value as string);
};

// Fallback rendering when synthesis failed but councillors answered.
export const renderSeats = (seats: SeatResult[]): string =>
  seats
    .map((seat) => {
      const model = seat.model ? ` (${seat.model})` : '';
      const body = seat.ok ? seat.text : `[no answer: ${seat.text}]`;
      return `## Councillor ${seat.seat}${model}\n\n${body}`;
    })
    .join('\n\n');
