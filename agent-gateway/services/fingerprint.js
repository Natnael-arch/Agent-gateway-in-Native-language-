/**
 * Machine Fingerprint Service
 *
 * Builds a stable, cross-platform fingerprint of the local machine, combines it
 * with OS/host details, and returns a SHA-256 hash. Only the HASH ever leaves
 * the machine — raw hardware identifiers (machine-id, IOPlatformUUID,
 * MachineGuid) are never transmitted or logged.
 *
 * Stability: prefers the canonical per-OS machine identifier so a normal
 * hardware-independent upgrade (OS patch, reinstall) keeps the fingerprint.
 * Falls back to platform + arch + hostname + user when no machine id is
 * readable (e.g. inside a container), which is still stable for that box.
 *
 * CLI: run directly to print the fingerprint hash — used by support to rebind
 * an instance after a hardware change (see usage-proxy scripts/rebindInstance.js).
 *
 *   node services/fingerprint.js
 *   node services/fingerprint.js --json   # {"fingerprint":"<sha256>"}
 *
 * The hash is cached after first computation.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

let cachedFingerprint = null;

/** Read the canonical Linux machine-id (dbus / machine-id). */
function readLinuxMachineId() {
  for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      const v = fs.readFileSync(p, 'utf8').trim();
      if (/^[0-9a-f]{32}$/i.test(v)) return v;
    } catch {
      // try next
    }
  }
  return null;
}

/** Read the macOS hardware UUID via ioreg (fails silently if unavailable). */
function readDarwinMachineId() {
  try {
    const out = execFileSync(
      'ioreg',
      ['-rd1', '-c', 'IOPlatformExpertDevice'],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
    if (m && m[1]) return m[1];
  } catch {
    // ioreg missing/unavailable (e.g. sandboxed)
  }
  return null;
}

/** Read the Windows MachineGuid registry value (fails silently if unavailable). */
function readWindowsMachineId() {
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const m = out.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/);
    if (m && m[1]) return m[1];
  } catch {
    // reg query unavailable
  }
  return null;
}

/** Best-effort machine id for the current platform; null when unavailable. */
function readMachineId() {
  switch (process.platform) {
    case 'linux':
      return readLinuxMachineId();
    case 'darwin':
      return readDarwinMachineId();
    case 'win32':
      return readWindowsMachineId();
    default:
      return null;
  }
}

/**
 * Compute the machine fingerprint (SHA-256 hex). Address bits of the identity
 * separately so a missing machine-id cannot silently make every fallback box
 * collide: hostname+user is included, and when no stable machine-id exists we
 * append a high-entropy per-install salt persisted locally.
 */
function generateFingerprint() {
  if (cachedFingerprint) return cachedFingerprint;

  const machineId = readMachineId();
  const parts = [
    `platform=${process.platform}`,
    `arch=${os.arch()}`,
  ];

  if (machineId) {
    parts.push(`machine=${machineId}`);
  } else {
    // No OS machine-id: pin to this install so all fallback boxes still
    // diverge. 128 random bits persisted once; subsequent runs stay stable.
    let salt = null;
    const saltPath = path.join(os.homedir(), '.agent-gateway-fingerprint-salt');
    try {
      salt = fs.readFileSync(saltPath, 'utf8').trim();
      if (!/^[0-9a-f]{32,}$/i.test(salt)) salt = null;
    } catch {
      salt = null;
    }
    if (!salt) {
      salt = crypto.randomBytes(16).toString('hex');
      try {
        fs.writeFileSync(saltPath, salt, { mode: 0o600 });
      } catch {
        // fall through: fingerprint becomes hostname+user based, still usable
      }
    }
    parts.push(`machine=none:${salt || ''}`);
  }

  parts.push(`host=${os.hostname()}`);
  parts.push(`user=${os.userInfo().username}`);

  cachedFingerprint = crypto.createHash('sha256').update(parts.join('|')).digest('hex');
  return cachedFingerprint;
}

/** Return the current instance fingerprint hash (computing it if needed). */
function getFingerprint() {
  return generateFingerprint();
}

/** Constant header name agent-gateway sends to usage-proxy. */
const FINGERPRINT_HEADER = 'X-Instance-Fingerprint';

if (require.main === module) {
  const fp = getFingerprint();
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify({ fingerprint: fp }) + '\n');
  } else {
    process.stdout.write(fp + '\n');
  }
}

module.exports = { generateFingerprint, getFingerprint, FINGERPRINT_HEADER };