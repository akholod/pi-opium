# pi-opium

Daily-work orchestration for pi, ported from oh-my-opencode-slim: an
orchestrator prompt for the main session, specialist agents (explorer,
librarian, oracle, designer, fixer, fast-generic, observer) and a
multi-model council. Agents run in-process through
[pi-agent-runner](https://github.com/akholod/pi-agent-runner); no other
subagent extension is needed.

For the full roster install `pi-mcp-adapter` with a `codegraph` server
(explorer, fixer, oracle) and `pi-web-access` (librarian).

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

Agent prompts, models, tools and limits are in `agents/*.md`; copy a file to
`~/.pi/agent/agents/` to override it. To change only the model or thinking
level, add an entry to `~/.pi/agent/opium.json`:

```json
{
  "agents": {
    "oracle": { "model": "claude-bridge/claude-fable-5-1", "thinking": "high" }
  }
}
```

Without an entry there, `subagents.agentOverrides` in
`~/.pi/agent/settings.json` (model and thinking) still applies. Run
transcripts are kept in `~/.pi/agent/opium/runs/`.
