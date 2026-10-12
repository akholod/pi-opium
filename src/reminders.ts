// Request-local reminders appended to user messages (ported from
// oh-my-opencode-slim's phase-reminder and council-inject hooks).
//
// Cache safety: injection is a pure function of the messages. Every user
// message gets the same bytes at the same position on every request, so the
// provider prompt-cache prefix stays stable; nothing is kept in memory.

import type { ContextEvent } from '@earendil-works/pi-coding-agent';

type AgentMessage = ContextEvent['messages'][number];

export const PHASE_REMINDER = [
  '<system-reminder>',
  '!IMPORTANT! Scheduler workflow: pick the lightest workflow that fits. ' +
    'Direct work: execute and verify proportionately. Otherwise: plan ' +
    'lanes → dispatch background specialists → track run ids → await ' +
    'delivered results → reconcile terminal results → verify. !END!',
  '</system-reminder>',
].join('\n');

export const COUNCIL_MODE_BLOCK = [
  '<system-reminder>',
  '## Council Mode',
  'The user asks for a council or consensus. Instead of answering alone:',
  '1. If the question references external resources (PR, URL, docs, ' +
    'files), gather them FIRST and put a concise summary into the ' +
    'question — councillors are read-only and see only what you send.',
  '2. Call the `council` tool once with the full question and that ' +
    'context; it asks every seat in parallel and synthesizes.',
  '3. Present its report with Council Response, Per-Councillor Details ' +
    'and Council Summary; failed seats are marked, never omitted.',
  '</system-reminder>',
].join('\n');

// Recall-biased: a false positive only adds the block once. ASCII words use
// \b (covers "@council"); CJK and Russian use plain substring matching
// because JS \b is ASCII-only.
const COUNCIL_TRIGGER_PATTERN = new RegExp(
  [
    '\\b(?:councillors?|councils?|consensus|second opinions?|roundtable|' +
      'multiple opinions|multiple models|several models|multi-model)\\b',
    '议会|顾问团|圆桌|共识|第二意见|多方意见|多模型|多个模型|几个模型|' +
      '别的模型|其他模型',
    'совет моделей|консенсус|второе мнение|несколько моделей|' +
      'мнения разных моделей',
  ].join('|'),
  'i',
);

const CODE_FENCE_PATTERN = /```[\s\S]*?```/g;
const INLINE_CODE_PATTERN = /`[^`\n]*`/g;
const SLASH_COMMAND_LEAD_PATTERN = /^\s*\/[a-zA-Z][\w-]*(?:\s|$)/;

const stripCode = (text: string): string =>
  text.replace(CODE_FENCE_PATTERN, ' ').replace(INLINE_CODE_PATTERN, ' ');

export const matchesCouncilTrigger = (text: string): boolean => {
  const clean = stripCode(text);
  if (SLASH_COMMAND_LEAD_PATTERN.test(clean)) return false;
  return COUNCIL_TRIGGER_PATTERN.test(clean);
};

type Part = { type: string; text?: string };

const isOwnPart = (part: Part): boolean =>
  part.type === 'text' &&
  (part.text === PHASE_REMINDER || part.text === COUNCIL_MODE_BLOCK);

const injectInto = (message: AgentMessage): AgentMessage => {
  if (message.role !== 'user') return message;
  const parts: Part[] =
    typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : message.content;
  const has = (text: string) => parts.some((p) => p.text === text);
  const texts = parts
    .filter((p) => p.type === 'text' && !isOwnPart(p))
    .map((p) => p.text ?? '');
  // the slash-command gate applies to the first text part, the trigger
  // scan to every text part
  const slash =
    texts.length > 0 && SLASH_COMMAND_LEAD_PATTERN.test(stripCode(texts[0]));
  const council =
    !slash && !has(COUNCIL_MODE_BLOCK) && texts.some(matchesCouncilTrigger);
  const phase = !has(PHASE_REMINDER);
  if (!phase && !council) return message;
  const added: Part[] = [];
  if (phase) added.push({ type: 'text', text: PHASE_REMINDER });
  if (council) added.push({ type: 'text', text: COUNCIL_MODE_BLOCK });
  return {
    ...message,
    content: [...parts, ...added],
  } as AgentMessage;
};

export const injectReminders = (messages: AgentMessage[]): AgentMessage[] =>
  messages.map(injectInto);
