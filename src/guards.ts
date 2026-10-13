// Tool guards, ported from oh-my-opencode-slim (json-error-recovery and
// tool-loop-guard hooks). One factory instance serves exactly one session;
// state is per instance. It is loaded into the parent session and may be
// loaded into child agents too.
//
//   - JSON error recovery: appends a reminder to tool results that report
//     unparsable JSON arguments.
//   - Loop guard: warns when the same call keeps returning the same output,
//     refuses read-only calls once the loop is confirmed, and bounds
//     supervision polling and repeated wait_for_user calls.
//
// Counters only advance in tool_result (the output is known there), never
// in tool_call, so overlapping parallel calls cannot inflate a run.

import type {
  ExtensionAPI,
  ExtensionFactory,
} from '@earendil-works/pi-coding-agent';
import { pathGuards } from './paths.ts';

/* eslint-disable max-len, consistent-return */
// max-len: model-facing texts keep slim's wording on single lines.
// consistent-return: Pi treats a bare undefined as "no change"; returning {}
// from tool_result would drop structuredContent.

type Part = { type: string; text?: string };

export const JSON_ERROR_TOOL_EXCLUDE_LIST = [
  'bash',
  'read',
  'fetch_content',
  'web_search',
] as const;

export const JSON_ERROR_PATTERNS = [
  /json parse error/i,
  /failed to parse json/i,
  /invalid json/i,
  /malformed json/i,
  /unexpected end of json input/i,
  /syntaxerror:\s*unexpected token.*json/i,
  /json[^\n]*expected '\}'/i,
  /json[^\n]*unexpected eof/i,
] as const;

export const JSON_ERROR_REMINDER_MARKER =
  '[JSON PARSE ERROR - IMMEDIATE ACTION REQUIRED]';

export const JSON_ERROR_REMINDER = `
[JSON PARSE ERROR - IMMEDIATE ACTION REQUIRED]

You sent invalid JSON arguments. The system could not parse your tool call.
STOP and do this NOW:

1. LOOK at the error message above to see what was expected vs what you sent.
2. CORRECT your JSON syntax (missing braces, unescaped quotes, trailing commas, etc).
3. RETRY the tool call with valid JSON.

DO NOT repeat the exact same invalid call.
`;

export const LOOP_GUARD_WARN_AT = 3;
export const LOOP_GUARD_BLOCK_AT = 5;
export const WAIT_GUARD_WARN_AT = 2;
export const WAIT_GUARD_BLOCK_AT = 2;

// Max entries per tracking map before FIFO eviction.
export const MAX_TRACKED = 512;

export const WAIT_GUARD_MARKER = '[REPEATED WAIT TOOL - END TURN]';

export const WAIT_GUARD_WARNING = `
${WAIT_GUARD_MARKER}

You have already called a wait tool ${WAIT_GUARD_WARN_AT} times in this turn. Its result instructed you to end the turn — do not call it again.

STOP calling tools. Respond to the user in plain text and end your turn. The next distinct external user message resumes normal continuation.
`;

export const LOOP_GUARD_MARKER = '[REPEATED TOOL CALLS - STOP]';

export const LOOP_GUARD_WARNING = `
${LOOP_GUARD_MARKER}

You have issued the exact same tool call with identical arguments ${LOOP_GUARD_WARN_AT} times in a row and received identical results. This is an infinite loop and you are making no progress.

STOP repeating this call. Instead:
1. Reconsider what you are looking for; the result above already contains what this call can tell you.
2. If you need different information, make a DIFFERENT call (different path, pattern, or tool).
3. If the task is actually done, produce your final answer now instead of calling more tools.
`;

// Long-lived lifecycle tools whose identical repeated invocation is legitimate.
export const LOOP_GUARD_EXEMPT = new Set([
  'agent',
  'agent_cancel',
  'agent_message',
  'agent_revive',
  'council',
]);

// Only read-only tools hard-block after a confirmed identical run.
export const LOOP_GUARD_BLOCK_TOOLS = new Set([
  'read',
  'grep',
  'find',
  'ls',
  'ffgrep',
  'fffind',
]);

