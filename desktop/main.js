const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

let mainWindow = null;
let gatewayProcess = null;
let spawnedByUs = false;

// Probe http://localhost:3000/health
function checkHealth() {
  return new Promise((resolve) => {
    const req = http.get('http://localhost:3000/health', (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const parsed = JSON.parse(data);
            resolve({ healthy: true, data: parsed, statusCode: 200 });
          } catch (e) {
            resolve({ healthy: true, statusCode: 200 });
          }
        } else if (res.statusCode === 401 || res.statusCode === 403) {
          resolve({ healthy: false, authError: true, statusCode: res.statusCode });
        } else {
          resolve({ healthy: false, statusCode: res.statusCode });
        }
      });
    });

    req.on('error', () => {
      resolve({ healthy: false });
    });

    req.setTimeout(1000, () => {
      req.destroy();
      resolve({ healthy: false });
    });
  });
}

// Find bundled Portable Node and server.js paths
function findPaths() {
  const isWin = process.platform === 'win32';
  const nodeRel = isWin ? 'node.exe' : 'bin/node';

  const nodeCandidates = [
    path.join(process.resourcesPath, 'node', nodeRel),
    path.resolve(__dirname, '../build/Agelgay/node', nodeRel),
    path.resolve(__dirname, '../../build/Agelgay/node', nodeRel)
  ];

  let nodeBin = null;
  let useElectronNode = false;

  for (const candidate of nodeCandidates) {
    if (fs.existsSync(candidate)) {
      nodeBin = candidate;
      break;
    }
  }

  // Fallback to Electron's embedded Node runtime if standalone Node binary isn't bundled
  if (!nodeBin) {
    nodeBin = process.execPath;
    useElectronNode = true;
  }

  const serverCandidates = [
    path.join(process.resourcesPath, 'agent-gateway', 'server.js'),
    path.resolve(__dirname, '../agent-gateway', 'server.js'),
    path.resolve(__dirname, '../build/Agelgay/agent-gateway', 'server.js')
  ];

  let serverScript = null;
  for (const candidate of serverCandidates) {
    if (fs.existsSync(candidate)) {
      serverScript = candidate;
      break;
    }
  }

  return { nodeBin, useElectronNode, serverScript };
}

// Inspect agent-gateway .env file for activation state
function isActivated(gatewayDir) {
  const envPath = path.join(gatewayDir, '.env');
  if (!fs.existsSync(envPath)) return false;
  const content = fs.readFileSync(envPath, 'utf8');
  const match = content.match(/^PROXY_TOKEN=(.+)$/m);
  if (!match || !match[1].trim()) return false;
  return true;
}

// Spawn local Gateway child process if not already running
async function ensureGatewayRunning() {
  const healthResult = await checkHealth();
  if (healthResult.healthy) {
    console.log('[Main] Gateway server is already running on http://localhost:3000');
    return true;
  }

  const { nodeBin, useElectronNode, serverScript } = findPaths();
  if (!serverScript) {
    console.error('[Main] Could not locate agent-gateway/server.js');
    dialog.showMessageBoxSync({
      type: 'error',
      title: 'Error',
      message: 'Could not locate agent-gateway/server.js. Please check your installation.'
    });
    return false;
  }

  const gatewayDir = path.dirname(serverScript);

  // Check if valid token/activation exists before starting
  if (!isActivated(gatewayDir)) {
    console.warn('[Main] No valid activation token found in agent-gateway/.env');
    dialog.showMessageBoxSync({
      type: 'warning',
      title: 'Activation Required',
      message: 'No valid activation token found for Agelgay.\n\nPlease run the activation process (activate.sh / activate.cmd) first before launching the desktop app.',
      buttons: ['OK']
    });
    return false;
  }

  const spawnEnv = { ...process.env };
  if (useElectronNode) {
    spawnEnv.ELECTRON_RUN_AS_NODE = '1';
  }

  console.log(`[Main] Spawning gateway process with Node: ${nodeBin} (useElectronNode=${useElectronNode}), Script: ${serverScript}`);
  gatewayProcess = spawn(nodeBin, [serverScript], {
    cwd: gatewayDir,
    env: spawnEnv,
    stdio: 'inherit'
  });
  spawnedByUs = true;

  gatewayProcess.on('error', (err) => {
    console.error('[Main] Failed to spawn gateway child process:', err);
  });

  gatewayProcess.on('exit', (code, signal) => {
    console.log(`[Main] Gateway child process exited with code ${code}, signal ${signal}`);
  });

  // Poll /health until healthy (up to 30 attempts, 300ms interval)
  console.log('[Main] Polling http://localhost:3000/health...');
  for (let attempt = 1; attempt <= 40; attempt++) {
    await new Promise((r) => setTimeout(r, 300));
    const h = await checkHealth();
    if (h.healthy) {
      console.log(`[Main] Gateway server responded healthy on attempt ${attempt}`);
      return true;
    }
    if (h.authError) {
      dialog.showMessageBoxSync({
        type: 'warning',
        title: 'Activation Required',
        message: 'Agelgay gateway returned an authentication error. Please verify activation.',
        buttons: ['OK']
      });
      return false;
    }
  }

  dialog.showMessageBoxSync({
    type: 'error',
    title: 'Server Timeout',
    message: 'Timed out waiting for Agelgay gateway server to start on http://localhost:3000.',
    buttons: ['OK']
  });
  return false;
}

// Safely terminate spawned gateway process
function stopGateway() {
  if (spawnedByUs && gatewayProcess && !gatewayProcess.killed) {
    console.log('[Main] Terminating spawned gateway child process (SIGTERM)...');
    try {
      gatewayProcess.kill('SIGTERM');
    } catch (e) {
      console.error('[Main] Error sending SIGTERM:', e);
    }

    const killTimer = setTimeout(() => {
      if (gatewayProcess && !gatewayProcess.killed) {
        console.log('[Main] Gateway process did not exit within timeout. Sending SIGKILL...');
        try {
          gatewayProcess.kill('SIGKILL');
        } catch (e) {
          console.error('[Main] Error sending SIGKILL:', e);
        }
      }
    }, 2000);
    if (killTimer.unref) killTimer.unref();
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hidden',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    backgroundColor: '#0b0f19',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadURL('http://localhost:3000');

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Wire IPC handlers for window controls
ipcMain.on('window-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('window-maximize', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});

ipcMain.on('window-close', () => {
  if (mainWindow) mainWindow.close();
});

// App Lifecycle Hooks
app.whenReady().then(async () => {
  const ready = await ensureGatewayRunning();
  if (ready) {
    createWindow();
  } else {
    app.quit();
  }
});

app.on('window-all-closed', () => {
  stopGateway();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  stopGateway();
});

app.on('will-quit', () => {
  stopGateway();
});
