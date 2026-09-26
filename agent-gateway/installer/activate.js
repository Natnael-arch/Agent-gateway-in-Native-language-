#!/usr/bin/env node
/**
 * Agelgay Installer — Activation Script (Phase 2 + fingerprint binding)
 *
 * Cross-platform Node.js script that:
 *   1. Prompt for an activation code
 *   2. Computes a machine fingerprint (SHA-256 hash of machine id + host; the
 *      hash is the ONLY thing that ever leaves this machine)
 *   3. POSTs code + fingerprint to the usage-proxy /v1/activate endpoint
 *   4. Writes the returned token into agent-gateway/.env (PROXY_TOKEN)
 *      and Hermes's .env (DEEPSEEK_API_KEY or provider-appropriate key)
 *   5. Persists the fingerprint (INSTANCE_FINGERPRINT in agent-gateway/.env)
 *      and configures Hermes to send it as X-Instance-Fingerprint so every
 *      authenticated call from this machine carries the binding
 *   6. Validates all files were written correctly
 *   7. Makes a test request through agent-gateway to confirm the token works
 *
 * This script is later wrapped by a thin Windows PowerShell/Inno Setup layer.
 * It contains NO OS-specific logic — runs identically on Linux, macOS, Windows.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ─── Configuration ──────────────────────────────────────────────────────────

const PROXY_BASE_URL = process.env.PROXY_BASE_URL || 'https://usage-proxy-production-b0a8.up.railway.app';

// Paths relative to this script's location (the installer root or installer/ subfolder)
const INSTALL_DIR = __dirname;
const AGENT_GATEWAY_DIR = fs.existsSync(path.join(INSTALL_DIR, 'agent-gateway'))
  ? path.join(INSTALL_DIR, 'agent-gateway')
  : path.join(INSTALL_DIR, '..', 'agent-gateway');
const HERMES_DIR = fs.existsSync(path.join(INSTALL_DIR, 'hermes'))
  ? path.join(INSTALL_DIR, 'hermes')
  : path.join(INSTALL_DIR, '..', 'hermes');

const AGENT_ENV_PATH = path.join(AGENT_GATEWAY_DIR, '.env');
const HERMES_ENV_PATH = path.join(HERMES_DIR, '.env');
const HERMES_CONFIG_PATH = path.join(HERMES_DIR, 'config.yaml');

// Machine fingerprint: sha256 hash of machine id + host; only this HASH ever
// leaves the machine. The fingerprints module lives with agent-gateway's
// services so the gateway can recompute / share it at runtime.
const FINGERPRINT_MODULE = path.join(AGENT_GATEWAY_DIR, 'services', 'fingerprint.js');

// Default gateway port; overridden below from the agent-gateway .env if set.
const GATEWAY_PORT = process.env.PORT || 3000;

const { spawn } = require('child_process');

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Read a file, return null if it doesn't exist. */
function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Replace-or-append a KEY=VALUE line in a .env file string.
 * If the key exists, replace its value. If not, append it.
 * Returns the updated file content string.
 */
