# Example: ideal

The author's setup: Claude for the heavy lifting, GPT-6 Luna for quick
lookups, and three different providers on the council. Needs the
`claude-bridge`, `openai-codex` and `opencode-go` providers.

Lead: `/model claude-bridge/claude-opus-5-5`. Copy the JSON to
`~/.pi/agent/opium.json`.

```json
{
  "orchestrator": true,
  "agents": {
    "council": {
      "model": "opencode-go/kimi-k3",
      "fallbackModels": [
        "openai-codex/gpt-6-luna",
        "claude-bridge/claude-sonnet-5-5"
      ],
      "thinking": "high",
      "timeoutMs": 900000,
      "background": false,
      "permissionAsks": "forward",
      "gitGuard": true,
      "idleTimeoutMs": 600000,
      "wrapUpMs": 180000
    },
    "councillor-alpha": {
      "model": "openai-codex/gpt-6-luna",
      "thinking": "high",
      "timeoutMs": 900000,
      "background": false,
      "permissionAsks": "forward",
      "gitGuard": true,
      "idleTimeoutMs": 600000,
      "wrapUpMs": 180000
    },
    "councillor-beta": {
      "model": "opencode-go/deepseek-v4-pro",
      "fallbackModels": [
        "openai-codex/gpt-6-luna",
        "claude-bridge/claude-sonnet-5-5"
      ],
      "thinking": "high",
      "timeoutMs": 900000,
      "background": false,
      "permissionAsks": "forward",
      "gitGuard": true,
      "idleTimeoutMs": 600000,
      "wrapUpMs": 180000
    },
    "councillor-gamma": {
      "model": "opencode-go/glm-5.3",
      "fallbackModels": [
        "openai-codex/gpt-6-luna",
        "claude-bridge/claude-sonnet-5-5"
      ],
      "thinking": "high",
      "timeoutMs": 900000,
      "background": false,
      "permissionAsks": "forward",
      "gitGuard": true,
      "idleTimeoutMs": 600000,
      "wrapUpMs": 180000
    },
    "designer": {
      "model": "claude-bridge/claude-opus-5-5",
      "fallbackModels": [
        "openai-codex/gpt-6-luna",
        "claude-bridge/claude-sonnet-5-5"
      ],
      "thinking": "high",
      "timeoutMs": 7200000,
      "background": true,
      "permissionAsks": "forward",
      "gitGuard": true,
      "skills": ["make-interfaces-feel-better"],
      "idleTimeoutMs": 600000,
      "wrapUpMs": 180000
    },
    "scout": {
      "model": "openai-codex/gpt-6-luna",
      "thinking": "low",
      "timeoutMs": 600000,
      "background": true,
      "permissionAsks": "forward",
      "gitGuard": true,
      "mcpServers": ["codegraph"],
      "idleTimeoutMs": 600000,
      "wrapUpMs": 180000
    },
    "fast-generic": {
      "model": "claude-bridge/claude-sonnet-5-5",
      "thinking": "high",
      "timeoutMs": 900000,
      "background": true,
      "permissionAsks": "forward",
      "gitGuard": false,
      "idleTimeoutMs": 600000,
      "wrapUpMs": 180000
    },
    "fixer": {
      "model": "claude-bridge/claude-sonnet-5-5",
      "thinking": "high",
      "timeoutMs": 7200000,
      "background": true,
      "permissionAsks": "forward",
      "gitGuard": true,
      "skills": ["pnpm"],
      "mcpServers": ["codegraph"],
      "idleTimeoutMs": 600000,
      "wrapUpMs": 180000
    },
    "researcher": {
      "model": "openai-codex/gpt-6-luna",
      "thinking": "low",
      "timeoutMs": 900000,
      "background": true,
      "permissionAsks": "forward",
      "gitGuard": true,
      "idleTimeoutMs": 600000,
      "wrapUpMs": 180000
    },
    "vision": {
      "model": "openai-codex/gpt-6-luna",
      "thinking": "low",
      "timeoutMs": 600000,
      "background": false,
      "permissionAsks": "forward",
      "gitGuard": true,
      "idleTimeoutMs": 600000,
      "wrapUpMs": 180000
    },
    "senior": {
      "model": "claude-bridge/claude-fable-5-1",
      "thinking": "high",
      "timeoutMs": 1200000,
      "background": true,
      "permissionAsks": "forward",
      "gitGuard": true,
      "skills": ["simplify"],
      "mcpServers": ["codegraph"],
      "idleTimeoutMs": 600000,
      "wrapUpMs": 180000
    }
  }
}
```
