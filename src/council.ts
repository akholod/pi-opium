// Multi-model council (oh-my-opencode-slim): councillors answer the same
// question independently and in parallel, then the council agent
// synthesizes a structured report. Runs in-process through
// pi-agent-runner; seats are the agents `councillor-<seat>` (agents/*.md).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAgentDir, parseFrontmatter } from '@earendil-works/pi-coding-agent';
import {
  runAgent,
  type ParentContext,
  type RunAgentResult,
  type RunStatus,
  type ThinkingLevel,
} from 'pi-agent-runner';

export const SEATS = ['alpha', 'beta', 'gamma'] as const;
export type Seat = (typeof SEATS)[number];

export const COUNCIL_AGENT = 'council';
export const councillorAgent = (seat: Seat): string => `councillor-${seat}`;

const THINKING_LEVELS: readonly string[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

const PACKAGE_AGENTS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'agents',
);

export interface CouncilAgent {
  name: string;
  prompt: string;
  model?: string;
  thinking?: ThinkingLevel;
  timeoutMs?: number;
}

// Directories searched in order: the user override, then the package.
export const defaultAgentDirs = (): string[] => [
  join(getAgentDir(), 'agents'),
  PACKAGE_AGENTS_DIR,
];

export const loadCouncilAgent = (
  name: string,
  dirs: readonly string[] = defaultAgentDirs(),
): CouncilAgent => {
  let file: string | undefined;
  let raw = '';
  for (const dir of dirs) {
    const candidate = join(dir, `${name}.md`);
    try {
      raw = readFileSync(candidate, 'utf8');
      file = candidate;
      break;
    } catch {
      // try the next directory
    }
  }
  if (!file) {
    throw new Error(`agent file ${name}.md not found in ${dirs.join(', ')}`);
  }
  const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(raw);
  const agent: CouncilAgent = { name, prompt: body.trim() };
  const { model, thinking, timeoutMs } = frontmatter;
  if (model !== undefined) {
    if (typeof model !== 'string' || !model.trim()) {
      throw new Error(`${file}: model must be a non-empty string`);
    }
    agent.model = model.trim();
  }
  if (thinking !== undefined) {
    if (typeof thinking !== 'string' || !THINKING_LEVELS.includes(thinking)) {
      throw new Error(
        `${file}: thinking must be one of ${THINKING_LEVELS.join('|')}`,
      );
    }
    agent.thinking = thinking as ThinkingLevel;
  }
  if (timeoutMs !== undefined) {
    if (typeof timeoutMs !== 'number' || !(timeoutMs > 0)) {
      throw new Error(`${file}: timeoutMs must be a positive number`);
    }
    agent.timeoutMs = timeoutMs;
  }
  return agent;
};

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
}

export interface SeatResult {
  seat: Seat;
  agent: string;
  model?: string;
  status: RunStatus;
  // answer text, or the failure reason
  text: string;
  ok: boolean;
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

const failureText = (response: RunAgentResult): string =>
  response.status + (response.error ? `: ${response.error}` : '');

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

  let seatAgents: CouncilAgent[];
  let synthesizer: CouncilAgent;
  try {
    seatAgents = seats.map((seat) =>
      loadCouncilAgent(councillorAgent(seat), options.agentDirs),
    );
    synthesizer = loadCouncilAgent(COUNCIL_AGENT, options.agentDirs);
  } catch (error) {
    return result('failed', [], '', errorText(error));
  }
  const start = (agent: CouncilAgent, task: string, tools: string[]) =>
    run({
      parent: options.parent,
      cwd: options.cwd,
      systemPrompt: agent.prompt,
      task,
      tools,
      model: agent.model ?? 'inherit',
      thinking: agent.thinking,
      extensions: 'none',
      result: { kind: 'text' },
      timeoutMs: options.timeoutMs ?? agent.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal: options.signal,
    });

  options.onProgress?.(`council: asking ${seats.join(', ')} in parallel`);
  let seatResults: SeatResult[];
  try {
    const answers = await Promise.all(
      seatAgents.map((agent) =>
        start(
          agent,
          buildCouncillorTask(options.question, options.context),
          SEAT_TOOLS,
        ),
      ),
    );
    responses.push(...answers);
    seatResults = seats.map((seat, index) => {
      const response = answers[index];
      const ok =
        response.status === 'completed' && typeof response.value === 'string';
      return {
        seat,
        agent: councillorAgent(seat),
        model: response.model,
        status: response.status,
        text: ok ? (response.value as string).trim() : failureText(response),
        ok,
      };
    });
  } catch (error) {
    return result('failed', [], '', errorText(error));
  }
  for (const seat of seatResults) {
    options.onProgress?.(`council: ${seat.seat} ${seat.status}`);
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
  let synthesis: RunAgentResult;
  try {
    synthesis = await start(
      synthesizer,
      buildCouncilTask(options.question, options.context, seatResults),
      [],
    );
  } catch (error) {
    return result('failed', seatResults, '', errorText(error));
  }
  responses.push(synthesis);
  if (synthesis.status === 'cancelled') {
    return result('aborted', seatResults, '');
  }
  if (synthesis.status !== 'completed' || typeof synthesis.value !== 'string') {
    return result(
      'failed',
      seatResults,
      '',
      `council synthesis ${failureText(synthesis)}`,
    );
  }
  return result('completed', seatResults, synthesis.value.trim());
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