export const SUPERVISION_TOOLS = new Set(['agent_status', 'agent_result']);
export const WAIT_TOOLS = new Set(['wait_for_user']);

const EXCLUDED_FROM_JSON_RECOVERY = new Set<string>(
  JSON_ERROR_TOOL_EXCLUDE_LIST,
);

const VALIDATION_FAILURE =
  /^Validation failed for tool "[^"]*":[\s\S]*\n\nReceived arguments:\n\s*\{\s*\}\s*$/;

// Pi falls back to {} for unparsable streamed arguments, so a validation
// failure that received no arguments at all means the JSON was unparsable.
// Pi never runs tool_result handlers for validation failures, so these are
// recovered request-locally in the context pass.
export const isUnparsableArgsFailure = (text: string): boolean =>
  VALIDATION_FAILURE.test(text);

export const hasJsonError = (text: string): boolean =>
  JSON_ERROR_PATTERNS.some((pattern) => pattern.test(text));

const textOf = (content: readonly Part[]): string =>
  content
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');

// Returns messages with the reminder appended to JSON-error tool results;
// undefined when nothing changed. Never mutates its input.
export const remindJsonErrors = <M extends object>(
  messages: readonly M[],
): M[] | undefined => {
  let changed = false;
  const out = messages.map((message) => {
    // SAFETY: only reads optional fields and checks each before use; any
    // message without them is returned unchanged.
    const m = message as unknown as {
      role?: string;
      toolName?: string;
      isError?: boolean;
      content?: Part[];
    };
    if (m.role !== 'toolResult' || !m.isError || !Array.isArray(m.content)) {
      return message;
    }
    const text = textOf(m.content);
    if (text.includes(JSON_ERROR_REMINDER_MARKER)) return message;
    const excluded = EXCLUDED_FROM_JSON_RECOVERY.has(
      (m.toolName ?? '').toLowerCase(),
    );
    if (!isUnparsableArgsFailure(text) && (excluded || !hasJsonError(text))) {
      return message;
    }
    changed = true;
    return {
      ...message,
      content: [...m.content, { type: 'text', text: JSON_ERROR_REMINDER }],
    };
  });
  return changed ? out : undefined;
};

export const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`)
    .join(',')}}`;
};

export const fingerprint = (tool: string, args: unknown): string =>
  `${tool.toLowerCase()}:${stableStringify(args)}`;

// Run id from supervision output: `run r-xxxx (fixer) running, ...` or
// `run r-xxxx is still running (...)`.
export const runIdFromOutput = (text: string): string | undefined =>
  text.match(/^run\s+(\S+)/m)?.[1];

export const lifecycleStateFromOutput = (text: string): string | undefined => {
  if (/^run\s+\S+\s+is still running\b/m.test(text)) return 'running';
  return text.match(/^run\s+\S+\s+\([^)]*\)\s+([\w-]+),/m)?.[1]?.toLowerCase();
};

const runIdFromArgs = (input: unknown): string | undefined => {
  if (!input || typeof input !== 'object') return undefined;
  const id = (input as Record<string, unknown>).id;
  return typeof id === 'string' && id.trim() !== '' ? id.trim() : undefined;
};

const bounded = <V>(map: Map<string, V>): void => {
  while (map.size > MAX_TRACKED) {
    map.delete(map.keys().next().value as string);
  }
};

interface Pending {
  kind: 'wait' | 'supervision' | 'normal';
  key: string;
  runId?: string;
}

