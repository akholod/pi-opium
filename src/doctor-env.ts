// The real DoctorDeps: the session's model registry, Pi's package manager,
// the runner module loaded in this process.

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DefaultPackageManager,
  SettingsManager,
  getAgentDir,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import * as runner from 'pi-agent-runner';
import { readAgentOverrides } from './agents.ts';
import type { DoctorDeps, ModelInfo, RunnerProbe } from './doctor.ts';
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

// The version of the pi-agent-runner on disk, found from where Opium is
// installed (its package.json is not in the package's exports).
export const installedRunnerVersion = (): string | undefined => {
  let dir = dirname(fileURLToPath(import.meta.url));
  let version: string | undefined;
  let done = false;
  while (!done) {
    const file = join(dir, 'node_modules', 'pi-agent-runner', 'package.json');
    if (existsSync(file)) {
      try {
        const json = JSON.parse(readFileSync(file, 'utf8')) as {
          version?: unknown;
        };
        if (typeof json.version === 'string') version = json.version;
      } catch {
        // unreadable: the version stays unknown
      }
      done = true;
    } else {
      const parent = dirname(dir);
      done = parent === dir;
      dir = parent;
    }
  }
  return version;
};

const probeRunner = (): RunnerProbe => {
  const version = installedRunnerVersion();
  return {
    // SAFETY: a module namespace object is a plain record of its exports;
    // the probe only reads keys and checks typeof, never calls through it.
    exports: runner as unknown as Record<string, unknown>,
    ...(version === undefined ? {} : { version }),
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
