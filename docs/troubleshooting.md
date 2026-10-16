# Troubleshooting

Start with the doctor. Back to the [README](../README.md).

```text
/opium-doctor          in Pi: config, models, credentials, council, skills, MCP
/opium-doctor --live   the same, then a short ping to every model
```

From a shell, or for another agent, the same report goes to stdout:

```sh
pi -p --no-session "/opium-doctor --live"
```

Every problem line comes with a `fix:` line. The common ones:

## An agent's model fails

- **`model not found`**: the id in `opium.json` is wrong or the model was
  renamed. Compare with `pi --list-models` and fix it. Copilot names use
  dots (`claude-sonnet-5.5`), most others dashes.
- **`no credentials for <provider>`**: run `/login <provider>` in Pi, or
  set the provider's API key variable.
- **The ping fails with `--live`**: the provider rejected the request.
  Common causes: the subscription ran out or does not cover that model,
  or the rate limit was hit. Pick another model, or add a
  `fallbackModels` entry from another provider so the agent switches
  when the first one fails.
- **`inherit: this session has no model`**: the agent has no model of
  its own and the session has none either. Pick one with `/model`.

## The council warns that seats share a model

All three `councillor-*` agents end up on one model, so their answers are
not independent. Give them three different models; see
[models.md](models.md).

## researcher cannot search the web

Install `pi-web-access` (`pi install npm:pi-web-access`) and restart Pi.

## An MCP server is not found

- Add it with `pi mcp add <name> --url <url>` and run `pi mcp list` to
  check that it connects.
- `pi-mcp-adapter` installed? It replaces Pi's built-in MCP, so add the
  server to its config (`~/.config/mcp/mcp.json`) instead.
- `codegraph`, `context7` and `gh_grep` are optional: when you do not
  have them, the agents work without them and the doctor stays quiet.

## pi-lens is not installed

`pi install npm:pi-lens`. It needs Node 22.19 or newer. Then restart Pi.

## `pi-agent-runner is missing ...`

The Pi process still has an older copy of Opium's runner in memory.
Quit Pi fully and start it again (`pi -c` continues the last session).
`/reload` is enough for most Opium updates, but not when the runner
changed.

## No panes open in herdr or tmux

Panes open only when Pi runs inside herdr or tmux. At most three are open
at once; a fourth agent runs without one. Check `"panes"` in
`opium.json`: `false` turns them off.

## An agent seems stuck

The list above the editor shows what each agent is doing right now. An
agent that does nothing for 10 minutes is stopped, and one that runs out
of time is asked to report first. Ask the lead to cancel or revive it,
or lower `timeoutMs` and `idleTimeoutMs` for that agent.

## Attached images end up in the project

When your session's model cannot see images, Opium saves attached ones
to `.pi/opium/images/` so vision can read them. Add that folder to
`.gitignore`.

## Start over

- Back to a plain Pi session for now: `/orchestrator off`.
- Fresh config: rename `~/.pi/agent/opium.json`; the next start writes a
  new one from the defaults.
- Remove Opium: `pi remove npm:pi-opium` (or the `git:` source you
  installed from). `opium.json` and the run transcripts in
  `~/.pi/agent/opium/runs/` stay until you delete them.

Still stuck? Open an issue with the doctor's output:
<https://github.com/akholod/pi-opium/issues>.
