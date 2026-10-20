# The agents

Your Pi session is the lead. It reads your request, splits it into parts
and hands each part to the agent that fits, often several at once. You
can also name one: "ask senior to review this", "let fixer do it". Back
to the [README](../README.md).

Agents that run in the background return right away; their reports come
back to your session on their own while you keep working. Each agent
starts fresh: it sees only the task the lead wrote for it, not your chat.

## Who does what

**scout** finds things in the codebase: files, symbols, call paths,
"where is X". It reads only and answers with paths and line numbers.
Background, thinking `low`, 10 minutes.

**researcher** answers from outside the repo: library docs, API
references, known bugs, "how do others solve this". It cites sources.
Needs `pi-web-access` for the web; reads library docs with the Context7
CLI (`ctx7`) and uses the grep.app MCP server when you have it. Its shell
only runs `ctx7 library` and `ctx7 docs`; it cannot change files. Background, `low`, 15 minutes.

**senior** is for decisions that are expensive to get wrong: architecture,
a bug that survived two fixes, risky refactors, code review,
simplification. It advises and does not edit. Background, `xhigh`, 20
minutes, with the `simplify` skill.

**designer** builds and polishes what users see: layout, spacing,
hierarchy, motion, responsive behavior. It edits files. Weak at copy, so
the lead reviews the wording afterwards. Background, `medium`, 2 hours.

**fixer** writes code for a task that is already decided: clear scope,
files and checks given. Several fixers can work in parallel on separate
files. It edits files and runs the checks it was told to. Background,
`medium`, 2 hours.

**fast-generic** does routine command work: `git status` and `diff`,
commits, pushes, tests, lint, builds. It does not edit code. Background,
`low`, 15 minutes.

**vision** describes images, screenshots, PDFs and diagrams for models
that cannot see them. When your session's model sees images, vision is
left out. Thinking `low`, 10 minutes.

**council** asks three models the same question
(`councillor-alpha`, `-beta`, `-gamma`, read-only), then a fourth sums up
where they agree and differ. Use it for high-stakes calls, or run
`/council <question>` yourself. Thinking `high`, 15 minutes.

## What they may do

| Agent        | Reads | Edits files | Shell | Web |
| ------------ | :---: | :---------: | :---: | :-: |
| scout        |   ✓   |             |       |     |
| researcher   |   ✓   |             |       |  ✓  |
| senior       |   ✓   |             |       |     |
| designer     |   ✓   |      ✓      |   ✓   |     |
| fixer        |   ✓   |      ✓      |   ✓   |     |
| fast-generic |   ✓   |             |   ✓   |     |
| vision       |   ✓   |             |       |     |
| councillors  |   ✓   |             |       |     |

designer has no tool list of its own: it gets the tools a plain Pi
session would have.

Every agent follows your Pi permission rules and asks you through the
usual dialog. Agents other than fast-generic cannot run `git push`,
`reset --hard`, `clean -f`, `branch -D` and similar commands that throw
work away; fast-generic may push, but not rewrite history unless you
asked for exactly that. This is a guardrail, not a sandbox.

With `pi-lens` in an agent's `extensions`, it also gets code navigation
and diagnostics; agents that cannot edit files are refused renames and
code actions through it.

## Time limits

When an agent runs out of time it is asked to wrap up and report, and is
stopped only if no answer comes. A stopped agent keeps its session, so
the lead can revive it to get the report or continue. An agent that
produces nothing for 10 minutes is stopped too; waiting for you or for a
long command does not count.

All of the above can be changed per agent in `~/.pi/agent/opium.json`:
see [configuration.md](configuration.md). Models are in
[models.md](models.md).

## Your own agents and prompts

Agent prompts live in Opium's `agents/*.md`. To change one, copy it to
`~/.pi/agent/agents/` and edit the copy. A new `.md` there with
`advertise: true` becomes an agent the lead can call.
