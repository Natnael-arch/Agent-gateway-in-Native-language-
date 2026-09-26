# Agelgay Installer — Bundle & Packaging Specification (Windows Phase 1 & Phase 5)

## Overview

Agelgay ships as a zero-prerequisite, non-administrative Windows installer (`Agelgay-Setup.exe`). The customer does not need Node.js, Python, or administrator rights pre-installed.

---

## 1. What Ships

| Component | Source Path | Target Installed Path | Purpose |
|-----------|-------------|-----------------------|---------|
| **Portable Node** | Node.js v22 LTS (Windows x64 zip) | `{app}\node\` | Embedded Node runtime so no system Node is required |
| **agent-gateway** | `agent-gateway/` source tree | `{app}\agent-gateway\` | Express application providing Amharic↔English translation pipeline |
| **Hermes AI Agent** | `~/.hermes/hermes-agent/` | `{app}\hermes\` | Hermes AI Agent CLI & Python virtual environment |
| **Activation Script** | `installer/activate.js` | `{app}\activate.js` | Computes machine fingerprint, redeems code with proxy, writes config |
| **Activation Launcher** | `installer/activate.cmd` | `{app}\activate.cmd` | Batch launcher running `activate.js` via portable `node.exe` |
| **Start Gateway Launcher** | `installer/start.cmd` | `{app}\start.cmd` | Batch launcher starting `server.js` via portable `node.exe` |
| **Inno Setup Script** | `installer/AgelgaySetup.iss` | — | Compiler script building `Agelgay-Setup.exe` installer |

---

## 2. On-Disk Layout (Installed Package)

Default non-admin install location: `%LOCALAPPDATA%\Agelgay` (`{localappdata}\Agelgay`)

```text
%LOCALAPPDATA%\Agelgay\
│
├── node\                                     # Portable Node.js runtime (v22 LTS)
│   ├── node.exe                              #   (node executable)
│   ├── npm, npx                              #   (bundled npm scripts)
│   └── ...
│
├── agent-gateway\                            # Node.js Express Gateway app
│   ├── server.js                             #   Entrypoint server
│   ├── package.json
│   ├── node_modules\                         #   Pre-installed dependencies (express, dotenv)
│   ├── routes\                               #   Gateway pipeline routing logic
│   ├── services\                             #   Translator & machine fingerprinting services
│   ├── middleware\                           #   Confirmation gate & logging middleware
│   ├── public\                               #   Web interface assets
│   ├── .env                                  # ← Written by activate.js (PROXY_TOKEN & INSTANCE_FINGERPRINT)
│   └── .env.example
│
├── hermes\                                   # Hermes AI Agent CLI & configuration
│   ├── hermes                                #   Entrypoint runner
│   ├── hermes-agent\                         #   Full source & venv
│   │   ├── venv\
│   │   └── ...
│   ├── .env                                  # ← Written by activate.js (DEEPSEEK_API_KEY)
│   └── config.yaml                           #   Hermes configuration
│
├── activate.js                               # Cross-platform Node activation script
├── activate.cmd                              # Interactive activation batch launcher
└── start.cmd                                 # Manual gateway start batch launcher
```

---

## 3. Inno Setup Packaging Configuration (`AgelgaySetup.iss`)

The installer is compiled using Inno Setup 6.x:

- **Target Directory**: `{localappdata}\Agelgay`
- **Privileges**: `PrivilegesRequired=lowest` (No UAC / Admin prompt needed)
- **Output Executable**: `OutputBaseFilename=Agelgay-Setup`
- **Post-Install Action**: Immediately launches `cmd.exe /c start "Agelgay Activation" "{app}\activate.cmd"` in an interactive console window for the customer to input their activation code.
- **Shortcuts**:
  - Start Menu: `{userprograms}\Agelgay\Agelgay Gateway` -> `{app}\start.cmd`
  - Start Menu: `{userprograms}\Agelgay\Re-activate Agelgay` -> `{app}\activate.cmd`
  - Desktop: `{autodesktop}\Agelgay` -> `{app}\start.cmd`

---

## 4. End-to-End Execution Flow

```text
1. Customer runs Agelgay-Setup.exe (No Admin rights needed).
2. Files are extracted to %LOCALAPPDATA%\Agelgay.
3. Post-install launches activate.cmd in a console window.
4. activate.cmd invokes node\node.exe activate.js.
5. activate.js:
   - Computes machine fingerprint (SHA-256 hash).
   - POSTs activation_code + fingerprint to usage-proxy production /v1/activate.
   - Writes returned PROXY_TOKEN and INSTANCE_FINGERPRINT into agent-gateway\.env.
   - Writes DEEPSEEK_API_KEY into hermes\.env.
   - Configures Hermes config.yaml extra_headers X-Instance-Fingerprint.
   - Probes local gateway / health endpoint to confirm authentication.
6. Customer double-clicks Desktop Shortcut (Agelgay) to launch start.cmd.
7. Gateway runs using portable node\node.exe server.js on http://localhost:3000.
```
