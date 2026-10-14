/* eslint-disable max-len */
// max-len: model-facing prompt lines stay on single lines.
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';

const DEFAULT_LAST = 50;
const MAX_LAST = 100;
const MAX_ENTRY_TEXT = 200;
const MAX_DIGEST_CHARS = 12_000;

export interface WorkflowCommandOptions {
  /** Default number of session entries digested by /reflect. */
  defaultLast?: number;
  /** Upper bound for /reflect --last. */
  maxLast?: number;
}

type SessionLike = Pick<
  ExtensionCommandContext['sessionManager'],
  'getBranch' | 'getSessionFile' | 'getSessionId'
>;

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const partsText = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part: { type?: string; text?: string; name?: string }) => {
      if (part?.type === 'text') return part.text ?? '';
      if (part?.type === 'toolCall') return `[call ${part.name ?? '?'}]`;
      return '';
    })
    .filter(Boolean)
    .join(' ');
};

/** One compact line per session entry; null for non-message entries. */
const describeEntry = (entry: unknown): string | null => {
  const e = entry as { type?: string; message?: Record<string, unknown> };
  if (e?.type !== 'message' || !e.message) return null;
  const m = e.message;
  const role = String(m.role ?? '?');
  const tool = typeof m.toolName === 'string' ? ` ${m.toolName}` : '';
  const text = clip(partsText(m.content), MAX_ENTRY_TEXT);
  return `- ${role}${tool}: ${text}`;
};

/**
 * Compact, bounded digest of the last `last` entries of the current session
 * branch. Keeps the newest lines when the size cap is hit.
 */
export function buildSessionDigest(
  session: SessionLike | undefined,
  last: number,
): string {
  let entries: unknown[];
  try {
    entries = session?.getBranch() ?? [];
  } catch {
    entries = [];
  }
  const lines = entries
    .slice(-last)
    .map(describeEntry)
    .filter((l): l is string => l !== null);
  const kept: string[] = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    size += lines[i].length + 1;
    if (size > MAX_DIGEST_CHARS) break;
    kept.unshift(lines[i]);
  }
  const omitted = lines.length - kept.length;
  const header = `Session digest (last ${last} entries of the current branch${
    omitted > 0 ? `, ${omitted} older lines omitted for size` : ''
  }):`;
  const file = session?.getSessionFile();
  const tail = file ? [`Full session file: ${file}`] : [];
  return [header, ...(kept.length ? kept : ['(no messages)']), ...tail].join(
    '\n',
  );
}

export function parseReflectArgs(
  args: string,
  defaultLast = DEFAULT_LAST,
  maxLast = MAX_LAST,
): { focus: string; last: number } {
  const trimmed = args.trim();
  const match = trimmed.match(/--last\s+(\d+)/);
  const parsed = match ? parseInt(match[1], 10) : defaultLast;
  const last = Math.max(1, Math.min(parsed, maxLast));
  const focus = trimmed.replace(/--last\s+\d+/g, '').trim();
  return { focus, last };
}

export function reflectPrompt(
  focus: string,
  digest: string,
  last: number,
): string {
  const focusBlock = focus
    ? ['Focus:', focus]
    : [
        'Focus:',
        'Review recent work broadly and identify repeated workflow friction worth improving.',
      ];
  return [
    'Reflect on how this session has been working and suggest workflow improvements.',
    '',
    'Reflect requirements:',
    '- inspect existing skills, prompts, agents/ role prompts, commands, MCP permissions, config, and project playbooks (AGENTS.md, .opium/) before suggesting anything new;',
    '- base findings on evidence in the digest below, the current conversation, project notes, or other artifacts that are safe to inspect; prefer repeated recent behavior over speculation;',
    '- look at how Opium tools were used: agent, agent_status, agent_result, agent_message, agent_cancel, agent_revive, council, wait_for_user; at specialist choice (scout, researcher, senior, designer, fixer, fast-generic, vision); and at Spiral flows (/ralplan, /ralph) — flag wrong delegation, wasted waits, repeated manual steps, missed reviews;',
    '- recommend the smallest useful improvement: prompt/config rule, skill, command, custom agent, MCP/tool permission change, project playbook, or skip;',
    '- change nothing is a valid result when evidence is weak;',
    '- ask before changing prompts, skills, commands, agents, MCP access, or config unless the user explicitly requested the exact edit;',
    '- return a compact report with findings, recommended changes, skipped candidates, and items needing more evidence.',
    '',
    ...focusBlock,
    '',
    `Scope: the last ${last} session entries (use --last N to adjust, max ${MAX_LAST}).`,
    '',
    digest,
  ].join('\n');
}

export function deepworkStatePath(sessionId: string): string {
  return `.opium/deepwork/${sessionId}.md`;
}

export function deepworkPrompt(task: string, sessionId: string): string {
  return [
    'Use the `deepwork` skill for this task: load it and follow it for setup, planning, gates, and state rules.',
    '',
    `Your deepwork router head is \`${deepworkStatePath(sessionId)}\`.`,
    '',
    'Task:',
    task,
  ].join('\n');
}

export function registerWorkflowCommands(
  pi: ExtensionAPI,
  options: WorkflowCommandOptions = {},
): void {
  const defaultLast = options.defaultLast ?? DEFAULT_LAST;
  const maxLast = options.maxLast ?? MAX_LAST;

  pi.registerCommand('reflect', {
    description: 'Review repeated work and suggest workflow improvements',
    handler: async (args, ctx) => {
      const { focus, last } = parseReflectArgs(args, defaultLast, maxLast);
      const digest = buildSessionDigest(ctx.sessionManager, last);
      pi.sendUserMessage(reflectPrompt(focus, digest, last));
    },
  });

  pi.registerCommand('deepwork', {
    description: 'Start a deepwork session for a complex coding task',
    handler: async (args, ctx) => {
      const task = args.trim();
      if (!task) {
        ctx.ui.notify(
          'What task should deepwork manage? Run `/deepwork <task>`.',
          'info',
        );
        return;
      }
      pi.sendUserMessage(
        deepworkPrompt(task, ctx.sessionManager.getSessionId()),
      );
    },
  });
}
