import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
} from '@earendil-works/pi-coding-agent';
import {
  runAgent as realRunAgent,
  type ChildSession,
  type ChildSessionFactory,
  type ParentContext,
  type RunAgentOptions,
  type RunAgentResult,
} from 'pi-agent-runner';
import {
  loadAgent,
  loadAgents,
  type AgentDefinition,
  type AgentOverride,
} from '../src/agents.ts';
import { buildLaunch, type LaunchContext } from '../src/launch.ts';
import { sessionGuards } from '../src/guards.ts';
import { RunRegistry, type StartOptions } from '../src/runs.ts';
import { runAgent as agentTool, type ToolDeps } from '../src/tools.ts';
import {
  VISION_DISPATCH_LINE,
  VISION_DISPATCH_ROLES,
  VISION_REFUSAL,
  imageInput,
  modelSupportsImages,
  orchestratorAgents,
  supportsImages,
} from '../src/vision.ts';
import { NESTED_MAX_DEPTH, visionTool } from '../src/vision-tool.ts';
import { buildOrchestratorPrompt } from '../src/prompt.ts';
import { createOpium } from '../extensions/opium.ts';

const blind = { input: ['text'] };
const sighted = { input: ['text', 'image'] };

const registryWith = (models: Record<string, unknown>) =>
  ({
    find: (provider: string, id: string) => models[`${provider}/${id}`],
  }) as unknown as ExtensionContext['modelRegistry'];

test('supportsImages reads the declared input capability', () => {
  assert.equal(supportsImages(sighted), true);
  assert.equal(supportsImages(blind), false);
  assert.equal(supportsImages(undefined), undefined);
  assert.equal(supportsImages({}), undefined);
});

test('modelSupportsImages resolves inherit, provider/id and unknown', () => {
  const ctx = {
    model: sighted,
    modelRegistry: registryWith({
      'a/blind': blind,
      'a/deep/id': sighted,
    }),
  } as unknown as ExtensionContext;
  assert.equal(modelSupportsImages(ctx, 'inherit'), true);
  assert.equal(modelSupportsImages(ctx, undefined), true);
  assert.equal(modelSupportsImages(ctx, 'a/blind'), false);
  // the id keeps everything after the first slash
  assert.equal(modelSupportsImages(ctx, 'a/deep/id'), true);
  assert.equal(modelSupportsImages(ctx, 'a/missing'), undefined);
  assert.equal(modelSupportsImages(ctx, 'nonsense'), undefined);
  const throwing = {
    model: undefined,
    modelRegistry: {
      find: () => {
        throw new Error('boom');
      },
    },
  } as unknown as ExtensionContext;
  assert.equal(modelSupportsImages(throwing, 'a/b'), undefined);
  assert.equal(modelSupportsImages(throwing, 'inherit'), undefined);
});

test('orchestratorAgents drops vision only for a model that sees images', () => {
  const names = ['designer', 'scout', 'vision'];
  assert.deepEqual(orchestratorAgents(names, sighted), ['designer', 'scout']);
  assert.deepEqual(orchestratorAgents(names, blind), names);
  assert.deepEqual(orchestratorAgents(names, undefined), names);
});

test('the shipped roster lists vision for a blind model only', () => {
  const names = [...loadAgents().agents.values()]
    .filter((agent) => agent.advertise)
    .map((agent) => agent.name);
  assert.ok(names.includes('vision'));
  const listed = (model: unknown) =>
    buildOrchestratorPrompt({
      available: orchestratorAgents(names, model as never),
    }).includes('\nvision\n');
  assert.equal(listed(blind), true);
  assert.equal(listed(sighted), false);
});

// ---- input images ----

const PNG = Buffer.from('not really a png').toString('base64');

const inputCtx = (cwd: string, model: unknown) =>
  ({
    cwd,
    model,
    modelRegistry: registryWith({}),
    sessionManager: { getSessionId: () => 'sess-1', getBranch: () => [] },
  }) as unknown as ExtensionContext;