export const toolGuards: ExtensionFactory = (pi: ExtensionAPI): void => {
  // calls that passed tool_call and await their tool_result
  const pending = new Map<string, Pending>();
  let last: { key: string; output: string; runs: number } | undefined;
  const supervision = new Map<string, { state: string; runs: number }>();
  let waitRuns = 0;

  const resetTurn = (): void => {
    supervision.clear();
    waitRuns = 0;
  };

  pi.on('session_start', () => {
    pending.clear();
    last = undefined;
    resetTurn();
  });
  pi.on('input', (event) => {
    if (event.source !== 'extension') resetTurn();
    return { action: 'continue' };
  });
  pi.on('agent_end', () => {
    resetTurn();
  });

  // request-local: the reminder is never persisted into the session
  pi.on('context', (event) => {
    const messages = remindJsonErrors(event.messages);
    return messages ? { messages } : undefined;
  });

  pi.on('tool_call', (event) => {
    const tool = event.toolName.toLowerCase();
    const id = event.toolCallId;

    if (WAIT_TOOLS.has(tool)) {
      supervision.clear();
      if (waitRuns >= WAIT_GUARD_BLOCK_AT) {
        return {
          block: true,
          reason: `Refusing to execute "${tool}": a wait tool has already completed ${waitRuns} times this turn and instructed you to end the turn. Do not call any more tools. Respond to the user in plain text and end your turn.`,
        };
      }
      pending.set(id, { kind: 'wait', key: tool });
      bounded(pending);
      return undefined;
    }

    if (LOOP_GUARD_EXEMPT.has(tool)) {
      supervision.clear();
      return undefined;
    }

    const key = fingerprint(tool, event.input);
    if (SUPERVISION_TOOLS.has(tool)) {
      pending.set(id, {
        kind: 'supervision',
        key,
        runId: runIdFromArgs(event.input),
      });
      bounded(pending);
      return undefined;
    }

    // a non-polling call is a meaningful action: restart supervision
    supervision.clear();
    // refuse only a CONFIRMED identical run of a read-only tool
    if (
      last &&
      last.key === key &&
      last.runs >= LOOP_GUARD_BLOCK_AT &&
      LOOP_GUARD_BLOCK_TOOLS.has(tool)
    ) {
      return {
        block: true,
        reason: `Refusing to execute "${tool}": this exact call (same tool, same arguments) has returned identical results ${last.runs} times in a row and constitutes an infinite loop. Stop repeating it. Reassess your goal, make a different call, or produce your final answer.`,
      };
    }
    pending.set(id, { kind: 'normal', key });
    bounded(pending);
    return undefined;
  });

  pi.on('tool_result', (event) => {
    const tool = event.toolName.toLowerCase();
    const text = textOf(event.content);
    const warnings: string[] = [];

    if (
      !EXCLUDED_FROM_JSON_RECOVERY.has(tool) &&
      !text.includes(JSON_ERROR_REMINDER_MARKER) &&
      hasJsonError(text)
    ) {
      warnings.push(JSON_ERROR_REMINDER);
    }

    const call = pending.get(event.toolCallId);
    pending.delete(event.toolCallId);
    // a result without a matching tool_call is stale or exempt
    if (call && !LOOP_GUARD_EXEMPT.has(tool)) {
      if (call.kind === 'wait') {
        waitRuns += 1;
        if (
          waitRuns >= WAIT_GUARD_WARN_AT &&
          !text.includes(WAIT_GUARD_MARKER)
        ) {
          warnings.push(WAIT_GUARD_WARNING);
        }
      } else if (call.kind === 'supervision') {
        const runId = runIdFromOutput(text) ?? call.runId;
        const lifecycle = lifecycleStateFromOutput(text);
        if (runId && lifecycle) {
          const previous = supervision.get(runId);
          const runs = previous?.state === lifecycle ? previous.runs + 1 : 1;
          supervision.set(runId, { state: lifecycle, runs });
          bounded(supervision);
          if (runs >= LOOP_GUARD_WARN_AT && !text.includes(LOOP_GUARD_MARKER)) {
            warnings.push(LOOP_GUARD_WARNING);
          }
        }
      } else {
        const output = fingerprint(tool, text);
        const same = last?.key === call.key;
        const runs = same && last?.output === output ? last.runs + 1 : 1;
        last = { key: call.key, output, runs };
        if (runs >= LOOP_GUARD_WARN_AT && !text.includes(LOOP_GUARD_MARKER)) {
          warnings.push(LOOP_GUARD_WARNING);
        }
      }
    }

    if (warnings.length === 0) return undefined;
    return {
      content: [
        ...event.content,
        ...warnings.map((warning) => ({
          type: 'text' as const,
          text: warning,
        })),
      ],
    };
  });
};

// Every guard Opium loads into a session: the parent, each child agent and
// each council seat. Path rescue runs before the loop guard sees the call.
export const sessionGuards: ExtensionFactory[] = [pathGuards, toolGuards];
