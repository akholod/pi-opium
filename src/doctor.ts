// /opium-doctor: verifies the user's Opium setup from inside a Pi session
// (config, agents' models and credentials, council, skills, MCP, extensions,
// images, the runner). Everything the checks read comes through
// DoctorDeps, so the logic is testable without Pi; src/doctor-env.ts builds
// the real ones. Models are only called with `live`.

import {
  loadAgents,
  type AgentDefinition,
  type AgentOverrides,
  type ReadOverrides,
} from './agents.ts';
import {
  COUNCIL_AGENT,
  SAME_MODEL_NOTE,
  SEATS,
  councillorAgent,
  sharedSeatModel,
} from './council.ts';
import { VISION_AGENT } from './vision.ts';
import type { McpTools } from './mcp.ts';

export type Status = 'ok' | 'warn' | 'fail';

export interface Check {
  status: Status;
  title: string;
  detail?: string;
  fix?: string;
}

export interface Section {
  name: string;
  checks: Check[];
}

export interface DoctorReport {
  live: boolean;
  sections: Section[];
}

// A model as the doctor needs it: `ref` is `provider/id`.
export interface ModelInfo {
  ref: string;
  // true / false from the declared input capability; undefined = unknown
  images: boolean | undefined;
  authenticated: boolean;
}

export interface RunnerProbe {
  // the module loaded in this process
  exports: Record<string, unknown>;
  // version installed on disk
  version?: string;
}

export interface DoctorDeps {
  configPath: string;
  configExists(): boolean;
  readOverrides(): ReadOverrides;
  activePreset(): string | undefined;
  orchestrator(): boolean;
  wake(): { enabled: boolean; intervalMs: number };
  // the session model; undefined when the session has none
  sessionModel: ModelInfo | undefined;
  // undefined when the registry does not know `provider/id`
  resolveModel(ref: string): ModelInfo | undefined;
  // a resolver for skill names, as launch.ts resolves them
  skills(): Promise<(name: string) => boolean>;
  builtinMcp(): { disabled: boolean; servers: string[] };
  resolveMcp(servers: string[]): McpTools;
  // sources of the configured Pi packages (npm:name, paths, git urls)
  installedPackages(): string[];
  runner(): RunnerProbe;
  // one tiny request; rejects with the provider's error
  ping?(ref: string, signal: AbortSignal): Promise<void>;
  now?(): number;
}

export interface DoctorInput {
  live: boolean;
  // agent directories; default: the user's, then the package's
  agentDirs?: readonly string[];
  // 30 s per model unless a test says otherwise
  pingTimeoutMs?: number;
  concurrency?: number;
}

// Every value Opium imports from pi-agent-runner (test/doctor.test.ts keeps
// this in step with the source).
export const RUNNER_EXPORTS: readonly string[] = [
  'builtinMcpDisabled',
  'builtinMcpServers',
  'humanWaitTracker',
  'isPossiblyStuck',
  'liveRuns',
  'mountPanes',
  'mountRunsView',
  'runAgent',
  'startAgent',
];

const PING_TIMEOUT_MS = 30_000;
const PING_CONCURRENCY = 4;
// shipped defaults of scout, fixer, senior and researcher; absent is fine
const OPTIONAL_MCP: ReadonlySet<string> = new Set([
  'codegraph',
  'context7',
  'gh_grep',
]);

const ok = (title: string, detail?: string): Check => ({
  status: 'ok',
  title,
  ...(detail ? { detail } : {}),
});

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const worst = (checks: readonly Check[]): Status => {
  if (checks.some((c) => c.status === 'fail')) return 'fail';
  return checks.some((c) => c.status === 'warn') ? 'warn' : 'ok';
};

// ---- config ----

const checkConfig = (deps: DoctorDeps): Section => {
  const checks: Check[] = [];
  if (deps.configExists()) {
    checks.push(ok(`config found: ${deps.configPath}`));
  } else {
    checks.push({
      status: 'warn',
      title: `no config at ${deps.configPath}`,
      detail: 'the built-in defaults apply',
      fix: 'start Pi once to create it, or copy defaults/opium.json',
    });
  }
  const { errors } = deps.readOverrides();
  const prefix = `${deps.configPath}: `;
  for (const error of errors) {
    const message = error.startsWith(prefix)
      ? error.slice(prefix.length)
      : error;
    checks.push({
      status: error.includes('was renamed') ? 'warn' : 'fail',
      title: message,
    });
  }
  if (errors.length === 0) checks.push(ok('config parses without errors'));
  checks.push(ok(`preset: ${deps.activePreset() ?? 'none'}`));
  return { name: 'Config', checks };
};

// ---- agents ----

