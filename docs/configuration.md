# Configuration

Everything Opium reads from `~/.pi/agent/opium.json`, the only configuration file. Back to the [README](../README.md).

## Agents and `opium.json`

Out of the box no agent has a `model`, so every agent, council seats
included, runs on the model of your Pi session. Set models per agent, or
keep a few setups as presets. For example, the models Opium was tuned
with:

```json
{
  "preset": "tuned",
  "presets": {
    "tuned": {
      "scout": { "model": "openai-codex/gpt-6-luna" },
      "researcher": { "model": "openai-codex/gpt-6-luna" },
      "senior": { "model": "openai-codex/gpt-6-astra" },
      "designer": { "model": "opencode-go/kimi-k2.7-code" },
      "fixer": { "model": "openai-codex/gpt-6-luna" },
      "fast-generic": { "model": "openai-codex/gpt-6-luna" },
      "vision": { "model": "openai-codex/gpt-6-luna" },
      "councillor-alpha": { "model": "openai-codex/gpt-6-luna" },
      "councillor-beta": { "model": "opencode-go/deepseek-v4-pro" },
      "councillor-gamma": { "model": "opencode-go/glm-5.3" },
      "council": { "model": "opencode-go/kimi-k3" }
    }
  }
}
```

Complete configs to copy: [ideal](examples/ideal.md),
[OpenAI only](examples/openai.md).

When all three council seats resolve to the same model, `/council` and the
`council` tool add a note: the answers are not independent opinions.

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
| `mcpServers`     | list of MCP server names                                  |

`mcpServers` gives an agent MCP servers, for example servers added with
`pi mcp add`. It replaces any `mcp:<server>` entries in the agent's `.md`
`tools` (custom agents may keep using those as a default). Pi's built-in MCP
is used when it has the server enabled; otherwise the server is looked up in
the `pi-mcp-adapter` config (`~/.config/mcp/mcp.json`) and that extension is
loaded for the agent. A server found in neither is skipped without a warning.
Council seats get no MCP servers. By default scout, fixer and senior ask
for a server named `codegraph`: if you have one, they use it; if not,
nothing happens.

`timeoutMs` is the wall-clock cap of one generation. When it expires the agent
is asked to give its final answer and is stopped only if none arrives within
`wrapUpMs`; a wrapped-up answer is reported with a note, and a stopped run
(`timed_out`) keeps its session, so `agent_revive` can get its report or
continue. `idleTimeoutMs` stops an agent that produced no events for that long;
it is paused while a tool runs or a person is asked.

Precedence, per field, lowest to highest: the built-in fallbacks < the active
preset < `agents`.

Run transcripts are kept in `~/.pi/agent/opium/runs/`.