test('imageInput saves images for a blind model and rewrites the text', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'opium-vi-'));
  const image = { type: 'image', data: PNG, mimeType: 'image/png' };
  const result = imageInput(
    { text: 'what is this?', images: [image, image] },
    inputCtx(cwd, blind),
  );
  assert.ok(result);
  assert.equal(result.action, 'transform');
  assert.deepEqual(result.images, []);
  const dir = join(cwd, '.pi', 'opium', 'images', 'sess-1');
  const files = readdirSync(dir);
  // content-addressed: the duplicate is one file
  assert.equal(files.length, 1);
  assert.match(files[0] as string, /^[0-9a-f]{16}\.png$/);
  const path = join(dir, files[0] as string);
  assert.equal(
    result.text,
    `what is this?\n\nAttached image saved at ${path}. Your model cannot ` +
      'view images: delegate to the vision agent with this path and a ' +
      'precise goal.',
  );
});

test('imageInput treats an unknown capability as blind', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'opium-vi-'));
  const result = imageInput(
    { text: 't', images: [{ data: PNG, mimeType: 'image/jpeg' }] },
    inputCtx(cwd, {}),
  );
  assert.equal(result?.action, 'transform');
  assert.match(result?.text ?? '', /\.jpg\./);
});

test('imageInput leaves a sighted model, no images and no model alone', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'opium-vi-'));
  const image = { data: PNG, mimeType: 'image/png' };
  assert.equal(
    imageInput({ text: 't', images: [image] }, inputCtx(cwd, sighted)),
    undefined,
  );
  assert.equal(imageInput({ text: 't' }, inputCtx(cwd, blind)), undefined);
  assert.equal(
    imageInput({ text: 't', images: [] }, inputCtx(cwd, blind)),
    undefined,
  );
  assert.equal(
    imageInput({ text: 't', images: [image] }, inputCtx(cwd, undefined)),
    undefined,
  );
  assert.equal(existsSync(join(cwd, '.pi')), false);
});

test('imageInput leaves the input alone when the files cannot be written', () => {
  const cwd = join(mkdtempSync(join(tmpdir(), 'opium-vi-')), 'file');
  writeFileSync(cwd, 'a file, not a directory');
  const image = { data: PNG, mimeType: 'image/png' };
  assert.equal(
    imageInput({ text: 't', images: [image] }, inputCtx(cwd, blind)),
    undefined,
  );
});

// ---- extension wiring ----

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Tool = {
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ) => Promise<{ content: { text: string }[] }>;
};

const setup = () => {
  const home = mkdtempSync(join(tmpdir(), 'opium-vw-'));
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, Tool>();
  const pi = {
    events: { emit() {}, on: () => () => {} },
    on: (name: string, fn: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), fn]);
    },
    registerTool: (tool: Tool & { name: string }) => tools.set(tool.name, tool),
    registerCommand() {},
    appendEntry() {},
    sendMessage() {},
  } as unknown as ExtensionAPI;
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    createOpium(pi, { runsDir: join(home, 'runs') });
  } finally {
    process.env.HOME = previous;
  }
  const ctxFor = (model: unknown, cwd = home) =>
    inputCtx(cwd, model) as ExtensionContext;
  return {
    home,
    ctxFor,
    section: async (model: unknown): Promise<string | undefined> => {
      const event = {
        systemPromptOptions: { sections: {} as Record<string, string> },
      };
      for (const fn of handlers.get('before_agent_start') ?? []) {
        await fn(event, ctxFor(model));
      }
      return event.systemPromptOptions.sections.orchestrator;
    },
    input: async (event: unknown, model: unknown, cwd?: string) => {
      const results: unknown[] = [];
      for (const fn of handlers.get('input') ?? []) {
        results.push(await fn(event, ctxFor(model, cwd)));
      }
      // the guards' own handler answers `continue`
      return results.filter(
        (r) => (r as { action?: string } | undefined)?.action === 'transform',
      );
    },
    agent: (task: Record<string, unknown>, model: unknown) =>
      (tools.get('agent') as Tool).execute(
        'c',
        task,
        undefined,
        undefined,
        ctxFor(model),
      ),
  };
};

test('the orchestrator prompt lists vision only for a blind model', async () => {
  const opium = setup();
  const blindPrompt = await opium.section(blind);
  const sightedPrompt = await opium.section(sighted);
  assert.ok(blindPrompt?.includes('\nvision\n'));
  assert.ok(sightedPrompt && !sightedPrompt.includes('\nvision\n'));
  assert.ok(sightedPrompt.includes('\nscout\n'));
  // switching the model back brings it back
  assert.equal(await opium.section(blind), blindPrompt);
});