interface Loaded {
  agents: AgentDefinition[];
  errors: string[];
}

// advertised agents, plus the council seats and the synthesizer
const loadChecked = (
  overrides: AgentOverrides,
  agentDirs: readonly string[] | undefined,
): Loaded => {
  const { agents, errors } = loadAgents({ dirs: agentDirs, overrides });
  const council = [...SEATS.map(councillorAgent), COUNCIL_AGENT];
  const picked = [...agents.values()]
    .filter((a) => a.advertise || council.includes(a.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { agents: picked, errors };
};

const sessionLabel = (deps: DoctorDeps): string =>
  deps.sessionModel ? deps.sessionModel.ref : 'none';

const checkAgent = (agent: AgentDefinition, deps: DoctorDeps): Check => {
  const problems: Check[] = [];
  const labels: string[] = [];
  for (const ref of agent.models) {
    if (ref === 'inherit') {
      labels.push(`inherit (${sessionLabel(deps)})`);
      if (!deps.sessionModel) {
        problems.push({
          status: 'fail',
          title: 'inherit: this session has no model',
          fix: 'pick one with /model, or set a model for the agent',
        });
      }
      continue;
    }
    labels.push(ref);
    const model = deps.resolveModel(ref);
    if (!model) {
      problems.push({
        status: 'fail',
        title: `${ref}: model not found`,
        fix: 'check the id with /model, then fix it in opium.json',
      });
    } else if (!model.authenticated) {
      const provider = ref.slice(0, ref.indexOf('/'));
      problems.push({
        status: 'fail',
        title: `${ref}: no credentials for ${provider}`,
        fix: `run /login ${provider}`,
      });
    }
  }
  const thinking = agent.thinking ?? 'default';
  const check: Check = {
    status: worst(problems),
    title: `${agent.name}: ${labels.join(' → ')}, thinking ${thinking}`,
  };
  if (problems.length) {
    check.detail = problems.map((p) => p.title).join('\n');
    check.fix = problems.map((p) => p.fix).find(Boolean);
  }
  return check;
};

const checkAgents = (loaded: Loaded, deps: DoctorDeps): Section => {
  const checks: Check[] = loaded.errors.map((error) => ({
    status: 'fail',
    title: error,
  }));
  for (const agent of loaded.agents) checks.push(checkAgent(agent, deps));
  return { name: 'Agents', checks };
};

// ---- council ----

const checkCouncil = (
  overrides: AgentOverrides,
  agentDirs: readonly string[] | undefined,
): Section => {
  const same = sharedSeatModel({ overrides, agentDirs });
  const check: Check = same
    ? { status: 'warn', title: SAME_MODEL_NOTE, detail: `all seats: ${same}` }
    : ok('council seats use different models');
  return { name: 'Council', checks: [check] };
};

// ---- skills ----

const checkSkills = async (
  agents: readonly AgentDefinition[],
  deps: DoctorDeps,
): Promise<Section> => {
  const withSkills = agents.filter((a) => a.skills.length > 0);
  const checks: Check[] = [];
  if (withSkills.length > 0) {
    let has: (name: string) => boolean;
    try {
      has = await deps.skills();
    } catch (error) {
      return {
        name: 'Skills',
        checks: [
          {
            status: 'warn',
            title: 'cannot discover skills',
            detail: errorText(error),
          },
        ],
      };
    }
    for (const agent of withSkills) {
      for (const skill of agent.skills) {
        checks.push(
          has(skill)
            ? ok(`${agent.name}: skill ${skill}`)
            : {
                status: 'warn',
                title: `skill ${skill} not found for ${agent.name}`,
                fix: 'install the skill, or drop it from skills in opium.json',
              },
        );
      }
    }
  } else {
    checks.push(ok('no agent uses skills'));
  }
  return { name: 'Skills', checks };
};

// ---- MCP ----

const packageBase = (source: string): string => {
  let name = source.replace(/^npm:/, '').replace(/[\\/]+$/, '');
  const slash = name.lastIndexOf('/');
  // keep the scope of @scope/name; paths and urls reduce to the last segment
  if (slash >= 0 && !name.startsWith('@')) name = name.slice(slash + 1);
  name = name.replace(/\.git$/, '');
  const at = name.indexOf('@', 1);
  return at > 0 ? name.slice(0, at) : name;
};

const hasPackage = (deps: DoctorDeps, name: string): boolean =>
  deps.installedPackages().some((source) => packageBase(source) === name);

const checkMcp = (
  agents: readonly AgentDefinition[],
  deps: DoctorDeps,
): Section => {
  const withMcp = agents.filter((a) => a.mcpServers.length > 0);
  const { disabled, servers } = deps.builtinMcp();
  const checks: Check[] = [
    ok(
      disabled
        ? 'builtin MCP is disabled (-builtin:mcp)'
        : `builtin MCP is enabled (${servers.join(', ') || 'no servers'})`,
    ),
  ];
  const known = new Set(disabled ? [] : servers);
  for (const agent of withMcp) {
    for (const server of agent.mcpServers) {
      const label = `${agent.name}: MCP ${server}`;
      if (known.has(server)) {
        checks.push(ok(`${label} via builtin MCP`));
        continue;
      }
      let mcp: McpTools;
      try {
        mcp = deps.resolveMcp([server]);
      } catch (error) {
        mcp = { tools: [], errors: [errorText(error)] };
      }
      if (mcp.tools.length > 0) {
        const adapter = hasPackage(deps, 'pi-mcp-adapter');
        checks.push(
          adapter
            ? ok(`${label} via pi-mcp-adapter (${mcp.tools.length} tools)`)
            : {
                status: 'warn',
                title: `${label} needs pi-mcp-adapter, which is not installed`,
                fix: 'pi install npm:pi-mcp-adapter',
              },
        );
      } else if (mcp.errors.length > 0) {
        checks.push({
          status: 'warn',
          title: `${label} is configured but unusable`,
          detail: mcp.errors.join('\n'),
        });
      } else if (OPTIONAL_MCP.has(server)) {
        checks.push(ok(`${label} not configured, agent works without it`));
      } else {
        checks.push({
          status: 'warn',
          title: `${label} not found; the agent runs without it`,
          fix: 'add the server with pi mcp add, or remove it from mcpServers',
        });
      }
    }
  }
  if (withMcp.length === 0) checks.push(ok('no agent uses MCP servers'));
  return { name: 'MCP', checks };
};

// ---- extensions ----

const FIXES: Record<string, string> = {
  'pi-web-access':
    'researcher cannot search the web: pi install npm:pi-web-access',
};

const checkExtensions = (
  agents: readonly AgentDefinition[],
  deps: DoctorDeps,
): Section => {
  const wanted = new Map<string, string[]>();
  for (const agent of agents) {
    for (const name of agent.packages) {
      wanted.set(name, [...(wanted.get(name) ?? []), agent.name]);
    }
  }
  const checks: Check[] = [];
  for (const [name, users] of wanted) {
    if (hasPackage(deps, name)) {
      checks.push(ok(`${name} installed (${users.join(', ')})`));
    } else {
      checks.push({
        status: 'warn',
        title: `${name} is not installed (${users.join(', ')})`,
        fix: FIXES[name] ?? `pi install npm:${name}`,
      });
    }
  }
  if (wanted.size === 0) checks.push(ok('no agent needs extra packages'));
  return { name: 'Extensions', checks };
};

// ---- images ----

const checkImages = (agents: readonly AgentDefinition[], deps: DoctorDeps) => {
  const checks: Check[] = [];
  const session = deps.sessionModel;
  if (session?.images === true) {
    checks.push(ok(`${session.ref} sees images; the vision agent is skipped`));
    return { name: 'Images', checks };
  }
  const vision = agents.find((a) => a.name === VISION_AGENT);
  if (!vision) {
    checks.push(ok('no vision agent is advertised; images are not routed'));
    return { name: 'Images', checks };
  }
  const first = vision.models[0] ?? 'inherit';
  const model = first === 'inherit' ? session : deps.resolveModel(first);
  const used = session
    ? `${session.ref} cannot see images`
    : 'the session model is unknown';
  if (model?.images === true) {
    checks.push(ok(`${used}; vision (${model.ref}) reads them for it`));
  } else if (model?.images === false) {
    checks.push({
      status: 'fail',
      title: `${used}, and the vision model ${model.ref} cannot see them`,
      fix: 'set a model that accepts images for vision in opium.json',
    });
  } else {
    checks.push({
      status: 'warn',
      title: `${used}; cannot tell whether vision (${first}) sees images`,
    });
  }
  return { name: 'Images', checks };
};

// ---- runner ----

const checkRunner = (deps: DoctorDeps): Section => {
  const { exports, version } = deps.runner();
  const missing = RUNNER_EXPORTS.filter(
    (n) => typeof exports[n] !== 'function',
  );
  const shown = version ?? 'unknown version';
  const check: Check =
    missing.length > 0
      ? {
          status: 'fail',
          title: `pi-agent-runner is missing ${missing.join(', ')}`,
          detail:
            'pi-agent-runner loaded in this Pi process is older than the ' +
            `installed ${shown}`,
          fix: 'restart Pi (a /reload is not enough)',
        }
      : ok(`pi-agent-runner ${shown} provides every export Opium uses`);
  return { name: 'Runner', checks: [check] };
};

// ---- orchestrator ----

const checkOrchestrator = (deps: DoctorDeps): Section => {
  const wake = deps.wake();
  const wakeText = wake.enabled
    ? `wake on, every ${Math.round(wake.intervalMs / 1000)} s`
    : 'wake off';
  return {
    name: 'Orchestrator',
    checks: [
      ok(`orchestrator prompt ${deps.orchestrator() ? 'on' : 'off'}`),
      ok(wakeText),
    ],
  };
};

// ---- live ----

// primary model and first fallback of every checked agent, deduped; models
// that already failed the static checks are not pinged
const liveModels = (
  agents: readonly AgentDefinition[],
  deps: DoctorDeps,
): string[] => {
  const refs = new Set<string>();
  for (const agent of agents) {
    for (const ref of agent.models.slice(0, 2)) {
      if (ref === 'inherit') {
        if (deps.sessionModel) refs.add(deps.sessionModel.ref);
      } else if (deps.resolveModel(ref)?.authenticated) {
        refs.add(ref);
      }
    }
  }
  return [...refs];
};

const pingOne = async (
  ref: string,
  deps: DoctorDeps,
  timeoutMs: number,
): Promise<Check> => {
  const now = deps.now ?? Date.now;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`no answer within ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
  });
  const started = now();
  try {
    await Promise.race([deps.ping?.(ref, controller.signal), timeout]);
    return ok(`${ref}: answered in ${now() - started} ms`);
  } catch (error) {
    return { status: 'fail', title: `${ref}: ${errorText(error)}` };
  } finally {
    clearTimeout(timer);
  }
};

const checkLive = async (
  agents: readonly AgentDefinition[],
  deps: DoctorDeps,
  input: DoctorInput,
): Promise<Section> => {
  if (!deps.ping) {
    return {
      name: 'Live',
      checks: [{ status: 'warn', title: 'live pings are not available here' }],
    };
  }
  const refs = liveModels(agents, deps);
  const checks: Check[] = new Array<Check>(refs.length);
  const timeoutMs = input.pingTimeoutMs ?? PING_TIMEOUT_MS;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < refs.length) {
      const index = next++;
      checks[index] = await pingOne(refs[index], deps, timeoutMs);
    }
  };
  const width = Math.min(input.concurrency ?? PING_CONCURRENCY, refs.length);
  await Promise.all(Array.from({ length: width }, worker));
  if (refs.length === 0) checks.push(ok('no model to ping'));
  return { name: 'Live', checks };
};

export const runDoctor = async (
  input: DoctorInput,
  deps: DoctorDeps,
): Promise<DoctorReport> => {
  const { overrides } = deps.readOverrides();
  const loaded = loadChecked(overrides, input.agentDirs);
  const sections = [
    checkConfig(deps),
    checkAgents(loaded, deps),
    checkCouncil(overrides, input.agentDirs),
    await checkSkills(loaded.agents, deps),
    checkMcp(loaded.agents, deps),
    checkExtensions(loaded.agents, deps),
    checkImages(loaded.agents, deps),
    checkRunner(deps),
    checkOrchestrator(deps),
  ];
  if (input.live) sections.push(await checkLive(loaded.agents, deps, input));
  return { live: input.live, sections };
};

// ---- output ----

export interface Counts {
  ok: number;
  warn: number;
  fail: number;
}

export const countChecks = (report: DoctorReport): Counts => {
  const counts: Counts = { ok: 0, warn: 0, fail: 0 };
  for (const section of report.sections) {
    for (const check of section.checks) counts[check.status]++;
  }
  return counts;
};

export const summaryLine = (report: DoctorReport): string => {
  const { ok: good, warn, fail } = countChecks(report);
  return `${good} ok, ${warn} warnings, ${fail} problems`;
};

const MARKS: Record<Status, string> = { ok: '✓', warn: '⚠', fail: '✗' };

export const formatDoctor = (report: DoctorReport): string => {
  const lines = ['Opium doctor'];
  for (const section of report.sections) {
    lines.push('', section.name);
    for (const check of section.checks) {
      lines.push(`  ${MARKS[check.status]} ${check.title}`);
      for (const line of check.detail?.split('\n') ?? []) {
        lines.push(`      ${line}`);
      }
      if (check.fix) lines.push(`      fix: ${check.fix}`);
    }
  }
  lines.push('');
  if (!report.live) {
    lines.push('Run /opium-doctor --live to ping each model.', '');
  }
  lines.push(summaryLine(report));
  return lines.join('\n');
};
