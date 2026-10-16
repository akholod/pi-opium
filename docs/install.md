# Install Opium: instructions for an AI agent

You are an AI coding agent. The user asked you to install and configure
Opium, an extension for the Pi coding agent that hands work to specialist
agents (scout, researcher, senior, designer, fixer, fast-generic, vision)
and a council of three models.

Follow the steps in order. A step marked **ASK** needs the user's answer:
ask, wait for the reply, never guess it. Run every command yourself unless
the step says the user has to do it. Never read, print or copy
`~/.pi/agent/auth.json` or any API key.

Humans: the same steps work by hand. Ready-made model setups are in
[models.md](models.md).

## 1. Check Pi

```sh
pi --version
pi list
```

- Pi missing: ask the user to install it
  (`npm install -g @earendil-works/pi-coding-agent`) and come back. Opium
  needs Pi 1.1 or newer.
- `pi list` already shows `pi-opium` (or `github.com/akholod/pi-opium`):
  Opium is installed. Skip the install commands in step 4 and keep the
  user's existing config (step 5 explains how).

## 2. ASK: basic or full install

Ask the user which install they want:

- **Full (recommended):** Opium plus the tools that make the agents better:
  - `pi-web-access`: web search and page reading for researcher;
  - `pi-lens`: code navigation and diagnostics for senior and fixer;
  - Context7: current library docs for researcher (MCP server);
  - grep.app: code search across GitHub for researcher (MCP server).
- **Basic:** Opium only. researcher then has no web search.

## 3. ASK: which subscriptions and keys

Ask which AI subscriptions or API keys the user has. Several can be true.
Offer this list:

| User has                    | Pi provider      | Or the environment variable |
| --------------------------- | ---------------- | --------------------------- |
| Claude Pro or Max           | `anthropic`      |                             |
| ChatGPT Plus or Pro (Codex) | `openai-codex`   |                             |
| GitHub Copilot              | `github-copilot` | `COPILOT_GITHUB_TOKEN`      |
| OpenCode Go                 | `opencode-go`    | `OPENCODE_API_KEY`          |
| OpenCode Zen                | `opencode`       | `OPENCODE_API_KEY`          |
| Gemini API key              | `google`         | `GEMINI_API_KEY`            |
| Kimi For Coding             | `kimi-coding`    | `KIMI_API_KEY`              |
| Z.ai GLM Coding Plan        | `zai`            | `ZAI_API_KEY`               |
| OpenRouter                  | `openrouter`     | `OPENROUTER_API_KEY`        |
| Anthropic API key           | `anthropic`      | `ANTHROPIC_API_KEY`         |
| OpenAI API key              | `openai`         | `OPENAI_API_KEY`            |

Every provider can sign in with `/login` inside Pi: subscriptions
through the browser, keys by pasting them.

Then see what Pi can use right now:

```sh
pi --list-models
```

It lists only providers Pi has credentials for. When a provider the user
named is missing, the user has to sign in: ask them to run `pi`, type
`/login`, pick the provider, finish in the browser and quit Pi (or to set
the environment variable from the table). Wait, then run
`pi --list-models` again. You cannot do the browser sign-in for them.

From here on, use only models that `pi --list-models` shows.

## 4. Install

Basic and full:

```sh
pi install npm:pi-opium
```

If npm does not have it yet, use `pi install git:github.com/akholod/pi-opium`.

Full only, skipping what `pi list` already shows:

```sh
pi install npm:pi-web-access
pi install npm:pi-lens
pi mcp add context7 --url https://mcp.context7.com/mcp
pi mcp add gh_grep --url https://mcp.grep.app
```

If `pi list` shows `pi-mcp-adapter`, it replaces Pi's built-in MCP: add
the two servers to its config (`~/.config/mcp/mcp.json`) instead of using
`pi mcp add`. Opium finds servers in either place.

pi-lens needs Node 22.19 or newer (`node --version`). If Node is older,
skip pi-lens, tell the user, and leave it out of step 5.

## 5. Configure

