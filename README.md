# pi-opium

Daily-work orchestration for pi, ported from oh-my-opencode-slim: an
orchestrator prompt for the main session, specialist agents (scout,
researcher, senior, designer, fixer, fast-generic, vision) and a
multi-model council. Agents run in-process through
[pi-agent-runner](https://github.com/akholod/pi-agent-runner); no other
subagent extension is needed.

For the full roster install `pi-mcp-adapter` with a `codegraph` server
(scout, fixer, senior) and `pi-web-access` (researcher).

## Install

```bash
pi install git:github.com/akholod/pi-opium
```

Then in pi: `/reload` and pick the orchestrator model for the main session
(`/model openai-codex/gpt-6-sol`).

## Usage

The orchestrator prompt is on by default and delegates through the
`agent` tools:

| Tool            | Purpose                                                    |
| --------------- | ---------------------------------------------------------- |
| `agent`         | Start a specialist (background or foreground), or `resume` |
| `agent_status`  | One run, or every run of this session                      |
| `agent_result`  | The result of a finished run                               |
| `agent_message` | A note to a running specialist (`queue` or `steer`)        |
| `agent_cancel`  | Stop the current run; the session is kept                  |
| `agent_revive`  | Continue a finished or cancelled run with a new task       |

Background results are delivered to the session when they finish: as a
new turn when it is idle, steered into the current turn when it is busy.

```
/orchestrator on | off | status
/council <question>
```

The council is also available to the model as the `council` tool.

## Agents

Agent prompts are in `agents/*.md`, with structural metadata only (`name`,
`description`, `tools`, `advertise`, `contextFiles`); copy a file to
`~/.pi/agent/agents/` to replace it. A runtime key (`model`, `thinking`,
`timeoutMs`, ...) in an `.md` is an error: those values live in
`~/.pi/agent/opium.json`, the single configuration file. The shipped defaults
for every agent are in `defaults/opium.json`; on first run, when
`~/.pi/agent/opium.json` does not exist, it is created as a copy of them. An
existing file is never touched or merged with the defaults. Example:

```json
{
  "orchestrator": true,
  "wake": { "enabled": true, "intervalMs": 300000 },
  "preset": "cheap",
  "presets": {
    "base": { "fixer": { "model": "openai-codex/gpt-6-sol" } },
    "cheap": { "extends": "base", "senior": { "thinking": "low" } }
  },
  "agents": {
    "senior": { "model": "claude-bridge/claude-fable-5-1", "thinking": "high" },
    "fixer": {
      "timeoutMs": 7200000,
      "idleTimeoutMs": 600000,
      "wrapUpMs": 180000,
      "gitGuard": true,
      "skills": ["tdd"]
    },
    "councillor-alpha": {
      "model": "openai-codex/gpt-6-sol",
      "fallbackModels": ["claude-bridge/claude-fable-5-1"]
    },
    "councillor-beta": {
      "model": "claude-bridge/claude-fable-5-1",
      "fallbackModels": ["openai-codex/gpt-6-sol"]
    },
    "councillor-gamma": { "model": "claude-bridge/claude-opus-5-5" },
    "council": { "model": "claude-bridge/claude-fable-5-1" }
  }
}
```

- `orchestrator`: enable the orchestrator prompt (`/orchestrator on|off`).
- `wake { enabled, intervalMs }`: periodic wake-up for running background
  agents.
- `preset` / `presets`: named sets of per-agent overrides; a preset may
  `extends` another. `/opium-preset [name|off]` lists or switches.
- `agents.<name>`: per-agent overrides, also valid inside a preset. Council
  seats (`councillor-alpha|beta|gamma`) and the synthesizer (`council`) are
  ordinary agents and use the same overrides.

Override fields (unknown fields are errors; an invalid value is reported as a
warning and that field is ignored). When `opium.json` sets nothing for an
agent, the built-in fallbacks apply: model `inherit` (the parent session's),
thinking inherited, no timeouts, `background` false, `permissionAsks`
`forward`, `gitGuard` true, no skills.

| Field            | Value                                                     |
| ---------------- | --------------------------------------------------------- |
| `model`          | `provider/id`                                             |
| `fallbackModels` | list of `provider/id`                                     |
| `thinking`       | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `timeoutMs`      | positive number (ms), the hard cap on a generation        |
| `idleTimeoutMs`  | positive number (ms), stop after this long with no events |
| `wrapUpMs`       | positive number (ms), grace to answer after `timeoutMs`   |
| `toolTimeoutMs`  | positive number                                           |
| `background`     | `true` / `false`                                          |
| `permissionAsks` | `forward` or `deny`                                       |
| `gitGuard`       | `true` / `false`                                          |
| `skills`         | list of skill names                                       |

`timeoutMs` is the wall-clock cap of one generation. When it expires the agent
is asked to give its final answer and is stopped only if none arrives within
`wrapUpMs`; a wrapped-up answer is reported with a note, and a stopped run
(`timed_out`) keeps its session, so `agent_revive` can get its report or
continue. `idleTimeoutMs` stops an agent that produced no events for that long;
it is paused while a tool runs or a person is asked.

Precedence, per field, lowest to highest: the built-in fallbacks < the active
preset < `agents`.

`~/.pi/agent/settings.json` is no longer read: `subagents.agentOverrides`
there has no effect, so move those values into `agents` in `opium.json`.

Run transcripts are kept in `~/.pi/agent/opium/runs/`.
