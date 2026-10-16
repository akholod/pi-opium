# Models

Out of the box every Opium agent runs on your Pi session's model. That
works, but the team gets faster and better when each role has a model that
fits it. Back to the [README](../README.md).

## Which model for which role

| Role                            | Wants                                       |
| ------------------------------- | ------------------------------------------- |
| lead (your Pi session)          | the strongest model; it plans and delegates |
| senior                          | the strongest reasoning model               |
| councillor-alpha/beta/gamma     | three different strong models               |
| council (sums up the seats)     | a strong model                              |
| designer                        | strong, good at UI, sees images             |
| fixer                           | a good coding model                         |
| scout, researcher, fast-generic | fast and cheap                              |
| vision                          | cheap and sees images                       |

`pi --list-models` shows what you can use; its `images` column tells
which models see images. The lead is set with `/model` in Pi, not in
`opium.json`.

**Give the council three different models.** Three seats on one model
are one opinion said three times. Different providers are better still.

## How to use a preset

Each setup below is a preset. Add it under `"presets"` in
`~/.pi/agent/opium.json`, beside the `agents` block, which stays as it
is, and select it with `"preset"`:

```json
{
  "preset": "claude",
  "presets": {
    "claude": { "senior": { "model": "anthropic/claude-fable-5-1" } }
  }
}
```

A preset only sets models, so the thinking levels, time limits and tools
in `agents` keep working. A `model` set inside `agents` wins over the
preset. Keep several presets and switch with `/opium-preset <name>`;
`/opium-doctor` shows what each agent ends up with.

Model names change. If a model below is missing from
`pi --list-models`, take the closest one from the same role.

## Claude (Pro or Max)

Lead: `/model anthropic/claude-opus-5-5`.

```json
"claude": {
  "senior": { "model": "anthropic/claude-fable-5-1" },
  "designer": { "model": "anthropic/claude-opus-5-5" },
  "fixer": { "model": "anthropic/claude-sonnet-5-5" },
  "scout": { "model": "anthropic/claude-haiku-5-5" },
  "researcher": { "model": "anthropic/claude-haiku-5-5" },
  "fast-generic": { "model": "anthropic/claude-haiku-5-5" },
  "vision": { "model": "anthropic/claude-haiku-5-5" },
  "councillor-alpha": { "model": "anthropic/claude-fable-5-1" },
  "councillor-beta": { "model": "anthropic/claude-opus-5-5" },
  "councillor-gamma": { "model": "anthropic/claude-sonnet-5-5" },
  "council": { "model": "anthropic/claude-fable-5-1" }
}
```

## ChatGPT (Plus or Pro, Codex)

Lead: `/model openai-codex/gpt-6.1-sol`.

```json
"chatgpt": {
  "senior": { "model": "openai-codex/gpt-6-astra" },
  "designer": { "model": "openai-codex/gpt-6.1-sol" },
  "fixer": { "model": "openai-codex/gpt-6-sol" },
  "scout": { "model": "openai-codex/gpt-6-luna" },
  "researcher": { "model": "openai-codex/gpt-6-luna" },
  "fast-generic": { "model": "openai-codex/gpt-6-luna" },
  "vision": { "model": "openai-codex/gpt-6-luna" },
  "councillor-alpha": { "model": "openai-codex/gpt-6.1-sol" },
  "councillor-beta": { "model": "openai-codex/gpt-6-astra" },
  "councillor-gamma": { "model": "openai-codex/gpt-6-luna" },
  "council": { "model": "openai-codex/gpt-6-astra" }
}
```

## GitHub Copilot

Copilot carries models from several labs, so the council gets three
different ones. Lead: `/model github-copilot/claude-opus-5.5`.

```json
"copilot": {
  "senior": { "model": "github-copilot/gpt-6-astra" },
  "designer": { "model": "github-copilot/claude-opus-5.5" },
  "fixer": { "model": "github-copilot/claude-sonnet-5.5" },
  "scout": { "model": "github-copilot/gpt-6-luna" },
  "researcher": { "model": "github-copilot/gpt-6-luna" },
  "fast-generic": { "model": "github-copilot/gpt-6-luna" },
  "vision": { "model": "github-copilot/gpt-6-luna" },
  "councillor-alpha": { "model": "github-copilot/claude-fable-5.1" },
  "councillor-beta": { "model": "github-copilot/gpt-6-astra" },
  "councillor-gamma": { "model": "github-copilot/gemini-4-argon" },
  "council": { "model": "github-copilot/claude-opus-5.5" }
}
```

## OpenCode Go