Opium's whole config is `~/.pi/agent/opium.json` (in
`$PI_CODING_AGENT_DIR` instead, when that is set). Opium creates it from
its defaults the first time Pi loads it. Run this once so the file exists
(it needs one signed-in provider from step 3; with none, Pi stops with
`No API key found` before loading Opium):

```sh
pi -p --no-session "/opium-doctor"
```

If the file was there before you started, back it up first:

```sh
cp ~/.pi/agent/opium.json ~/.pi/agent/opium.json.bak-$(date +%Y%m%d-%H%M%S)
```

**Edit the file, do not rewrite it.** Opium never merges it with its
defaults: the `agents` block holds each agent's thinking level, time
limits, background mode and MCP servers, and dropping it breaks the
agents. Keep every key that is already there.

Put the models into a **preset**, beside `agents`:

1. Pick the preset from [models.md](models.md) that matches the user's
   subscriptions. Copy it under `"presets"` and set `"preset"` to its name.
2. Several subscriptions: start from the closest preset and spread the
   roles across providers with the role table below. The three council
   seats (`councillor-alpha`, `councillor-beta`, `councillor-gamma`) must
   be three different models, from different providers when possible.
   Add `fallbackModels` from another provider where you can.
3. Replace any model that `pi --list-models` does not show with the
   closest one that it does, from the same row of the role table.
4. An agent inside `agents` that already has a `model` beats the preset.
   Ask the user whether to keep it or move it into the preset.
5. Full install: add `"extensions": ["pi-lens"]` to `agents.senior` and
   `agents.fixer`, keeping their other fields.

| Role                            | Wants                                             |
| ------------------------------- | ------------------------------------------------- |
| lead (the Pi session itself)    | the strongest model; it plans and delegates       |
| senior                          | the strongest reasoning model                     |
| councillor-alpha/beta/gamma     | three different strong models                     |
| council (sums up the seats)     | a strong model                                    |
| designer                        | strong, good at UI, sees images                   |
| fixer                           | a good coding model                               |
| scout, researcher, fast-generic | fast and cheap                                    |
| vision                          | cheap and sees images (`images: yes` in the list) |

The result looks like this, with the `agents` block unchanged except for
pi-lens:

```json
{
  "orchestrator": true,
  "preset": "claude",
  "presets": {
    "claude": {
      "senior": { "model": "anthropic/claude-fable-5-1" },
      "fixer": { "model": "anthropic/claude-sonnet-5-5" }
    }
  },
  "agents": {
    "senior": {
      "thinking": "xhigh",
      "skills": ["simplify"],
      "background": true,
      "timeoutMs": 1200000,
      "idleTimeoutMs": 600000,
      "wrapUpMs": 180000,
      "mcpServers": ["codegraph"],
      "extensions": ["pi-lens"]
    }
  }
}
```

(Only `senior` is shown; the other agents stay as they were.)

The lead is the model of the user's Pi session, not part of
`opium.json`. Suggest the one from the preset; the user sets it with
`/model` in Pi. Change `defaultProvider` and `defaultModel` in
`~/.pi/agent/settings.json` only if the user asks you to.

## 6. Verify

```sh
pi -p --no-session "/opium-doctor --live"
```

It checks the config, every agent's model and credentials, the council,
skills, MCP servers and extensions, then pings each model. The last line
must say `0 problems`. Fix every problem it lists (each line names its
fix; more in [troubleshooting.md](troubleshooting.md)) and run it again.
Warnings are fine to report and leave if the user agrees.

## 7. Report

Tell the user, briefly:

- what you installed;
- the preset name and the model of each role, as a table;
- the backup path, if you made one;
- running Pi sessions need a full restart (`pi -c` continues the last
  session); new sessions just work;
- switch setups with `/opium-preset <name>`, check with `/opium-doctor`;
- undo: `pi remove npm:pi-opium` (and the other packages), then restore
  the backup or delete `~/.pi/agent/opium.json`.

Then suggest a first try: "Ask the council: should this project use
SQLite or Postgres?" or "Find where errors are logged".
