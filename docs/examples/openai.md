# Example: OpenAI only

Everything on an OpenAI (Codex) subscription: GPT-6 Sol leads and
designs, Astra is the senior, Luna on high thinking does the rest.
The council seats get Sol, Astra and Luna, so the three opinions still
come from different models.

Lead: `/model openai-codex/gpt-6-sol`. Copy the JSON to
`~/.pi/agent/opium.json`.

```json
{
  "orchestrator": true,
  "agents": {
    "council": {
      "model": "openai-codex/gpt-6-luna",
      "thinking": "high",
      "timeoutMs": 900000,
      "idleTimeoutMs": 600000,
      "wrapUpMs": 180000
    },
    "councillor-alpha": {
      "model": "openai-codex/gpt-6-sol",
      "thinking": "high",
      "timeoutMs": 900000,
      "idleTimeoutMs": 600000,
      "wrapUpMs": 180000
    },
    "councillor-beta": {
      "model": "openai-codex/gpt-6-astra",
      "thinking": "high",
      "timeoutMs": 900000,
      "idleTimeoutMs": 600000,
      "wrapUpMs": 180000
    },
    "councillor-gamma": {
      "model": "openai-codex/gpt-6-luna",
      "thinking": "high",
      "timeoutMs": 900000,
      "idleTimeoutMs": 600000,
      "wrapUpMs": 180000
    },
    "designer": {
      "model": "openai-codex/gpt-6-sol",
      "thinking": "medium",
      "skills": ["make-interfaces-feel-better"],
      "background": true,
      "timeoutMs": 7200000,
      "idleTimeoutMs": 600000,
      "wrapUpMs": 180000
    },
    "scout": {
      "model": "openai-codex/gpt-6-luna",
      "thinking": "high",
      "background": true,
      "timeoutMs": 600000,
      "idleTimeoutMs": 600000,
      "wrapUpMs": 180000
    },
    "fast-generic": {
      "model": "openai-codex/gpt-6-luna",
      "thinking": "high",
      "background": true,
      "gitGuard": false,
      "timeoutMs": 900000,
      "idleTimeoutMs": 600000,
      "wrapUpMs": 180000
    },
    "fixer": {
      "model": "openai-codex/gpt-6-luna",
      "thinking": "high",
      "skills": ["pnpm"],
      "background": true,
      "timeoutMs": 7200000,
      "idleTimeoutMs": 600000,
      "wrapUpMs": 180000
    },
    "researcher": {
      "model": "openai-codex/gpt-6-luna",
      "thinking": "high",
      "background": true,
      "timeoutMs": 900000,
      "idleTimeoutMs": 600000,
      "wrapUpMs": 180000
    },
    "vision": {
      "model": "openai-codex/gpt-6-luna",
      "thinking": "high",
      "timeoutMs": 600000,
      "idleTimeoutMs": 600000,
      "wrapUpMs": 180000
    },
    "senior": {
      "model": "openai-codex/gpt-6-astra",
      "thinking": "xhigh",
      "skills": ["simplify"],
      "background": true,
      "timeoutMs": 1200000,
      "idleTimeoutMs": 600000,
      "wrapUpMs": 180000
    }
  }
}
```
