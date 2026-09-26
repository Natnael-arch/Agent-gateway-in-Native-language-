# Agelgay Installer — Phase 1: Bundle Definition

## What Ships

| Component | Source | Purpose |
|-----------|--------|---------|
| **agent-gateway** | `agent-gateway/` source tree | Node.js Express app — Amharic↔English translation gateway |
| **Hermes binary** | `~/.hermes/hermes-agent/` (full directory) | Hermes AI Agent CLI + Python venv |
| **Portable Node** | Node.js v22 LTS (platform zip) | So the customer doesn't need Node pre-installed |
| **Activation script** | `installer/activate.js` | Exchanges activation code → token, writes configs, validates |

## On-Disk Layout (installed package)

```
C:\Program Files\Agelgay\                    # Windows (default)
/opt/agelgay/                                # Linux
/Applications/Agelgay.app/Contents/          # macOS
│
├── node\                                     # Portable Node runtime
│   ├── node.exe                              #   (node binary)
│   ├── npm, npx                              #   (bundled)
│   └── ...
│
├── agent-gateway\                            # The Node.js app
│   ├── server.js
│   ├── package.json
│   ├── node_modules\                         # Pre-installed deps (dotenv, express)
│   ├── routes\
│   ├── services\
│   ├── middleware\
│   ├── utils\
│   ├── public\
│   ├── .env                                  # ← Written by activate.js (PROXY_TOKEN)
│   └── .env.example
│
├── hermes\                                   # Hermes AI Agent
│   ├── hermes                                #   Python entrypoint script
│   ├── hermes-agent\                         #   Full hermes-agent source + venv
│   │   ├── venv\                             #   Python virtual environment
│   │   └── ...
│   ├── .env                                  # ← Written by activate.js (DEEPSEEK_API_KEY)
│   └── config.yaml                           #   Hermes config (model, agent, etc.)
│
├── activate.js                               # Cross-platform activation script
├── activate.cmd                               # Windows double-click launcher
└── activate.sh                                # Linux/macOS launcher
```

## How the Pieces Connect

```
Customer runs activate.js
  │
  ├─ Prompts for activation code
  ├─ POSTs to usage-proxy /v1/activate
  ├─ Gets back a token
  ├─ Writes token to agent-gateway/.env  as PROXY_TOKEN
  ├─ Writes token to hermes/.env          as DEEPSEEK_API_KEY (or provider key)
  ├─ Validates both writes
  ├─ Makes a test request through agent-gateway
  └─ Reports success/failure
```

## Why a Portable Node?

The customer may not have Node.js installed. Bundling Node means:
- Zero prerequisites — download and run
- Consistent runtime version (v22 LTS)
- No PATH manipulation needed
- No version conflicts with other Node installs

## Why Hermes Needs Its Own .env?

Hermes reads API keys from environment variables:
- The usage-proxy token (e.g., `p_...`) acts as a DeepSeek API key
- Hermes routes DeepSeek calls through the proxy at `config.yaml` → `model.base_url`
- The activation script must write the token with the correct provider key name

## Provider Key Mapping

The activation script reads `hermes/config.yaml` → `model.provider` to determine which env var name to use:

| Provider | Env Var | Example |
|----------|---------|---------|
| deepseek | `DEEPSEEK_API_KEY` | `p_abc123...` |
| openai | `OPENAI_API_KEY` | `p_abc123...` |
| openrouter | `OPENROUTER_API_KEY` | `p_abc123...` |
| *fallback* | `DEEPSEEK_API_KEY` | Default if provider unknown |