function upsertEnvVar(fileContent, key, value) {
  const lines = fileContent.split('\n');
  let found = false;
  const updated = lines.map((line) => {
    if (new RegExp(`^${key}=`).test(line)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) {
    updated.push(`${key}=${value}`);
  }
  return updated.join('\n');
}

/**
 * Extract a simple YAML scalar value for a key.
 * Handles `key: value` lines. Does NOT handle nested YAML — only top-level scalars.
 */
function getYamlScalar(fileContent, key) {
  const regex = new RegExp(`^${key}:\\s*(.+)$`, 'm');
  const match = fileContent.match(regex);
  if (!match) return null;
  return match[1].trim().replace(/^["']|["']$/g, '');
}

/**
 * Compute the machine fingerprint hash (SHA-256). Delegates to
 * agent-gateway/services/fingerprint.js so installer and gateway share the
 * exact same implementation. Never prints or transmits raw hardware data.
 */
function computeFingerprint() {
  try {
    const fingerprintModule = require(FINGERPRINT_MODULE);
    const fp = fingerprintModule.getFingerprint();
    if (!/^[0-9a-f]{64}$/.test(fp)) {
      throw new Error(`fingerprint module returned invalid hash: ${String(fp).slice(0, 8)}…`);
    }
    return fp;
  } catch (err) {
    throw new Error(`Could not compute machine fingerprint for activation: ${err.message}`);
  }
}

/**
 * Inject `extra_headers: { X-Instance-Fingerprint: <hash> }` into the `model:`
 * block of Hermes's config.yaml so that every LLM request Hermes sends to the
 * usage-proxy carries the fingerprint header. Hermes supports
 * model.default_headers / model.extra_headers — this is the documented hook.
 * Returns the updated YAML string; caller writes it back.
 */
function addHermesFingerprintHeader(configContent, fingerprint) {
  const HEADER_KEY = 'X-Instance-Fingerprint';
  const lines = configContent.split('\n');

  // Find the top-level `model:` block.
  const modelIdx = lines.findIndex((l) => /^model:\s*$/.test(l));
  if (modelIdx === -1) return configContent;

  // Detect the indentation used inside the model block (heuristic: first
  // indented line under model:).
  let blockEnd = lines.length;
  let indent = '  ';
  for (let i = modelIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line) && line.trim() !== '') {
      blockEnd = i; // next top-level key ends the model block
      break;
    }
    if (indent === '  ' && /^\s+\S/.test(line) && line.trim() !== '') {
      indent = line.match(/^\s*/)[0];
    }
  }

  const subIndent = `${indent}  `; // one level deeper than model's keys

  // Find an existing extra_headers entry inside the model block.
  const ehIdx = lines.slice(modelIdx, blockEnd).findIndex((l) => /^\s+extra_headers:\s*$/.test(l));
  if (ehIdx !== -1) {
    const abs = modelIdx + ehIdx;
    // Replace or append the header line under extra_headers:.
    const existing = lines.slice(abs + 1, blockEnd).findIndex(
      (l) => l.trim().startsWith(`${HEADER_KEY}:`)
    );
    if (existing !== -1) {
      lines[abs + 1 + existing] = `${subIndent}${HEADER_KEY}: "${fingerprint}"`;
    } else {
      // Insert right after the extra_headers: line.
      lines.splice(abs + 1, 0, `${subIndent}${HEADER_KEY}: "${fingerprint}"`);
    }
    return lines.join('\n');
  }

  // No extra_headers yet: insert one at the end of the model block.
  const headerLines = [
    `${indent}extra_headers:`,
    `${subIndent}${HEADER_KEY}: "${fingerprint}"`,
  ];
  lines.splice(blockEnd, 0, ...headerLines);
  return lines.join('\n');
}

/**
 * Determine which env var name Hermes expects for the API key,
 * based on the provider in config.yaml.
 */
function getHermesProviderKeyName() {
  const configContent = readFileSafe(HERMES_CONFIG_PATH);
  if (!configContent) return 'DEEPSEEK_API_KEY'; // default fallback

  const provider = getYamlScalar(configContent, 'provider');
  if (!provider) return 'DEEPSEEK_API_KEY';

  // Map provider names to their env var key names
  const providerMap = {
    deepseek: 'DEEPSEEK_API_KEY',
    openai: 'OPENAI_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    novita: 'NOVITA_API_KEY',
    google: 'GOOGLE_API_KEY',
    gemini: 'GOOGLE_API_KEY',
    ollama: 'OLLAMA_API_KEY',
    glm: 'GLM_API_KEY',
    zai: 'GLM_API_KEY',
    kimi: 'KIMI_API_KEY',
    arcee: 'ARCEEAI_API_KEY',
    minimax: 'MINIMAX_API_KEY',
    hf: 'HF_TOKEN',
    huggingface: 'HF_TOKEN',
    deepinfra: 'DEEPINFRA_API_KEY',
    groq: 'GROQ_API_KEY',
    opencode: 'OPENCODE_ZEN_API_KEY',
  };

  return providerMap[provider.toLowerCase()] || 'DEEPSEEK_API_KEY';
}

/** Mask a token for display: show first 4 and last 4 chars, mask the middle. */
function maskToken(token) {
  if (token.length <= 10) return '****';
  return `${token.slice(0, 4)}${'*'.repeat(token.length - 8)}${token.slice(-4)}`;
}

/** Validate token format — must be a non-empty alphanumeric-ish string. */
function isValidTokenFormat(token) {
  return typeof token === 'string' && token.length >= 10 && /^[A-Za-z0-9_-]+$/.test(token);
}

/** Read a KEY=value from a .env file string; returns null if absent. */
function getEnvVar(fileContent, key) {
  const match = fileContent.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return match ? match[1].trim() : null;
}

/** Resolve the Node binary: bundled portable runtime, else the one running us. */
function resolveNodeBinary() {
  const candidates = [
    path.join(INSTALL_DIR, 'node', process.platform === 'win32' ? 'node.exe' : 'node'),
    path.join(INSTALL_DIR, 'node', 'node.exe'),
    path.join(INSTALL_DIR, 'node', 'node'),
    process.execPath,
  ];
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return process.execPath;
}

/** Wait (up to timeoutMs) for the gateway /health endpoint to come online. */
async function waitForGateway(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(2500) });
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * Make one REAL authenticated request through the running agent-gateway.
 * POSTing to /api/chat in Amharic mode makes the gateway call the usage-proxy
 * /v1/translate endpoint with the newly written PROXY_TOKEN. A 402
 * insufficient_balance is a SUCCESS (auth passed; no balance left). A 401
 * means the token was rejected.
 */
async function testThroughGateway(port) {
  const payload = {
    text: 'መልካም ጥዋት', // "Good morning" — tiny Amharic probe
    sessionId: `activation-test-${Date.now()}`,
  };

  let response;
  try {
    response = await fetch(`http://localhost:${port}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    return { ok: false, code: 'gateway_unreachable', detail: err.message };
  }

  if (!response.ok && response.status === 402) {
    return { ok: true, code: 'insufficient_balance' };
  }
  if (!response.ok && response.status === 401) {
    return { ok: false, code: 'auth_rejected', detail: await response.text() };
  }

  // The gateway streams server-sent events. Sniff the stream for the token
  // being exercised: translate_in done => auth OK + balance OK; an error event
  // carrying 402 insufficient_balance => auth OK; 401 => auth rejected.
  try {
    const text = await response.text();
    const lower = text.toLowerCase();
    if (lower.includes('insufficient_balance') || lower.includes('"402"') || lower.includes(' (402)')) {
      return { ok: true, code: 'insufficient_balance' };
    }
    if (lower.includes('401') || lower.includes('invalid token') || lower.includes('missing or malformed')) {
      return { ok: false, code: 'auth_rejected', detail: text.slice(0, 300) };
    }
    if (lower.includes('"type":"result"') || lower.includes('"status":"success"')) {
      return { ok: true, code: 'full_success' };
    }
    if (response.ok) {
      return { ok: true, code: 'full_success' };
    }
    return { ok: false, code: 'unexpected', detail: text.slice(0, 300) };
  } catch (err) {
    return { ok: false, code: 'read_error', detail: err.message };
  }
}

// ─── CLI Prompt ─────────────────────────────────────────────────────────────

function promptForCode() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question('\nEnter your activation code: ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ─── Main Flow ──────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('========================================');
  console.log('  Agelgay — Activation');
  console.log('========================================');
  console.log('');

  // ── Step 1: Get activation code ──────────────────────────────────────────
  const code = process.argv[2] || await promptForCode();

  if (!code) {
    console.error('ERROR: No activation code provided.');
    console.error('');
    console.error('Please provide your activation code:');
    console.error('  node activate.js YOUR_CODE_HERE');
    console.error('');
    process.exit(1);
  }

  // ── Step 2: Compute machine fingerprint ─────────────────────────────────
  // A SHA-256 hash of machine id + host. Only this UNAMBIGUOUSLY-hashed
  // value leaves the machine; raw hardware identifiers never do.
  console.log('Computing machine fingerprint...');
  let fingerprint;
  try {
    fingerprint = computeFingerprint();
    console.log(`  Fingerprint: ${fingerprint.slice(0, 8)}… (${fingerprint.length} hex chars)`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  // ── Step 3: POST to /v1/activate ────────────────────────────────────────
  console.log('Contacting activation server...');
  console.log('');

  let res;
  try {
    res = await fetch(`${PROXY_BASE_URL}/v1/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activation_code: code, fingerprint }),
    });
  } catch (err) {
    console.error('ERROR: Could not reach the activation server.');
    console.error('');
    console.error(`  URL: ${PROXY_BASE_URL}/v1/activate`);
    console.error(`  Error: ${err.message}`);
    console.error('');
    console.error('Please check your internet connection and try again.');
    console.error('If this persists, contact support.');
    process.exit(1);
  }

  const body = await res.json().catch(() => ({}));

  // ── Step 4: Handle errors with clear messages ───────────────────────────
  if (!res.ok || !body.token) {
    const errorCode = body.error || 'unknown_error';

    console.error('ACTIVATION FAILED');
    console.error('');

    switch (errorCode) {
      case 'missing_activation_code':
        console.error('The activation code was empty or missing.');
        console.error('Please make sure you copied the full code from your purchase confirmation.');
        break;
      case 'invalid_code':
        console.error('The activation code is not valid.');
        console.error('Please double-check the code from your purchase confirmation.');
        console.error('Make sure there are no extra spaces or missing characters.');
        break;
      case 'code_already_used':
        console.error('This activation code has already been used.');
        console.error('Each code can only be used once.');
        console.error('If you need to reinstall, please contact support for a new code.');
        break;
      case 'code_expired':
        console.error('This activation code has expired.');
        console.error('Activation codes are valid for a limited time.');
        console.error('Please contact support to get a new code.');
        break;
      case 'invalid_fingerprint':
        console.error('The machine fingerprint sent to the activation server was rejected.');
        console.error('This should not happen during a normal install.');
        console.error('Please contact support for assistance.');
        break;
      default:
        console.error(`Unexpected error: ${errorCode}`);
        console.error('Please try again or contact support.');
        break;
    }

    console.error('');
    process.exit(1);
  }

  const token = body.token;

  // Validate token format before writing anything
  if (!isValidTokenFormat(token)) {
    console.error('ERROR: Received an invalid token format from the server.');
    console.error('This should not happen. Please contact support.');
    process.exit(1);
  }

  console.log('Activation code accepted.');
  console.log('');

  // ── Step 5: Write token to agent-gateway/.env ───────────────────────────
  console.log('Configuring agent-gateway...');

  const agentEnv = readFileSafe(AGENT_ENV_PATH);
  if (agentEnv === null) {
    console.error(`ERROR: agent-gateway/.env not found at ${AGENT_ENV_PATH}`);
    console.error('The installation may be corrupted. Please reinstall.');
    process.exit(1);
  }

  let updatedAgentEnv = upsertEnvVar(agentEnv, 'PROXY_TOKEN', token);
  // Persist the fingerprint so the running gateway can attach it to every
  // authenticated request without recomputing (and so runtime identity stays
  // stable across installs on the same machine).
  updatedAgentEnv = upsertEnvVar(updatedAgentEnv, 'INSTANCE_FINGERPRINT', fingerprint);
  try {
    fs.writeFileSync(AGENT_ENV_PATH, updatedAgentEnv, 'utf8');
  } catch (err) {
    console.error(`ERROR: Could not write to ${AGENT_ENV_PATH}`);
    console.error(`  ${err.message}`);
    console.error('Please check file permissions and try again.');
    process.exit(1);
  }

  // ── Step 6: Write token to Hermes's .env ────────────────────────────────
  console.log('Configuring Hermes...');

  const hermesEnvKey = getHermesProviderKeyName();
  const hermesEnv = readFileSafe(HERMES_ENV_PATH);
  if (hermesEnv === null) {
    console.error(`ERROR: Hermes .env not found at ${HERMES_ENV_PATH}`);
    console.error('The installation may be corrupted. Please reinstall.');
    process.exit(1);
  }

  const updatedHermesEnv = upsertEnvVar(hermesEnv, hermesEnvKey, token);
  try {
    fs.writeFileSync(HERMES_ENV_PATH, updatedHermesEnv, 'utf8');
  } catch (err) {
    console.error(`ERROR: Could not write to ${HERMES_ENV_PATH}`);
    console.error(`  ${err.message}`);
    console.error('Please check file permissions and try again.');
    process.exit(1);
  }

  // ── Step 7: Configure Hermes to send the fingerprint header ─────────────
  console.log('Configuring Hermes fingerprint header...');

  const hermesConfig = readFileSafe(HERMES_CONFIG_PATH);
  let fingerprintHeaderWritten = false;
  if (hermesConfig !== null) {
    const updatedConfig = addHermesFingerprintHeader(hermesConfig, fingerprint);
    if (updatedConfig !== hermesConfig) {
      try {
        fs.writeFileSync(HERMES_CONFIG_PATH, updatedConfig, 'utf8');
        fingerprintHeaderWritten = true;
      } catch (err) {
        console.log(`  (warn: could not write X-Instance-Fingerprint into Hermes config: ${err.message})`);
      }
    }
  } else {
    console.log('  (warn: Hermes config.yaml not found — fingerprint header not injected)');
  }
  if (fingerprintHeaderWritten) {
    console.log(`  OK: Hermes will send X-Instance-Fingerprint on LLM requests`);
  }

  // ── Step 8: Validate both files ─────────────────────────────────────────
  console.log('Validating configuration files...');
  console.log('');

  let validationFailed = false;

  // Validate agent-gateway/.env
  const verifyAgentEnv = readFileSafe(AGENT_ENV_PATH);
  const agentTokenMatch = verifyAgentEnv && verifyAgentEnv.match(/^PROXY_TOKEN=(.+)$/m);
  if (!agentTokenMatch || agentTokenMatch[1] !== token) {
    console.error(`  FAIL: agent-gateway/.env — PROXY_TOKEN not correctly written`);
    validationFailed = true;
  } else {
    console.log(`  OK: agent-gateway/.env — PROXY_TOKEN = ${maskToken(token)}`);
  }

  const agentFpMatch = verifyAgentEnv && verifyAgentEnv.match(/^INSTANCE_FINGERPRINT=(.+)$/m);
  if (!agentFpMatch || agentFpMatch[1] !== fingerprint) {
    console.error(`  FAIL: agent-gateway/.env — INSTANCE_FINGERPRINT not correctly written`);
    validationFailed = true;
  } else {
    console.log(`  OK: agent-gateway/.env — INSTANCE_FINGERPRINT = ${fingerprint.slice(0, 8)}…`);
  }

  // Validate Hermes .env
  const verifyHermesEnv = readFileSafe(HERMES_ENV_PATH);
  const hermesTokenMatch = verifyHermesEnv && verifyHermesEnv.match(new RegExp(`^${hermesEnvKey}=(.+)$`, 'm'));
  if (!hermesTokenMatch || hermesTokenMatch[1] !== token) {
    console.error(`  FAIL: hermes/.env — ${hermesEnvKey} not correctly written`);
    validationFailed = true;
  } else {
    console.log(`  OK: hermes/.env — ${hermesEnvKey} = ${maskToken(token)}`);
  }

  if (validationFailed) {
    console.error('');
    console.error('ERROR: Configuration validation failed.');
    console.error('The token was not correctly written to one or more files.');
    console.error('Please check file permissions and try again.');
    process.exit(1);
  }

  console.log('');

  // ── Step 9: Real authenticated test through agent-gateway ─────────────────
  console.log('Verifying the token end-to-end through agent-gateway...');
  console.log('');

  // Resolve the gateway port from the .env we just wrote (if present).
  const agentEnvFinal = readFileSafe(AGENT_ENV_PATH);
  const portFromEnv = agentEnvFinal ? getEnvVar(agentEnvFinal, 'PORT') : null;
  const port = portFromEnv ? Number(portFromEnv) : GATEWAY_PORT;

  // Make sure a gateway is up to test against. If nothing is listening on the
  // configured port, start one using the bundled portable Node runtime.
  let up = await waitForGateway(port, 5000);
  let spawnedChild = null;

  if (!up) {
    const nodeBin = resolveNodeBinary();
    const serverPath = path.join(AGENT_GATEWAY_DIR, 'server.js');

    if (!fs.existsSync(serverPath)) {
      console.log('  (skipping live gateway test: agent-gateway/server.js not found)');
    } else {
      console.log(`  Starting agent-gateway with bundled Node: ${nodeBin}`);
      spawnedChild = spawn(nodeBin, [serverPath], {
        cwd: AGENT_GATEWAY_DIR,
        stdio: 'ignore',
        detached: true,
      });
      spawnedChild.on('error', (err) => {
        console.log(`  (could not spawn gateway: ${err.message})`);
      });
      spawnedChild.unref();
      up = await waitForGateway(port, 30000);
    }
  }

  if (!up) {
    console.log('  (could not reach agent-gateway — token was still written and');
    console.log('   validated in both .env files; start the gateway to use it.)');
    console.log('');
    console.log('ACTIVATION SUCCEEDED — configuration written and validated.');
    console.log('Start the gateway with: node server.js');
    console.log('');
    console.log('  Token: stored securely in .env files (never printed).');
    console.log('========================================');
    console.log('');
    return;
  }

  const result = await testThroughGateway(port);

  console.log('  Gateway probe result:');
  if (result.ok && result.code === 'full_success') {
    console.log('    OK — authenticated request succeeded');
    console.log('    (translation call through the gateway returned successfully.)');
    console.log('');
    console.log('========================================');
    console.log('  ACTIVATION SUCCEEDED');
    console.log('');
    console.log('  The token was written, validated in both .env files,');
    console.log('  and a real authenticated call through agent-gateway worked.');
    console.log('  Token: stored securely in .env files (never printed).');
    console.log('========================================');
  } else if (result.ok && result.code === 'insufficient_balance') {
    console.log('    OK — token authenticated (HTTP 402 insufficient_balance)');
    console.log('    (The proxy accepted the token. The instance just has no');
    console.log('     balance left — authentication is proven.)');
    console.log('');
    console.log('========================================');
    console.log('  ACTIVATION SUCCEEDED');
    console.log('');
    console.log('  The token is valid and authenticated end-to-end.');
    console.log('  Add balance to the instance to start using the gateway.');
    console.log('  Token: stored securely in .env files (never printed).');
    console.log('========================================');
  } else if (!result.ok && result.code === 'auth_rejected') {
    console.log('    FAIL — the proxy rejected the token (401).');
    console.log('');
    console.log('========================================');
    console.log('  ACTIVATION INCOMPLETE');
    console.log('');
    console.log('  The token was written to both .env files, but the proxy');
    console.log('  would not accept it. Contact support for assistance.');
    console.log('========================================');
  } else {
    console.log(`    ${result.detail || 'Unexpected gateway response'}`);
    console.log('');
    console.log('  The token was written and validated in both .env files.');
    console.log('  The live probe did not complete cleanly; try again with a');
    console.log('  running gateway, or contact support.');
  }

  console.log('');
  if (spawnedChild && spawnedChild.pid) {
    console.log(`  (agent-gateway was started for this test — PID ${spawnedChild.pid})`);
    console.log(`  (stop it with: kill ${spawnedChild.pid}, or leave it running)`);
    console.log('');
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err.message);
  process.exit(1);
});
