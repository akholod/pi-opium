// Registry of Opium's own agent runs (background and foreground) on
// pi-agent-runner's startAgent: one record per run, one live session
// handle per retained run, several generations per run (revive). The
// runner is injected, so the logic is testable without Pi.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import {
  startAgent,
  type AgentHandle,
  type GenerationResult,
  type ParentContext,
  type QueueDisposition,
  type RunStatus,
  type TurnOptions,
} from 'pi-agent-runner';
import type { AgentDefinition } from './agents.ts';
import { buildLaunch } from './launch.ts';

export type RunState = 'starting' | 'running' | RunStatus;

export interface RunRecord {
  id: string;
  agent: string;
  // whitespace-normalized full task text
  objective: string;
  // latest instruction
  task: string;
  state: RunState;
  generation: number;
  background: boolean;
  // true when a generation ends; cleared by markRead
  unread: boolean;
  // result of the latest generation
  result?: GenerationResult;
  error?: string;
  warnings: string[];
  // a live handle is held
  retained: boolean;
  transcriptPath: string;
  startedAt: number;
  endedAt?: number;
  lastUsedAt: number;
  cwd: string;
}

export type RefusalCode =
  'duplicate' | 'running' | 'no_session' | 'shutdown' | 'unknown';

export class RunRefusal extends Error {
  readonly code: RefusalCode;
  constructor(code: RefusalCode, message: string) {
    super(message);
    this.name = 'RunRefusal';
    this.code = code;
  }
}

export interface StartOptions {
  transcriptPath?: string;
  resumeFrom?: string;
  cwd?: string;
}

export interface Started {
  handle: AgentHandle;
  turn: TurnOptions;
  warnings: string[];
}

export type Starter = (
  def: AgentDefinition,
  options: StartOptions,
) => Promise<Started>;

export interface RunRegistryOptions {
  start: Starter;
  runsDir?: string;
  maxSessionsPerAgent?: number;
  now?: () => number;
  onTerminal?: (run: RunRecord) => void;
  newId?: () => string;
}

export interface Spawned {
  run: RunRecord;
  done: Promise<RunRecord>;
}

export type CancelOutcome = 'cancelled' | 'not_running' | 'unknown';
export type MessageOutcome = QueueDisposition | 'unknown' | 'not_retained';

export const MESSAGE_LIMIT = 2000;

export const defaultRunsDir = (): string =>
  join(getAgentDir(), 'opium', 'runs');

const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

interface Entry {
  run: RunRecord;
  handle?: AgentHandle;
  turn: TurnOptions;
  cancelRequested: boolean;
}

const isActive = (run: RunRecord): boolean =>
  run.state === 'starting' || run.state === 'running';

