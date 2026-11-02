// The real DoctorDeps: the session's model registry, Pi's package manager,
// the runner module loaded in this process.

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DefaultPackageManager,
  SettingsManager,
  VERSION,
  getAgentDir,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import * as runner from 'pi-agent-runner';
import { readAgentOverrides } from './agents.ts';
import type {
  DoctorDeps,
  ModelInfo,
  RunnerProbe,
  RunnerRuntime,
} from './doctor.ts';
import { discoverSkills, skillResolver } from './launch.ts';
import { resolveMcpTools } from './mcp.ts';
import { listPresets } from './presets.ts';
import { readState, readWakeSettings } from './state.ts';
import { supportsImages } from './vision.ts';

const PING_PROMPT = 'Reply with OK';
const PING_MAX_TOKENS = 32;

type Registry = ExtensionContext['modelRegistry'];
type SessionModel = ExtensionContext['model'];

const infoOf = (
  registry: Registry,
  model: NonNullable<SessionModel>,
): ModelInfo => ({
  ref: `${model.provider}/${model.id}`,
  images: supportsImages(model),
  authenticated: registry.hasConfiguredAuth(model),
});

const findModel = (registry: Registry, ref: string) => {
  const slash = ref.indexOf('/');
  return slash > 0
    ? registry.find(ref.slice(0, slash), ref.slice(slash + 1))
    : undefined;
};

const PI_PACKAGE = '@earendil-works/pi-coding-agent';

const manifestVersion = (file: string): string | undefined => {
  let version: string | undefined;
  try {
    const json = JSON.parse(readFileSync(file, 'utf8')) as {
      version?: unknown;
    };
    if (typeof json.version === 'string') version = json.version;
  } catch {
    // unreadable: the version stays unknown
  }
  return version;
};

const realPath = (path: string): string | undefined => {
  let real: string | undefined;
  try {
    real = realpathSync(path);
  } catch {
    // gone: nothing to look beside
  }
  return real;
};

// First hit of `find` in `start` and then each parent directory.
const walkUp = (
  start: string,
  find: (dir: string) => string | undefined,
): string | undefined => {
  let dir = start;
  let result: string | undefined;
  let done = false;
  while (!done) {
    result = find(dir);
    const parent = dirname(dir);
    done = result !== undefined || parent === dir;
    dir = parent;
  }
  return result;
};

// The directory of the pi-agent-runner on disk, found from where Opium is
// installed (its package.json is not in the package's exports).
const installedRunnerDir = (): string | undefined =>
  walkUp(dirname(fileURLToPath(import.meta.url)), (dir) => {
    const found = join(dir, 'node_modules', 'pi-agent-runner');
    return existsSync(join(found, 'package.json')) ? found : undefined;
  });

export const installedRunnerVersion = (): string | undefined => {
  const dir = installedRunnerDir();
  return dir ? manifestVersion(join(dir, 'package.json')) : undefined;
};

// The Pi a plain Node resolution from the runner's location would find (the
// copy the runner used before it was bound to the host). Reads the manifest
// only; the package is never imported.
export const nativePiCandidateVersion = (
  runnerDir = installedRunnerDir(),
): string | undefined => {
  const start = runnerDir ? realPath(runnerDir) : undefined;
  const manifest = start
    ? walkUp(start, (dir) => {
        const file = join(dir, 'node_modules', PI_PACKAGE, 'package.json');
        return existsSync(file) ? file : undefined;
      })
    : undefined;
  return manifest ? manifestVersion(manifest) : undefined;
};

// A runner older than 0.11 has no getHostRuntimeInfo: the runtime stays
// unverified.
const runnerRuntime = (): RunnerRuntime | undefined => {
  const read = (runner as { getHostRuntimeInfo?: unknown }).getHostRuntimeInfo;
  return typeof read === 'function' ? runner.getHostRuntimeInfo() : undefined;
};

const probeRunner = (): RunnerProbe => {
  const version = installedRunnerVersion();
  const runtime = runnerRuntime();
  const candidate = nativePiCandidateVersion();
  return {
    // SAFETY: a module namespace object is a plain record of its exports;
    // the probe only reads keys and checks typeof, never calls through it.
    exports: runner as unknown as Record<string, unknown>,
    ...(version === undefined ? {} : { version }),
    hostVersion: VERSION,
    ...(runtime === undefined ? {} : { runtime }),
    ...(candidate === undefined ? {} : { nativeCandidate: candidate }),
  };
};

export type DoctorContext = Pick<
  ExtensionContext,
  'cwd' | 'model' | 'modelRegistry'
>;

export const realDoctorDeps = (
  ctx: DoctorContext,
  configPath: string,
): DoctorDeps => {
  const { cwd, modelRegistry: registry } = ctx;
  return {
    configPath,
    configExists: () => existsSync(configPath),
    readOverrides: () => readAgentOverrides(configPath),
    activePreset: () => listPresets(configPath).active,
    orchestrator: () => readState(configPath).orchestrator,
    wake: () => readWakeSettings(configPath),
    sessionModel: ctx.model ? infoOf(registry, ctx.model) : undefined,
    resolveModel: (ref) => {
      const model = findModel(registry, ref);
      return model ? infoOf(registry, model) : undefined;
    },
    skills: async () => {
      const resolve = skillResolver(await discoverSkills(cwd));
      return (name) => resolve(name, cwd) !== undefined;
    },
    builtinMcp: () => ({
      disabled: runner.builtinMcpDisabled(cwd),
      servers: runner
        .builtinMcpServers(cwd)
        .filter((server) => server.enabled)
        .map((server) => server.name),
    }),
    resolveMcp: (servers) => resolveMcpTools(servers),
    installedPackages: () => {
      const agentDir = getAgentDir();
      return new DefaultPackageManager({
        cwd,
        agentDir,
        settingsManager: SettingsManager.create(cwd, agentDir),
      })
        .listConfiguredPackages()
        .map((pkg) => pkg.source);
    },
    runner: probeRunner,
    ping: async (ref, signal) => {
      const model = findModel(registry, ref);
      if (!model) throw new Error('model not found');
      const message = await registry
        .streamSimple(
          model,
          {
            messages: [
              { role: 'user', content: PING_PROMPT, timestamp: Date.now() },
            ],
          },
          // some providers route by session (opencode-go requires it); a
          // fresh id per ping keeps it from touching the user's session
          { maxTokens: PING_MAX_TOKENS, signal, sessionId: randomUUID() },
        )
        .result();
      if (message.stopReason === 'error' || message.stopReason === 'aborted') {
        throw new Error(message.errorMessage ?? message.stopReason);
      }
    },
  };
};
