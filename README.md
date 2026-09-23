# pi-opium

Daily-work orchestration for [pi](https://github.com/badlogic/pi-mono), ported
from [oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim):
an orchestrator prompt for the main session plus a roster of specialist
agents run through [pi-subagents](https://www.npmjs.com/package/pi-subagents).
For complex tasks use [pi-spiral](../spiral) (`/ralplan`, `/ralph`); this
package does not mention them, you call them yourself.

## Requirements

- pi >= 0.87, `pi-subagents`, `pi-mcp-adapter` with a `codegraph` server,
  `pi-web-access` (librarian).
- Providers: `openai-codex` (gpt-6-sol, gpt-6-astra, gpt-6-luna) and
  `opencode-go` (kimi-k2.7-code, kimi-k3, deepseek-v4-pro, glm-5.3).

## Install

```bash
pi install /home/andrii/pi_sandbox/opium   # extension + agents + simplify skill
/reload
/subagents                                 # roster should list the agents below
/model openai-codex/gpt-6-sol              # the orchestrator model (main session)
```

## What you get

**Orchestrator prompt** appended to the main session's system prompt as an
`<orchestrator>` section on every turn: lane rules for each specialist,
delegation thresholds, parallelization, background-run discipline in
pi-subagents terms (`subagent({ agent, task })`, `status`, `steer`,
`resume`, `stop`), design handoff rules and the communication style.
`/orchestrator on | off | status` toggles it; the state persists in
`~/.pi/agent/opium.json` (default on).

**Agents** (`agents/*.md`, user scope overrides them):

| Agent | Model | Tools | Notes |
|---|---|---|---|
| explorer | openai-codex/gpt-6-luna :low | read, grep, find, ls, mcp:codegraph | background |
| librarian | openai-codex/gpt-6-luna :low | read-only + web_search, fetch_content, source_check | background |
| oracle | openai-codex/gpt-6-astra :xhigh | read, grep, find, ls, mcp:codegraph; skill simplify | background, forked context |
| designer | opencode-go/kimi-k2.7-code :medium | all builtins; skill make-interfaces-feel-better | background, writer |
| fixer | openai-codex/gpt-6-luna :medium | all builtins + mcp:codegraph; skills pnpm, node | background, writer |
| fast-generic | openai-codex/gpt-6-luna :low | read, grep, find, ls, bash | background, git + validation only |
| observer | openai-codex/gpt-6-luna :low | read | foreground, vision |
| councillor-alpha/beta/gamma | gpt-6-luna / deepseek-v4-pro / glm-5.3 :high | read, grep, find, ls | used by /council |
| council | opencode-go/kimi-k3 :high | none | synthesizer |

Agents that need MCP or web tools run as background children: pi-subagents
loads ambient extensions only there. `async: true` is set in their
frontmatter so a plain `subagent({ agent, task })` does the right thing.

**Council**: `/council <question>` or the `council` tool. Three councillors
answer in parallel on different models, the council agent synthesizes a
report with Council Response, Per-Councillor Details and Council Summary.

## Differences from oh-my-opencode-slim

- `luna-fast` has no equivalent for gpt-6-luna: pi-subagents' `fast` tier
  is allowlisted for gpt-5.6-luna/sol only. Agents use plain gpt-6-luna.
- `qwen3.7-max` is not in the opencode-go catalog; councillor beta uses
  deepseek-v4-pro.
- librarian's context7 / grep_app / gh_app MCPs are not configured in pi;
  it uses pi-web-access instead.
- oracle and the councillors have no shell (tool allowlists are the only
  boundary pi-subagents has).
- No task board, wake scheduler or session-reuse aliases: pi-subagents'
  native completion notifications, `status`, `steer` and `resume` cover
  the same flow.
- Hooks (tool-loop-guard, phase-reminder, foreground-fallback) are not
  ported.

## Layout

```
extensions/crew.ts   before_agent_start section, /orchestrator, /council, council tool
src/prompt.ts        orchestrator prompt builder
src/council.ts       parallel councillors + synthesis over the delegation contract
src/delegation.ts    local copy of the pi-subagents delegation contract
src/state.ts         on/off persistence
agents/*.md          specialist definitions (pi-subagents frontmatter)
skills/simplify      OMOS simplify skill (used by oracle)
```
