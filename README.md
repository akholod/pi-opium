<p align="center">
  <img src="assets/hero.webp" alt="Opium: an orchestrator of specialist agents for Pi" width="100%">
</p>

# Opium

Turn your Pi session into a small team.

## The problem

One agent doing everything in one chat gets slow and blurry. It searches
the codebase, reads docs, writes code and reviews it, all in the same
context, while you wait. The context fills up with grep output, and a big
decision rests on a single model's opinion.

## What Opium does

Your Pi session becomes the lead. It hands work to specialists that run in
the background while you keep talking, and their results come back to your
session on their own. When a decision matters, it asks a council of
different models and shows you where they agree.

```text
agents ─────────────────────────────────────────── 2 running
⠋ fixer       opium  sonnet-5-5  t4  bash        12.3k  0:41
⠙ scout       opium  gpt-6-luna  t2  grep         3.1k  0:08
✓ researcher  opium  gpt-6-luna  t6  done         8.1k  0:22
```

## Install

```sh
pi install git:github.com/akholod/pi-opium
```

Start Pi (or `/reload` a running session) and keep working as usual. Every agent starts on your
session's model, so it works with whatever provider you have.

Your session's model is the lead: it decides what to hand off and to whom.
Pick a strong one (`/model`). For web research, also install
`pi-web-access`.

## How it looks in practice

Just ask:

- "Find where auth tokens are refreshed" → scout searches, you keep going.
- "Fix the failing tests in `api/`" → fixer works in the background and
  reports back.
- "Get a second opinion on this migration plan" → the council answers.

While agents run, a list above the editor shows what each one is doing.
Inside herdr or tmux, each one also gets a read-only pane that closes when
it's done.

## The team

| Agent        | Does                                             |
| ------------ | ------------------------------------------------ |
| scout        | finds files and code, fast                       |
| researcher   | reads docs and the web, answers with sources     |
| senior       | architecture, hard bugs, code review             |
| designer     | UI and UX, built and polished                    |
| fixer        | writes the code for a clear, bounded task        |
| fast-generic | git, commits, tests, builds                      |
| vision       | images for models that can't see them            |
| council      | three models answer, one sums up where they land |

## Handy commands

- `/council <question>`: ask the council directly.
- `/opium-preset [name|off]`: switch the models the team uses.
- `/opium-doctor`: check your setup; `--live` also pings every model.
- `/reflect`: review how the session went and suggest improvements.
- `/deepwork <task>`: a stricter workflow for big, risky changes.
- `/orchestrator off`: back to a plain Pi session.

## Works better with

- [pi-web-access](https://github.com/nicobailon/pi-web-access): lets researcher search the web and read pages.
- `pi mcp add context7 --url https://mcp.context7.com/mcp` and `pi mcp add gh_grep --url https://mcp.grep.app`: up-to-date library docs and GitHub code search for researcher.
- Any other MCP server added with `pi mcp add`: give it to an agent in `opium.json`, for example `"scout": { "mcpServers": ["my-index"] }`.

## Config

One file: `~/.pi/agent/opium.json`, created on first run. Out of the box
every agent uses your session's model. Give an agent its own model, a
backup model or a time limit:

```json
{
  "agents": {
    "senior": { "model": "claude-bridge/claude-fable-5-1", "thinking": "high" },
    "fixer": {
      "model": "openai-codex/gpt-6-luna",
      "fallbackModels": ["claude-bridge/claude-sonnet-5-5"]
    }
  }
}
```

**The council needs different models.** Three seats on the same model is
one opinion said three times. Give `councillor-alpha`, `councillor-beta`
and `councillor-gamma` different models; Opium warns you until you do.

Ready-made configs: [ideal](docs/examples/ideal.md) (Claude, OpenAI and
open models together) and [OpenAI only](docs/examples/openai.md). Every
option: [docs/configuration.md](docs/configuration.md).

## Under the hood

Agents run inside your Pi process through
[pi-agent-runner](https://github.com/akholod/pi-agent-runner). They follow
your permission rules, ask you in the usual dialog, and wrap up with a
report when their time runs out.

## Credits

Inspired by
[oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim).

MIT
