# pi-opium

Daily-work orchestration for pi, ported from oh-my-opencode-slim: an
orchestrator prompt for the main session plus specialist agents
(explorer, librarian, oracle, designer, fixer, fast-generic, observer)
and a multi-model council, all run through `pi-subagents`.

Requires `pi-subagents`; `pi-mcp-adapter` with a `codegraph` server and
`pi-web-access` for the full roster.

## Install

```bash
pi install git:github.com/akholod/pi-opium
```

Then in pi: `/reload`, check the roster with `/subagents`, and pick the
orchestrator model for the main session (`/model openai-codex/gpt-6-sol`).

## Usage

The orchestrator prompt is on by default and delegates through
`subagent({ agent, task })`.

```
/orchestrator on | off | status
/council <question>
```

The council is also available to the model as the `council` tool.
Agent models and tools are in `agents/*.md`; copy a file to
`~/.pi/agent/agents/` to override it.
