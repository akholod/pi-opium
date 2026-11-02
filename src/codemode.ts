// Pi's codemode tool runs its scripts in a worker pool shared by the whole
// Pi process: the orchestrator and every in-process specialist draw from the
// same few workers. The host reads PI_CODEMODE_MAX_WORKERS on each call
// (dist/extensions/codemode/execute.js, maxCodemodeWorkers), so setting it
// while the extension loads still takes effect.

export const CODEMODE_TOOL = 'codemode';
export const CODEMODE_WORKERS_ENV = 'PI_CODEMODE_MAX_WORKERS';
// the host's own default
export const HOST_DEFAULT_WORKERS = 2;
// what Opium raises an unset limit to
export const OPIUM_DEFAULT_WORKERS = 6;
// below this, a few agents running scripts at once can starve each other
export const MIN_RECOMMENDED_WORKERS = 4;

type Env = Record<string, string | undefined>;

// The limit the host applies: a positive integer from the env, else 2.
export const effectiveCodemodeWorkers = (env: Env = process.env): number => {
  const value = Number(env[CODEMODE_WORKERS_ENV]);
  return Number.isInteger(value) && value > 0 ? value : HOST_DEFAULT_WORKERS;
};

// Sets the limit to Opium's default only when the user set nothing at all
// (an empty or invalid value is theirs too and is left alone). Returns
// whether it changed anything.
export const defaultCodemodeWorkers = (env: Env = process.env): boolean => {
  if (env[CODEMODE_WORKERS_ENV] !== undefined) return false;
  env[CODEMODE_WORKERS_ENV] = String(OPIUM_DEFAULT_WORKERS);
  return true;
};