test('the agent tool refuses vision for a sighted model', async () => {
  const opium = setup();
  await assert.rejects(
    opium.agent({ agent: 'vision', task: 'look at x.png' }, sighted),
    (error: Error) =>
      error.message.includes(VISION_REFUSAL) &&
      error.message.includes('"vision"'),
  );
  // legacy name too
  await assert.rejects(
    opium.agent({ agent: 'observer', task: 'look at x.png' }, sighted),
    (error: Error) => error.message.includes(VISION_REFUSAL),
  );
  // a blind model passes the check (and fails later for another reason or
  // starts a run; here only the refusal matters)
  await assert.doesNotReject(async () => {
    try {
      await opium.agent({ agent: 'nosuch', task: 't' }, blind);
    } catch (error) {
      assert.match((error as Error).message, /unknown agent "nosuch"/);
      assert.ok(!(error as Error).message.includes('vision,'));
    }
  });
});

test('the agent tool lists vision as available for a blind model only', async () => {
  const opium = setup();
  await assert.rejects(
    opium.agent({ agent: 'nosuch', task: 't' }, blind),
    /available: .*\bvision\b/,
  );
  await assert.rejects(
    opium.agent({ agent: 'nosuch', task: 't' }, sighted),
    (error: Error) =>
      /available: /.test(error.message) && !/\bvision\b/.test(error.message),
  );
});

test('input images: saved and rewritten for a blind model, untouched otherwise', async () => {
  const opium = setup();
  const cwd = mkdtempSync(join(tmpdir(), 'opium-vi-'));
  const event = {
    type: 'input',
    text: 'look',
    source: 'interactive',
    images: [{ type: 'image', data: PNG, mimeType: 'image/png' }],
  };
  const results = (await opium.input(event, blind, cwd)) as {
    action: string;
    text: string;
    images: unknown[];
  }[];
  assert.equal(results.length, 1);
  assert.equal(results[0]?.action, 'transform');
  assert.deepEqual(results[0]?.images, []);
  assert.match(results[0]?.text ?? '', /Attached image saved at .*\.png/);
  assert.equal(existsSync(join(cwd, '.pi', 'opium', 'images', 'sess-1')), true);

  const other = mkdtempSync(join(tmpdir(), 'opium-vi-'));
  assert.deepEqual(await opium.input(event, sighted, other), []);
  assert.equal(existsSync(join(other, '.pi')), false);
  // extension-sourced input is not rewritten
  assert.deepEqual(
    await opium.input({ ...event, source: 'extension' }, blind, other),
    [],
  );
});

// ---- subagent dispatch ----

const agent = (
  name: string,
  fm = 'tools: read\n',
  override: AgentOverride = {},
): AgentDefinition => {
  const dir = mkdtempSync(join(tmpdir(), 'opium-vd-'));
  writeFileSync(join(dir, `${name}.md`), `---\ndescription: d\n${fm}---\nP\n`);
  return loadAgent(name, { dirs: [dir], overrides: { [name]: override } });
};

const parent = {} as ParentContext;
const factoryFor = (child: string): ExtensionFactory => {
  const factory: ExtensionFactory = () => undefined;
  Object.defineProperty(factory, 'child', { value: child });
  return factory;
};
const visionLaunch = (childSeesImages: boolean | undefined) =>
  ({
    parent,
    cwd: '/work',
    vision: { childSeesImages, tool: factoryFor },
  }) satisfies LaunchContext;

test('the four roles get the vision tool and line when blind', () => {
  assert.deepEqual([...VISION_DISPATCH_ROLES].sort(), [
    'designer',
    'researcher',
    'scout',
    'senior',
  ]);
  for (const role of VISION_DISPATCH_ROLES) {
    for (const seen of [false, undefined]) {
      const { start } = buildLaunch(agent(role), visionLaunch(seen));
      assert.deepEqual(start.tools, ['read', 'vision'], role);
      assert.ok(start.systemPrompt?.endsWith(`\n\n${VISION_DISPATCH_LINE}`));
      const factories = start.extensionFactories ?? [];
      assert.equal(factories.length, sessionGuards.length + 1);
      assert.deepEqual(factories.slice(0, sessionGuards.length), sessionGuards);
      assert.equal(
        (factories.at(-1) as unknown as { child: string }).child,
        role,
      );
    }
  }
});

