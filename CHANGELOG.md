# Changelog

## 0.6.1

- README: a reviewer example, senior's narrower role, and how to add your
  own agents with `advertise: true`.

## 0.6.0

- Bundled skills `write-tests` and `review-tests` (vendored from mtga, MIT;
  refresh with `npm run sync:skills`); tester and reviewer load them by
  default.
- **reviewer agent.** The default verification for risky changes: reviews
  the code and its tests. Light by default (reads, runs checks); a deep
  review also tries to break the code in a separate git worktree.
- **tester agent.** Writes tests sized to the risk of the change, treating
  each test as a spec of the behavior. Light or full.
- **senior narrowed** to architecture, design and stuck bugs; reviewing a
  finished diff is now reviewer's job.
- Orchestrator prompt: tests are part of the change, sized to risk.
- Custom agents with `advertise: true` in `~/.pi/agent/agents` appear in
  the orchestrator roster with their description.
- Inlined skills carry their path, so relative references inside a skill
  resolve.

## 0.5.0

- **researcher and senior get Pi's `codemode` tool.** With it they
  can run one small script that reads, searches or fetches several things in
  parallel and filters large output before it reaches the model. Their
  prompts say when to use it (3+ independent calls, or large output) and
  when not to (single lookups, anything to read verbatim). The orchestrator
  prompt mentions it for fanning out several `agent` / `agent_result` calls.
  Nested calls go through the same guards as direct ones. To turn it off for
  an agent, copy its file to `~/.pi/agent/agents/` and drop `codemode` from
  `tools:` (see the README). scout does not get it: in live A/B runs on its
  model (gpt-6-luna) it almost never used codemode and gained nothing.
- **Worker limit.** Codemode scripts share a pool of workers for the whole
  Pi process (default 2, the orchestrator and all specialists together).
  Pi reads `PI_CODEMODE_MAX_WORKERS` on every call, so Opium sets it to `6`
  when the extension loads, only if you have not set it. A value you set,
  including an invalid one, is never changed.
- `/opium-doctor` reports the effective worker limit (Extensions section)
  and warns, with the fix, when it is below 4 while agents use codemode.
- **Subagents run on the host Pi.** The extension now hands the host's Pi
  SDK, TUI and `typebox` to pi-agent-runner (`bindHostRuntime`, requires
  pi-agent-runner 0.11), so specialists, the council and the vision agent
  use the Pi version that is running instead of a stale copy installed next
  to the runner.
- `/opium-doctor` reports the host Pi version, whether the runner is bound to
  it (and any binding warnings), and the Pi package found next to the runner,
  if any (read from its manifest, never loaded). A runner without the
  diagnostic shows as "runtime unverified".
- All host packages (`pi-ai`, `pi-coding-agent`, `pi-tui`, `typebox`) are
  optional peer dependencies; the development baseline is Pi 1.5.

## 0.4.2

- **researcher reads library docs with the Context7 CLI** (`ctx7 library`,
  then `ctx7 docs`) instead of the `context7` MCP server. Install with
  `npm i -g ctx7` (or use `npx ctx7@latest`); `ctx7 login` raises the
  limits. researcher gets `bash`, but a guard blocks every call that is
  not a single `ctx7 library|docs` command. The default `mcpServers` for
  researcher is now `gh_grep` only.

## 0.4.1

- **Fix:** `/opium-doctor` no longer warns about the default `codegraph`,
  `context7` and `gh_grep` servers when a `pi-mcp-adapter` config exists
  without its metadata cache.
- Install guide: back up an existing `opium.json` first, keep a model
  the user set by moving it into the preset, copy model ids exactly, and
  tell the user when a provider still needs a sign-in.
- README installs from npm (`pi install npm:pi-opium`).

## 0.4.0

Install by asking your agent, see every agent at work.

- **Install with one prompt.** Paste the line from the README into any
  coding agent: it asks which subscriptions you have and whether you
  want the full setup, installs, writes a preset and checks the result.
  Guide: [docs/install.md](docs/install.md).
- **Presets per subscription** for Claude, ChatGPT, Copilot, OpenCode Go,
  Gemini and a mix: [docs/models.md](docs/models.md). New docs for the
  [agents](docs/agents.md) and [troubleshooting](docs/troubleshooting.md);
  `docs/examples` is gone.
- **`/opium-doctor [--live]`** checks the config, every agent's models and
  credentials, the council, skills, MCP servers, extensions and the
  runner; `--live` pings each model. `pi -p "/opium-doctor"` prints the
  report, so scripts and other agents can read it.
- **Live agent panes.** Inside herdr or tmux, each running agent gets a
  read-only pane with its tool calls, thoughts and answers, titled
  `<agent> · <project>`. At most three at once; each closes a few seconds
  after its agent ends. `"panes"` in `opium.json` tunes or disables them.
- **pi-lens for agents.** `extensions` and `extraTools` per agent load
  Pi packages and allow more tools. With `pi-lens`, agents get code
  navigation and diagnostics; read-only agents cannot rename or run code
  actions through it.
- **Docs MCP for researcher.** researcher asks for Context7 and grep.app
  by default and works without them when they are not set up.
- **Images go to vision only when needed.** A session model that sees
  images reads them itself; other agents get a `vision` tool when their
  own model cannot.
- **A more productive lead.** The orchestrator and `/deepwork` prompts
  delegate sooner and keep the team busy.
- **Fix:** `opium.json` is read from `PI_CODING_AGENT_DIR` when set.
- Requires `pi-agent-runner` ^0.10.1 and Node 22.19 or newer.

## 0.3.1

- npm package metadata: license, repository, gallery image.

## 0.3.0

- **Breaking:** agents renamed: explorer → scout, librarian →
  researcher, oracle → senior, observer → vision. Old names in
  `opium.json` still work and are reported as renamed.
- Works out of the box: every agent starts on the session's model.
- Per-agent `mcpServers`, using Pi's built-in MCP or `pi-mcp-adapter`.
- `idleTimeoutMs` and `wrapUpMs`: stop silent agents, let timed-out ones
  report first.
- New README with ready-made configs.

## 0.2.0

- **Breaking:** `~/.pi/agent/opium.json` is the only agent config.
- Background agents on pi-agent-runner, with results delivered to the
  session, a job board, idle wake and `wait_for_user`.
- Live list of running agents above the editor.
- The council: three seats with model fallback and a synthesizer.
- Model presets and `/opium-preset`.
- Path guards, tool loop guard, JSON error recovery, `/reflect` and
  `/deepwork`.

## 0.1.1

- First release.
