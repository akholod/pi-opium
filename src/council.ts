// Multi-model council (oh-my-opencode-slim): councillors answer the same
// question independently and in parallel, then the council agent
// synthesizes a structured report. Runs through the pi-subagents
// delegation contract; seats are the user agents `councillor-<seat>`.

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { delegate, type DelegationResponse } from './delegation.ts';

export const SEATS = ['alpha', 'beta', 'gamma'] as const;
export type Seat = (typeof SEATS)[number];

export const COUNCIL_AGENT = 'council';
export const councillorAgent = (seat: Seat): string => `councillor-${seat}`;

export type Delegate = typeof delegate;

export interface CouncilOptions {
  pi: ExtensionAPI;
  cwd: string;
  question: string;
  // extra context the caller already has (paths, constraints)
  context?: string;
  seats?: readonly Seat[];
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  delegateFn?: Delegate;
}

export interface SeatResult {
  seat: Seat;
  agent: string;
  model?: string;
  status: DelegationResponse['status'];
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

const failureText = (response: DelegationResponse): string =>
  response.status + (response.error ? `: ${response.error}` : '');

const usageOf = (responses: DelegationResponse[]): CouncilUsage => {
  const usage: CouncilUsage = { cost: 0, input: 0, output: 0, runs: 0 };
  for (const response of responses) {
    if (!response.usage) continue;
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

const CANCELLED = new Set(['cancelled', 'interrupted']);

export const runCouncil = async (
  options: CouncilOptions,
): Promise<CouncilResult> => {
  const run = options.delegateFn ?? delegate;
  const seats = options.seats ?? SEATS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ownerRunId = crypto.randomUUID();
  const responses: DelegationResponse[] = [];
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

  options.onProgress?.(`council: asking ${seats.join(', ')} in parallel`);
  let seatResults: SeatResult[];
  try {
    const answers = await Promise.all(
      seats.map((seat) =>
        run(options.pi, {
          ownerRunId,
          nodeId: `council-${seat}`,
          agent: councillorAgent(seat),
          task: buildCouncillorTask(options.question, options.context),
          cwd: options.cwd,
          timeoutMs,
          result: { kind: 'text' },
          signal: options.signal,
        }),
      ),
    );
    responses.push(...answers);
    seatResults = seats.map((seat, index) => {
      const response = answers[index];
      const ok =
        response.status === 'completed' && response.result?.kind === 'text';
      return {
        seat,
        agent: councillorAgent(seat),
        model: response.model,
        status: response.status,
        text:
          ok && response.result?.kind === 'text'
            ? response.result.text.trim()
            : failureText(response),
        ok,
      };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return result('failed', [], '', message);
  }
  for (const seat of seatResults) {
    options.onProgress?.(`council: ${seat.seat} ${seat.status}`);
  }
  if (
    options.signal?.aborted ||
    seatResults.some((s) => CANCELLED.has(s.status))
  ) {
    return result('aborted', seatResults, '');
  }
  if (!seatResults.some((s) => s.ok)) {
    return result('failed', seatResults, '', 'no councillor answered');
  }

  options.onProgress?.('council: synthesizing');
  let synthesis: DelegationResponse;
  try {
    synthesis = await run(options.pi, {
      ownerRunId,
      nodeId: 'council-synthesis',
      agent: COUNCIL_AGENT,
      task: buildCouncilTask(options.question, options.context, seatResults),
      cwd: options.cwd,
      timeoutMs,
      result: { kind: 'text' },
      signal: options.signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return result('failed', seatResults, '', message);
  }
  responses.push(synthesis);
  if (CANCELLED.has(synthesis.status)) {
    return result('aborted', seatResults, '');
  }
  if (synthesis.status !== 'completed' || synthesis.result?.kind !== 'text') {
    return result(
      'failed',
      seatResults,
      '',
      `council synthesis ${failureText(synthesis)}`,
    );
  }
  return result('completed', seatResults, synthesis.result.text.trim());
};

// Fallback rendering when synthesis failed but councillors answered.
export const renderSeats = (seats: SeatResult[]): string =>
  seats
    .map(
      (seat) =>
        `## Councillor ${seat.seat}${seat.model ? ` (${seat.model})` : ''}\n\n${seat.ok ? seat.text : `[no answer: ${seat.text}]`}`,
    )
    .join('\n\n');