test('a child without a tool list keeps it unset and still gets the line', () => {
  const { start } = buildLaunch(agent('designer', ''), visionLaunch(false));
  assert.equal(start.tools, undefined);
  assert.ok(start.systemPrompt?.includes(VISION_DISPATCH_LINE));
  assert.equal(start.extensionFactories?.length, sessionGuards.length + 1);
});

test('no vision tool or line when the child sees images', () => {
  for (const role of VISION_DISPATCH_ROLES) {
    const { start } = buildLaunch(agent(role), visionLaunch(true));
    assert.deepEqual(start.tools, ['read']);
    assert.equal(start.systemPrompt, 'P');
    assert.equal(start.extensionFactories, sessionGuards);
  }
});

test('no vision tool or line for the other roles or without vision', () => {
  for (const role of [
    'fixer',
    'fast-generic',
    'vision',
    'council',
    'councillor-alpha',
  ]) {
    const { start } = buildLaunch(agent(role), visionLaunch(false));
    assert.deepEqual(start.tools, ['read'], role);
    assert.equal(start.systemPrompt, 'P', role);
    assert.equal(start.extensionFactories, sessionGuards, role);
  }
  const { start } = buildLaunch(agent('scout'), { parent, cwd: '/work' });
  assert.deepEqual(start.tools, ['read']);
  assert.equal(start.extensionFactories, sessionGuards);
});

// ---- the nested run ----

const registerVision = (
  child: string,
  deps: Parameters<typeof visionTool>[1],
) => {
  const tools = new Map<string, Tool>();
  const pi = {
    events: { emit() {}, on: () => () => {} },
    registerTool: (tool: Tool & { name: string }) => tools.set(tool.name, tool),
  } as unknown as ExtensionAPI;
  void visionTool(child, deps)(pi);
  return { pi, tool: tools.get('vision') as Tool };
};

const visionDef = (): AgentDefinition =>
  agent('vision', 'tools: read\n', {
    model: 'x/seer',
    timeoutMs: 1234,
    thinking: 'low',
  });

const result = (over: Partial<RunAgentResult> = {}): RunAgentResult => ({
  status: 'completed',
  value: 'a red button',
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 1,
    toolCalls: 0,
    durationMs: 1,
    waitedMs: 0,
  },
  ...over,
});

test('the vision tool runs vision one level down under the child', async () => {
  const calls: RunAgentOptions[] = [];
  const { pi, tool } = registerVision('scout', {
    loadDef: (name) => {
      assert.equal(name, 'vision');
      return visionDef();
    },
    run: async (options) => {
      calls.push(options);
      return result();
    },
  });
  const childCtx = { cwd: '/child-cwd' } as unknown as ExtensionContext;
  const signal = new AbortController().signal;
  const out = await (
    tool.execute as unknown as (
      ...args: unknown[]
    ) => Promise<{ content: { text: string }[] }>
  )(
    'id',
    { path: 'shot.png', goal: 'read the error' },
    signal,
    undefined,
    childCtx,
  );
  assert.equal(out.content[0]?.text, 'a red button');
  assert.equal(calls.length, 1);
  const call = calls[0] as RunAgentOptions;
  assert.equal(call.maxDepth, NESTED_MAX_DEPTH);
  assert.equal(NESTED_MAX_DEPTH, 2);
  // the child's own events and context are the parent of the nested run
  assert.equal(call.parent.events, pi.events);
  assert.equal(call.parent.ctx, childCtx);
  assert.deepEqual(call.label, { name: 'vision', context: 'for scout' });
  assert.equal(call.cwd, '/child-cwd');
  assert.equal(call.signal, signal);
  assert.match(call.task, /shot\.png/);
  assert.match(call.task, /read the error/);
  // the vision agent's own tools, model and limits
  assert.deepEqual(call.tools, ['read']);
  assert.equal(call.model, 'x/seer');
  assert.equal(call.timeoutMs, 1234);
  assert.equal(call.thinking, 'low');
});