Open models from several labs. GLM and DeepSeek Pro do not see images;
Opium gives senior a vision tool for that. Lead:
`/model opencode-go/kimi-k3`.

```json
"opencode-go": {
  "senior": { "model": "opencode-go/deepseek-v4-pro" },
  "designer": { "model": "opencode-go/kimi-k3" },
  "fixer": { "model": "opencode-go/kimi-k2.7-code" },
  "scout": { "model": "opencode-go/deepseek-v4.1-flash" },
  "researcher": { "model": "opencode-go/deepseek-v4.1-flash" },
  "fast-generic": { "model": "opencode-go/deepseek-v4.1-flash" },
  "vision": { "model": "opencode-go/qwen3.8-flash" },
  "councillor-alpha": { "model": "opencode-go/glm-5.3" },
  "councillor-beta": { "model": "opencode-go/deepseek-v4-pro" },
  "councillor-gamma": { "model": "opencode-go/qwen3.8-max" },
  "council": { "model": "opencode-go/kimi-k3" }
}
```

## Gemini (API key)

Pi reaches Gemini with a `GEMINI_API_KEY`. Lead:
`/model google/gemini-4-argon`.

```json
"gemini": {
  "senior": { "model": "google/gemini-4-argon" },
  "designer": { "model": "google/gemini-4-argon" },
  "fixer": { "model": "google/gemini-4-argon" },
  "scout": { "model": "google/gemini-3.8-flash" },
  "researcher": { "model": "google/gemini-3.8-flash" },
  "fast-generic": { "model": "google/gemini-3.8-flash" },
  "vision": { "model": "google/gemini-3.8-flash" },
  "councillor-alpha": { "model": "google/gemini-4-argon" },
  "councillor-beta": { "model": "google/gemini-3.1-pro-preview" },
  "councillor-gamma": { "model": "google/gemini-3.8-flash" },
  "council": { "model": "google/gemini-4-argon" }
}
```

## Several subscriptions: Claude, ChatGPT and OpenCode Go

What Opium is developed with. Claude does the heavy work, GPT-6 Luna the
quick lookups, and the council sits on three providers. Every agent falls
back to another provider when its own is down or out of quota. Lead:
`/model anthropic/claude-opus-5-5`.

```json
"mixed": {
  "senior": {
    "model": "anthropic/claude-fable-5-1",
    "fallbackModels": ["openai-codex/gpt-6-astra"]
  },
  "designer": {
    "model": "anthropic/claude-opus-5-5",
    "fallbackModels": ["openai-codex/gpt-6.1-sol"]
  },
  "fixer": {
    "model": "anthropic/claude-sonnet-5-5",
    "fallbackModels": ["openai-codex/gpt-6-sol"]
  },
  "fast-generic": {
    "model": "anthropic/claude-sonnet-5-5",
    "fallbackModels": ["openai-codex/gpt-6-luna"]
  },
  "scout": {
    "model": "openai-codex/gpt-6-luna",
    "fallbackModels": ["anthropic/claude-haiku-5-5"]
  },
  "researcher": {
    "model": "openai-codex/gpt-6-luna",
    "fallbackModels": ["anthropic/claude-haiku-5-5"]
  },
  "vision": {
    "model": "openai-codex/gpt-6-luna",
    "fallbackModels": ["anthropic/claude-haiku-5-5"]
  },
  "councillor-alpha": {
    "model": "openai-codex/gpt-6-astra",
    "fallbackModels": ["anthropic/claude-sonnet-5-5"]
  },
  "councillor-beta": {
    "model": "opencode-go/deepseek-v4-pro",
    "fallbackModels": ["openai-codex/gpt-6-luna"]
  },
  "councillor-gamma": {
    "model": "opencode-go/glm-5.3",
    "fallbackModels": ["anthropic/claude-sonnet-5-5"]
  },
  "council": {
    "model": "opencode-go/kimi-k3",
    "fallbackModels": ["anthropic/claude-opus-5-5"]
  }
}
```

## Other providers

Kimi For Coding (`kimi-coding`), Z.ai (`zai`), OpenRouter (`openrouter`),
plain API keys and the rest work the same way: run `pi --list-models`,
fill the role table, and put the result in a preset. Mixing one of them
into the council is an easy way to get a truly different opinion.

## Thinking levels

Each agent's thinking level lives in `agents` (senior `xhigh`, the
council `high`, scout `low`, ...). A model without thinking ignores it.
To change one, edit the agent in `agents`, or set `thinking` in a
preset and remove it from `agents`, since `agents` wins.