export class RunRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly startFn: Starter;
  private readonly runsDir: string;
  private readonly maxSessions: number;
  private readonly now: () => number;
  private readonly onTerminal?: (run: RunRecord) => void;
  private readonly newId: () => string;
  private stopped = false;

  constructor(options: RunRegistryOptions) {
    this.startFn = options.start;
    this.runsDir = options.runsDir ?? defaultRunsDir();
    this.maxSessions = options.maxSessionsPerAgent ?? 2;
    this.now = options.now ?? Date.now;
    this.onTerminal = options.onTerminal;
    this.newId =
      options.newId ?? ((): string => `r-${randomBytes(4).toString('hex')}`);
  }

  spawn(
    def: AgentDefinition,
    task: string,
    options: { background: boolean; cwd: string },
  ): Spawned {
    this.assertRunning();
    const objective = normalize(task);
    for (const { run } of this.entries.values()) {
      if (
        run.agent === def.name &&
        run.objective === objective &&
        !isActive(run) &&
        run.unread
      ) {
        throw new RunRefusal(
          'duplicate',
          `run ${run.id} (${run.agent}) already finished this objective ` +
            'and its result is unread; read it with agent_result or ' +
            'continue it with agent_revive',
        );
      }
    }
    const id = this.newId();
    const at = this.now();
    const run: RunRecord = {
      id,
      agent: def.name,
      objective,
      task: task.trim(),
      state: 'starting',
      generation: 1,
      background: options.background,
      unread: false,
      warnings: [],
      retained: false,
      transcriptPath: join(this.runsDir, `${id}.jsonl`),
      startedAt: at,
      lastUsedAt: at,
      cwd: options.cwd,
    };
    const entry: Entry = { run, turn: {}, cancelRequested: false };
    this.entries.set(id, entry);
    this.persist(run);
    const done = this.launch(entry, def, run.task, {
      transcriptPath: run.transcriptPath,
      cwd: run.cwd,
    });
    return { run, done };
  }

  get(id: string): RunRecord | undefined {
    return this.entries.get(id)?.run;
  }

  // newest first
  list(): RunRecord[] {
    return [...this.entries.values()]
      .map((entry) => entry.run)
      .reverse()
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  // agent of a run in memory, or of a pre-restart run from its metadata
  agentOf(id: string): string | undefined {
    const known = this.get(id)?.agent;
    if (known) return known;
    let agent: string | undefined;
    try {
      const meta: unknown = JSON.parse(readFileSync(this.metaPath(id), 'utf8'));
      const value = (meta as { agent?: unknown } | null)?.agent;
      if (typeof value === 'string' && value) agent = value;
    } catch {
      // unknown run
    }
    return agent;
  }

  markRead(id: string): RunRecord | undefined {
    const run = this.get(id);
    if (run) run.unread = false;
    return run;
  }

  // returns the record; a finished run is marked read
  result(id: string): RunRecord | undefined {
    const run = this.get(id);
    if (run && !isActive(run)) run.unread = false;
    return run;
  }

  async message(
    id: string,
    text: string,
    mode: 'queue' | 'steer',
  ): Promise<MessageOutcome> {
    const entry = this.entries.get(id);
    if (!entry) return 'unknown';
    const { handle } = entry;
    if (!handle || handle.state === 'disposed') return 'not_retained';
    const body = text.trim().slice(0, MESSAGE_LIMIT);
    return mode === 'steer' ? handle.steer(body) : handle.followUp(body);
  }

  async cancel(id: string): Promise<CancelOutcome> {
    const entry = this.entries.get(id);
    if (!entry) return 'unknown';
    if (!isActive(entry.run)) return 'not_running';
    entry.cancelRequested = true;
    if (entry.handle) await entry.handle.abort();
    return 'cancelled';
  }

  revive(id: string, task: string, def: AgentDefinition): Spawned {
    this.assertRunning();
    let entry = this.entries.get(id);
    if (entry && isActive(entry.run)) {
      throw new RunRefusal('running', `run ${id} is still running`);
    }
    if (!entry) entry = this.restore(id);
    const { run } = entry;
    const live = entry.handle?.state === 'idle' ? entry.handle : undefined;
    if (!live && !existsSync(run.transcriptPath)) {
      throw new RunRefusal('no_session', `run ${id} has no saved session`);
    }
    run.generation += 1;
    run.task = task.trim();
    run.state = 'starting';
    run.unread = false;
    run.error = undefined;
    run.result = undefined;
    run.endedAt = undefined;
    run.lastUsedAt = this.now();
    entry.cancelRequested = false;
    this.persist(run);
    if (live) {
      return { run, done: this.drive(entry, live, run.task) };
    }
    entry.handle = undefined;
    run.retained = false;
    return {
      run,
      done: this.launch(entry, def, run.task, {
        resumeFrom: run.transcriptPath,
        cwd: run.cwd,
      }),
    };
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    const handles: AgentHandle[] = [];
    for (const entry of this.entries.values()) {
      entry.cancelRequested = true;
      if (entry.handle) handles.push(entry.handle);
    }
    // disposing below aborts anyway, so an abort failure is ignored
    await Promise.all(
      handles
        .filter((handle) => handle.state === 'running')
        .map((handle) => handle.abort().catch(() => undefined)),
    );
    await Promise.all(handles.map((handle) => RunRegistry.dispose(handle)));
    for (const entry of this.entries.values()) {
      if (entry.handle) {
        entry.handle = undefined;
        entry.run.retained = false;
      }
    }
  }

  private assertRunning(): void {
    if (this.stopped) {
      throw new RunRefusal('shutdown', 'Opium is shutting down');
    }
  }

  private metaPath(id: string): string {
    return join(this.runsDir, `${id}.json`);
  }

  private persist(run: RunRecord): void {
    try {
      mkdirSync(this.runsDir, { recursive: true });
      const meta = {
        id: run.id,
        agent: run.agent,
        objective: run.objective,
        task: run.task,
        cwd: run.cwd,
        generation: run.generation,
        state: run.state,
        transcriptPath: run.transcriptPath,
      };
      writeFileSync(this.metaPath(run.id), JSON.stringify(meta, null, 2));
    } catch {
      // metadata is best effort; the run itself must not fail on it
    }
  }

  // an evicted or pre-restart run, rebuilt from its metadata file
  private restore(id: string): Entry {
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(readFileSync(this.metaPath(id), 'utf8')) as Record<
        string,
        unknown
      >;
    } catch {
      throw new RunRefusal('unknown', `run ${id} not found`);
    }
    const str = (key: string): string =>
      typeof meta[key] === 'string' ? meta[key] : '';
    const transcriptPath =
      str('transcriptPath') || join(this.runsDir, `${id}.jsonl`);
    if (!existsSync(transcriptPath)) {
      throw new RunRefusal('no_session', `run ${id} has no saved session`);
    }
    const at = this.now();
    const generation = Number(meta.generation);
    const run: RunRecord = {
      id,
      agent: str('agent'),
      objective: str('objective'),
      task: str('task'),
      state: 'failed',
      generation: Number.isFinite(generation) ? generation : 1,
      background: true,
      unread: false,
      warnings: [],
      retained: false,
      transcriptPath,
      startedAt: at,
      lastUsedAt: at,
      cwd: str('cwd'),
    };
    const entry: Entry = { run, turn: {}, cancelRequested: false };
    this.entries.set(id, entry);
    return entry;
  }

  private async launch(
    entry: Entry,
    def: AgentDefinition,
    task: string,
    options: StartOptions,
  ): Promise<RunRecord> {
    const { run } = entry;
    let started: Started;
    try {
      started = await this.startFn(def, options);
    } catch (error) {
      return this.finish(entry, 'failed', undefined, errorText(error));
    }
    run.warnings = started.warnings;
    entry.turn = started.turn;
    if (this.stopped) {
      await RunRegistry.dispose(started.handle);
      return this.finish(entry, 'cancelled', undefined, 'shutting down');
    }
    entry.handle = started.handle;
    run.retained = true;
    if (entry.cancelRequested) {
      return this.finish(entry, 'cancelled', undefined, 'cancelled');
    }
    return this.drive(entry, started.handle, task);
  }

  private async drive(
    entry: Entry,
    handle: AgentHandle,
    task: string,
  ): Promise<RunRecord> {
    entry.run.state = 'running';
    let result: GenerationResult | undefined;
    let error: string | undefined;
    try {
      result = await handle.run(task, entry.turn);
    } catch (e) {
      error = errorText(e);
    }
    if (result) {
      return this.finish(entry, result.status, result, result.error);
    }
    return this.finish(entry, 'failed', undefined, error);
  }

  private async finish(
    entry: Entry,
    state: RunStatus,
    result: GenerationResult | undefined,
    error: string | undefined,
  ): Promise<RunRecord> {
    const { run } = entry;
    run.state = state;
    run.result = result;
    run.error = error;
    run.unread = true;
    run.endedAt = this.now();
    run.lastUsedAt = run.endedAt;
    this.persist(run);
    try {
      this.onTerminal?.(run);
    } catch {
      // a listener must not break the registry
    }
    await this.enforceCap(run.agent);
    return run;
  }

  // keep at most maxSessions retained handles per agent; only terminal ones
  // are evicted, least recently used first
  private async enforceCap(agent: string): Promise<void> {
    const retained = [...this.entries.values()].filter(
      (entry) => entry.handle && entry.run.agent === agent,
    );
    let excess = retained.length - this.maxSessions;
    const idle = retained
      .filter((entry) => !isActive(entry.run))
      .sort((a, b) => a.run.lastUsedAt - b.run.lastUsedAt);
    for (const entry of idle) {
      if (excess <= 0) break;
      excess -= 1;
      const { handle } = entry;
      entry.handle = undefined;
      entry.run.retained = false;
      if (handle) await RunRegistry.dispose(handle);
    }
  }

  private static async dispose(handle: AgentHandle): Promise<void> {
    try {
      await handle.dispose();
    } catch {
      // already gone
    }
  }
}

export interface StarterContext {
  parent: ParentContext;
  cwd: string;
}

// production wiring: buildLaunch + startAgent
export const defaultStarter =
  (ctx: StarterContext): Starter =>
  async (def, options) => {
    const cwd = options.cwd ?? ctx.cwd;
    const launch = buildLaunch(def, { parent: ctx.parent, cwd });
    const handle = await startAgent({
      ...launch.start,
      ...(options.transcriptPath && {
        transcriptPath: options.transcriptPath,
      }),
      ...(options.resumeFrom && { resumeFrom: options.resumeFrom }),
    });
    return { handle, turn: launch.turn, warnings: launch.warnings };
  };