test('the vision tool reports a failed nested run as an error', async () => {
  const { tool } = registerVision('senior', {
    loadDef: visionDef,
    run: async () =>
      result({ status: 'timed_out', value: undefined, error: 'too slow' }),
  });
  await assert.rejects(
    tool.execute('id', { path: 'a.png', goal: 'g' }, undefined, undefined, {
      cwd: '/c',
    } as unknown as ExtensionContext),
    /vision timed_out: too slow/,
  );
});

// A scripted session: its prompt() runs `onPrompt` inside the generation, as
// a tool of a real child would run.
const sessionFactory = (
  onPrompt: (depthOf: string) => Promise<void>,
): ChildSessionFactory => ({
  create: async (spec) => {
    const messages: unknown[] = [];
    const session: ChildSession = {
      sessionId: `s-${spec.label ?? 'x'}`,
      modelId: 'fake/model',
      messages,
      subscribe: () => () => undefined,
      prompt: async () => {
        await onPrompt(spec.label ?? '');
        messages.push({
          role: 'assistant',
          stopReason: 'stop',
          content: [{ type: 'text', text: `done ${spec.label}` }],
        });
      },
      abort: async () => undefined,
      steer: async () => undefined,
      followUp: async () => undefined,
      clearQueue: () => ({ steering: [], followUp: [] }),
      dispose: async () => undefined,
    };
    return session;
  },
});

const fakeParent = {
  events: { emit() {}, on: () => () => undefined },
  ctx: {},
} as unknown as ParentContext;

const runOptions = (label: string, maxDepth?: number): RunAgentOptions => ({
  parent: fakeParent,
  cwd: tmpdir(),
  systemPrompt: 's',
  task: 't',
  label: { name: label },
  ...(maxDepth !== undefined && { maxDepth }),
});

// The runner's own depth logic: a tool running inside a child sees depth 1
// (the child's generation runs under depth 0 + 1).
test('a nested run from inside a child needs maxDepth 2', async () => {
  const nested: Record<string, RunAgentResult> = {};
  const leaf = sessionFactory(async () => undefined);
  const factory = sessionFactory(async (label) => {
    if (label !== 'outer') return;
    nested.default = await realRunAgent(runOptions('inner-default'), {
      factory: leaf,
    });
    nested.two = await realRunAgent(runOptions('inner-two', 2), {
      factory: leaf,
    });
  });
  const outer = await realRunAgent(runOptions('outer'), { factory });
  assert.equal(outer.status, 'completed');
  // default maxDepth 1: a child cannot start its own child
  assert.equal(nested.default?.status, 'failed');
  assert.match(
    nested.default?.error ?? '',
    /nesting limit reached: depth 1 >= maxDepth 1/,
  );
  // maxDepth 2 from inside the child is allowed
  assert.equal(nested.two?.status, 'completed');
  assert.equal(nested.two?.value, 'done inner-two');
});

test('the nested vision child cannot nest again', async () => {
  let deepest: RunAgentResult | undefined;
  const leaf = sessionFactory(async () => undefined);
  const factory = sessionFactory(async (label) => {
    if (label === 'outer') {
      await realRunAgent(runOptions('mid', 2), { factory });
    } else if (label === 'mid') {
      deepest = await realRunAgent(runOptions('deep', 2), { factory: leaf });
    }
  });
  await realRunAgent(runOptions('outer'), { factory });
  assert.equal(deepest?.status, 'failed');
  assert.match(deepest?.error ?? '', /depth 2 >= maxDepth 2/);
});

// ---- registry wiring ----

test('the registry still drives a launch with the vision options', async () => {
  // defaultStarter needs Pi; this only pins that ToolDeps stays usable with
  // `refuse` unset
  const registry = new RunRegistry({
    start: async (_def: AgentDefinition, _options: StartOptions) => {
      throw new Error('not started');
    },
    runsDir: mkdtempSync(join(tmpdir(), 'opium-vr-')),
  });
  const deps: ToolDeps = {
    registry,
    loadDef: () => agent('scout'),
    agentNames: () => ['scout'],
    cwd: '/work',
  };
  await assert.rejects(
    agentTool(deps, { agent: 'vision', task: 'x' }),
    /unknown agent "vision"/,
  );
  await assert.rejects(
    agentTool(
      { ...deps, refuse: (name) => (name === 'vision' ? 'nope' : undefined) },
      { agent: 'observer', task: 'x' },
    ),
    /agent "vision" is not needed: nope/,
  );
});
