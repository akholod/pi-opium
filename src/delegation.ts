// Local copy of the pi-subagents structured delegation contract.
// pi-subagents is a separately installed pi package, not a node dependency,
// so we speak the event protocol directly instead of importing
// `pi-subagents/delegation`. Keep in sync with
// ~/.pi/agent/npm/node_modules/pi-subagents/src/api/delegation.d.ts.

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
export type ThinkingLevel =
  'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const DELEGATION_REQUEST_EVENT = 'prompt-template:subagent:request';
export const DELEGATION_STARTED_EVENT = 'prompt-template:subagent:started';
export const DELEGATION_RESPONSE_EVENT = 'prompt-template:subagent:response';

// If neither a `started` nor a `response` event arrives within this window
// nobody is handling delegation requests (pi-subagents missing or broken).
const START_TIMEOUT_MS = 30_000;
export const DELEGATION_UPDATE_EVENT = 'prompt-template:subagent:update';
export const DELEGATION_CANCEL_EVENT = 'prompt-template:subagent:cancel';

export type DelegationResultRequest =
  { kind: 'text' } | { kind: 'structured'; schema: Record<string, unknown> };

export interface DelegationRequest {
  requestId: string;
  ownerRunId: string;
  nodeId: string;
  agent: string;
  task: string;
  context: 'fresh' | 'fork';
  cwd: string;
  model?: string;
  thinking?: ThinkingLevel;
  timeoutMs?: number;
  toolBudget?: { soft?: number; hard: number; block?: string[] | '*' };
  artifacts?: boolean;
  result: DelegationResultRequest;
}

export type DelegationStatus =
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'cancelled'
  | 'interrupted'
  | 'tool_budget_exhausted'
  | 'structured_output_failed'
  | 'acceptance_failed'
  | 'invalid_request'
  | 'unavailable_context'
  | 'duplicate_node';

export type DelegationValue =
  { kind: 'text'; text: string } | { kind: 'structured'; value: unknown };

export interface DelegationUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
  toolCalls: number;
  durationMs: number;
}

export interface DelegationResponse {
  requestId: string;
  ownerRunId?: string;
  nodeId?: string;
  status: DelegationStatus;
  error?: string;
  runId?: string;
  model?: string;
  thinking?: string;
  result?: DelegationValue;
  usage?: DelegationUsage;
}

export interface DelegationIdentity {
  requestId: string;
  ownerRunId?: string;
  nodeId?: string;
}

export interface DelegationUpdate extends DelegationIdentity {
  currentTool?: string;
  recentOutput?: string;
  durationMs?: number;
  tokens?: number;
}

export interface DelegateOptions {
  ownerRunId: string;
  nodeId: string;
  agent: string;
  task: string;
  cwd: string;
  // omitted = the agent definition's model / thinking (frontmatter)
  model?: string;
  thinking?: ThinkingLevel;
  timeoutMs: number;
  result: DelegationResultRequest;
  signal?: AbortSignal;
  onUpdate?: (update: DelegationUpdate) => void;
}

// pi-subagents identifies an active delegation by ownerRunId + nodeId;
// requestId alone is not enough for a malformed-request response, which may
// carry only the identity fields it could parse. Match on all three.
const matches = (
  request: DelegationRequest,
  payload: DelegationIdentity,
): boolean =>
  payload.requestId === request.requestId &&
  (payload.ownerRunId === undefined ||
    payload.ownerRunId === request.ownerRunId) &&
  (payload.nodeId === undefined || payload.nodeId === request.nodeId);

const toRequest = (options: DelegateOptions): DelegationRequest => ({
  requestId: crypto.randomUUID(),
  ownerRunId: options.ownerRunId,
  nodeId: options.nodeId,
  agent: options.agent,
  task: options.task,
  context: 'fresh',
  cwd: options.cwd,
  model: options.model === 'inherit' ? undefined : options.model,
  thinking: options.thinking,
  timeoutMs: options.timeoutMs,
  artifacts: true,
  result: options.result,
});

// Runs one foreground child through pi-subagents and resolves with its
// terminal response. Rejects only when nobody handles the request; every
// other outcome is reported through `status`.
export const delegate = (
  pi: ExtensionAPI,
  options: DelegateOptions,
): Promise<DelegationResponse> =>
  new Promise((resolve, reject) => {
    const request = toRequest(options);

    // Already cancelled: do not launch a child at all.
    if (options.signal?.aborted) {
      resolve({
        requestId: request.requestId,
        ownerRunId: request.ownerRunId,
        nodeId: request.nodeId,
        status: 'cancelled',
        error: 'aborted before start',
      });
      return;
    }

    const startTimer = setTimeout(() => {
      cleanup();
      reject(new Error('pi-subagents did not pick up the delegation request'));
    }, START_TIMEOUT_MS);

    const offStarted = pi.events.on(DELEGATION_STARTED_EVENT, (payload) => {
      if (!matches(request, payload as DelegationIdentity)) return;
      clearTimeout(startTimer);
    });

    const offResponse = pi.events.on(DELEGATION_RESPONSE_EVENT, (payload) => {
      const response = payload as DelegationResponse;
      if (!matches(request, response)) return;
      cleanup();
      resolve(response);
    });

    const offUpdate = pi.events.on(DELEGATION_UPDATE_EVENT, (payload) => {
      const update = payload as DelegationUpdate;
      if (!matches(request, update)) return;
      options.onUpdate?.(update);
    });

    const onAbort = (): void => {
      pi.events.emit(DELEGATION_CANCEL_EVENT, {
        requestId: request.requestId,
        ownerRunId: request.ownerRunId,
        nodeId: request.nodeId,
      });
    };

    const cleanup = (): void => {
      clearTimeout(startTimer);
      offStarted();
      offResponse();
      offUpdate();
      options.signal?.removeEventListener('abort', onAbort);
    };

    options.signal?.addEventListener('abort', onAbort, { once: true });
    pi.events.emit(DELEGATION_REQUEST_EVENT, request);
  });
