// main.js (updated - robust ngrok CLI fallback + improved chrome/proxy orchestration)
const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

let mainWindow;
const homeDir = os.homedir();
const platform = os.platform();
const DEFAULT_REMOTE_DEBUG_PORT = 9222;
const PROXY_PORT = 9223;

let processes = { chrome: null, proxyServer: null, ngrok: null };
let tunnelUrl = '';
let isRunning = false;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(path.join(homeDir, 'chrome-mcp-tunnel.log'), line + '\n'); } catch (e) {}
  if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('log', line);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 720,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    title: 'Chrome MCP Tunnel'
  });
  mainWindow.loadFile('index.html');
  mainWindow.setMenuBarVisibility(false);
  if (process.env.NODE_ENV === 'development') mainWindow.webContents.openDevTools();
}

function findChrome() {
  const candidates = {
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary'
    ],
    win32: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
    ],
    linux: [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium'
    ]
  };

  const list = candidates[platform] || [];
  for (const p of list) {
    try { if (p && fs.existsSync(p)) return p; } catch (e) {}
  }

  try {
    const { execSync } = require('child_process');
    const cmd = platform === 'win32' ? 'where chrome' : 'which google-chrome || which chromium-browser || which chromium || which google-chrome-stable';
    const out = execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (out) return out.split('\n')[0].trim();
  } catch (e) {}

  throw new Error('Chrome binary not found. Please install Google Chrome or Chromium.');
}

/* ---------------- ngrok helpers ---------------- */

async function setNgrokAuth(token) {
  try {
    if (!token || typeof token !== 'string' || token.trim() === '') {
      log('setNgrokAuth: invalid token');
      return false;
    }
    // programmatic authtoken write (may update config file)
    const ngrok = require('ngrok');
    await ngrok.authtoken(token.trim());
    log('ngrok authtoken saved programmatically.');
    return true;
  } catch (err) {
    log('setNgrokAuth error (programmatic): ' + (err && err.message ? err.message : String(err)));
    // still return false so renderer will prompt user
    return false;
  }
}

async function checkNgrokAuth() {
  try {
    const cfgPaths = [
      path.join(homeDir, '.ngrok2', 'ngrok.yml'),
      path.join(homeDir, 'AppData', 'Local', 'ngrok', 'ngrok.yml')
    ];
    for (const p of cfgPaths) {
      try { if (fs.existsSync(p)) {
        const txt = fs.readFileSync(p, 'utf8');
        if (txt.includes('authtoken:')) return true;
      } } catch (e) {}
    }
    return false;
  } catch (err) {
    log('checkNgrokAuth error: ' + err.message);
    return false;
  }
}

// Prefer programmatic connect, fallback to spawning CLI if control-port errors occur
async function startNgrok() {
  // Try programmatic first (fast on many systems)
  try {
    const ngrok = require('ngrok');
    log('Attempting programmatic ngrok.connect (inspect disabled).');
    const url = await ngrok.connect({ proto: 'http', addr: PROXY_PORT, inspect: false });
    if (url) {
      tunnelUrl = url;
      log('ngrok programmatic connected: ' + url);
      processes.ngrok = { kind: 'programmatic' };
      return url;
    }
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    log('Programmatic ngrok.connect failed: ' + msg);
    // if it's an IPv6/::1:4040 ECONNREFUSED or similar, we will fallback to CLI spawn below
  }

  // FALLBACK: spawn the ngrok CLI from node_modules/.bin (reliable on Windows)
  return await spawnNgrokCli();
}

// Add this function to find an available port
async function findAvailablePort(startPort = 4040) {
  const net = require('net');
  
  function checkPort(port) {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.listen(port, '127.0.0.1', () => {
        server.once('close', () => resolve(true));
        server.close();
      });
      server.on('error', () => resolve(false));
    });
  }
  
  for (let port = startPort; port < startPort + 100; port++) {
    if (await checkPort(port)) {
      return port;
    }
  }
  
  throw new Error('No available ports found');
}

// Add this function to create a temporary ngrok config file
function createNgrokConfig(webAddr) {
  const configPath = path.join(__dirname, 'ngrok-temp.yml');
  const configContent = `version: 3
agent:
  web_addr: ${webAddr}
`;
  fs.writeFileSync(configPath, configContent);
  return configPath;
}

// Add this function to check if a port is in use
async function isPortInUse(port) {
  const net = require('net');
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(port, '127.0.0.1', () => {
      server.once('close', () => resolve(false));
      server.close();
    });
    server.on('error', () => resolve(true));
  });
}

function spawnNgrokCli() {
  return new Promise(async (resolve, reject) => {
    try {
      // Find an available port for the web interface
      const webPort = await findAvailablePort();
      const webAddr = `127.0.0.1:${webPort}`;
      
      // Create temporary config file with the available port
      const configPath = createNgrokConfig(webAddr);
      
      // binary path resolution
      const localBin = path.join(__dirname, 'node_modules', '.bin', platform === 'win32' ? 'ngrok.cmd' : 'ngrok');
      const fallback = 'ngrok';
      const binary = fs.existsSync(localBin) ? localBin : fallback;

      // prefer to pass authtoken explicitly in CLI if config exists (skip if not)
      let tokenArg = [];
      const cfg = (function findToken() {
        const cfgPaths = [path.join(homeDir, '.ngrok2', 'ngrok.yml'), path.join(homeDir, 'AppData', 'Local', 'ngrok', 'ngrok.yml')];
        for (const p of cfgPaths) {
          try { if (fs.existsSync(p)) {
            const txt = fs.readFileSync(p, 'utf8');
            const m = txt.match(/authtoken:\s*(.*)/);
            if (m && m[1]) return m[1].trim();
          } } catch (e) {}
        }
        return null;
      })();
      if (cfg) tokenArg = ['--authtoken', cfg];

      // Use config file instead of --web-addr flag
      const args = ['http', String(PROXY_PORT), '--log=stdout', '--config', configPath, ...tokenArg];

      log(`Spawning ngrok CLI with web interface at ${webAddr}: ${binary} ${args.join(' ')}`);

      const proc = spawn(binary, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      processes.ngrok = proc;
      let stdoutAcc = '';
      let stderrAcc = '';
      let resolved = false;

      // Clean up config file when process exits
      const cleanup = () => {
        try { fs.unlinkSync(configPath); } catch (e) {}
      };
      
      proc.on('exit', cleanup);
      proc.on('error', cleanup);

      const onData = (data) => {
        const s = data.toString();
        stdoutAcc += s;
        log('ngrok: ' + s.replace(/\r?\n/g, ' | '));
        
        // Look for the web interface URL
        const webInterfaceMatch = s.match(/Web Interface\s+(http:\/\/127\.0\.0\.1:\d+)/i);
        if (webInterfaceMatch && webInterfaceMatch[1]) {
          log(`ngrok web interface available at: ${webInterfaceMatch[1]}`);
        }
        
        // Try to find the tunnel URL in multiple formats
        let url = null;
        
        // New format: url=https://...
        const newFormatMatch = s.match(/url=(https:\/\/[^\s]+)/i);
        if (newFormatMatch && newFormatMatch[1]) {
          url = newFormatMatch[1].trim();
        }
        
        // Old format: Forwarding https://...
        const oldFormatMatch = s.match(/Forwarding\s+(https:\/\/[^\s]+)/i);
        if (oldFormatMatch && oldFormatMatch[1]) {
          url = oldFormatMatch[1].trim();
        }
        
        // If we found a URL and haven't resolved yet
        if (url && !resolved) {
          resolved = true;
          tunnelUrl = url;
          log('ngrok CLI forwarding found: ' + url);
          
          // Store the web interface URL for potential future use
          processes.ngrokWebInterface = webInterfaceMatch ? webInterfaceMatch[1] : `http://${webAddr}`;
          
          resolve(url);
        }
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', (d) => {
        const s = d.toString();
        stderrAcc += s;
        log('ngrok stderr: ' + s.replace(/\r?\n/g, ' | '));
      });

      proc.on('error', (err) => {
        if (!resolved) {
          resolved = true;
          cleanup();
          reject(err);
        }
      });

      // safety timeout
      const to = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          cleanup();
          const err = new Error('timeout waiting for ngrok CLI to report forwarding URL');
          reject(err);
          try { proc.kill(); } catch (e) {}
        }
      }, 30000);

      proc.on('exit', (code) => {
        clearTimeout(to);
        log('ngrok CLI exited with code ' + code);
        if (!resolved) {
          resolved = true;
          cleanup();
          reject(new Error('ngrok exited before reporting url (code ' + code + ')'));
        }
      });

    } catch (err) {
      reject(err);
    }
  });
}

// Add function to find an available port for Chrome debugging
async function findAvailableChromeDebugPort(startPort = 9222) {
  for (let port = startPort; port < startPort + 10; port++) {
    if (!(await isPortInUse(port))) {
      return port;
    }
  }
  throw new Error('No available ports found for Chrome debugging');
}

async function startChrome() {
  return new Promise(async (resolve, reject) => {
    try {
      // Find an available port for Chrome debugging
      let debugPort = await findAvailableChromeDebugPort(DEFAULT_REMOTE_DEBUG_PORT);
      log(`Starting Chrome with remote debugging port ${debugPort}`);
      
      const chromePath = findChrome();
      
      // Use a consistent user profile directory to maintain state between sessions
      const userDir = path.join(homeDir, platform === 'win32' ? `AppData\\Local\\.chrome-mcp-profile` : `.chrome-mcp-profile`);
      if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });

      const args = [
        `--remote-debugging-port=${debugPort}`,
        '--remote-debugging-address=0.0.0.0',
        '--remote-debugging-hostname=127.0.0.1',
        `--user-data-dir=${userDir}`,
        '--no-first-run',
        '--disable-default-apps',
        '--disable-background-networking',
        '--disable-sync',
        '--disable-extensions', // Disable extensions to prevent conflicts
        '--disable-plugins',   // Disable plugins
        '--disable-images',     // Disable images to speed up loading (optional)
      ];

      log(`Launching Chrome: ${chromePath} ${args.join(' ')}`);
      processes.chrome = spawn(chromePath, args, { stdio: ['ignore', 'pipe', 'pipe'] , windowsHide: true });

      let stdoutBuf = '', stderrBuf = '';
      let chromeExited = false;
      let resolved = false;

      processes.chrome.stdout.on('data', (d) => { 
        const s = d.toString(); 
        stdoutBuf += s; 
        log('Chrome stdout: ' + s.replace(/\r?\n/g, ' | ')); 
      });
      
      processes.chrome.stderr.on('data', (d) => { 
        const s = d.toString(); 
        stderrBuf += s; 
        log('Chrome stderr: ' + s.replace(/\r?\n/g, ' | ')); 
      });

      processes.chrome.on('error', (err) => { 
        log('Chrome spawn error: ' + err.message); 
        if (!chromeExited && !resolved) {
          chromeExited = true;
          resolved = true;
          reject(err); 
        }
      });

      processes.chrome.on('exit', (code, signal) => {
        log(`Chrome exited with code ${code}${signal ? (' signal: ' + signal) : ''}`);
        chromeExited = true;
        
        if (!resolved) {
          resolved = true;
          let errorMsg = `Chrome exited unexpectedly with code ${code}`;
          if (stderrBuf) errorMsg += `. stderr: ${stderrBuf.substring(0, 500)}`;
          
          // Clean up other processes
          if (processes.ngrok) {
            try { 
              if (processes.ngrok.pid && processes.ngrok.kill) {
                processes.ngrok.kill();
              } else {
                try { const ngrok = require('ngrok'); ngrok.disconnect(); ngrok.kill(); } catch (e) {}
              }
            } catch (e) { log('Error killing ngrok: ' + e.message); }
            processes.ngrok = null;
          }
          if (processes.proxyServer) {
            try { processes.proxyServer.close(); } catch (e) { log('Error closing proxy: ' + e.message); }
            processes.proxyServer = null;
          }
          
          reject(new Error(errorMsg));
        }
      });

      // Poll for /json/version with the actual port we're using
      const start = Date.now();
      const timeout = 20000;
      
      const poll = () => {
        if (chromeExited && !resolved) {
          resolved = true;
          reject(new Error('Chrome process exited before becoming available'));
          return;
        }
        
        http.get({ hostname: '127.0.0.1', port: debugPort, path: '/json/version', timeout: 2000 }, (res) => {
          if (res.statusCode === 200) {
            log('Chrome DevTools reachable.');
            // Update the global port variable if we ended up using a different port
            if (debugPort !== DEFAULT_REMOTE_DEBUG_PORT) {
              DEFAULT_REMOTE_DEBUG_PORT = debugPort;
            }
            if (!resolved) {
              resolved = true;
              resolve();
            }
          } else {
            if (Date.now() - start > timeout) {
              if (!resolved) {
                resolved = true;
                const extra = stderrBuf || stdoutBuf || '';
                reject(new Error(`Chrome startup timeout (status ${res.statusCode}). ${extra.substring(0, 500)}`));
              }
            } else setTimeout(poll, 500);
          }
        }).on('error', (e) => {
          if (Date.now() - start > timeout) {
            if (!resolved) {
              resolved = true;
              const extra = stderrBuf || stdoutBuf || '';
              reject(new Error(`Chrome startup timeout: ${e.message}. ${extra.substring(0, 500)}`));
            }
          } else setTimeout(poll, 500);
        });
      };
      
      poll();

    } catch (err) {
      reject(err);
    }
  });
}

async function startTunnel() {
  if (isRunning) return { success: false, error: 'Already running' };

  try {
    // Only kill existing ngrok processes, not Chrome
    await killExistingNgrokProcesses();
    
    // Give a moment for ports to be released
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const hasAuth = await checkNgrokAuth();
    if (!hasAuth) {
      log('ngrok auth required');
      return { success: false, error: 'auth_required' };
    }

    // 1) start a proxy with placeholder hostname (so port 9223 is listening)
    await startProxy('127.0.0.1');

    // 2) start chrome (this will handle port conflicts gracefully)
    await startChrome();

    // 3) start ngrok (programmatic or CLI fallback)
    const url = await startNgrok();
    
    // Check if URL is valid before proceeding
    if (!url || typeof url !== 'string' || !url.startsWith('http')) {
      throw new Error(`Invalid ngrok URL received: ${url}`);
    }

    // 4) restart proxy with real public hostname for correct rewrites
    const hostname = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
    await startProxy(hostname);

    isRunning = true;
    tunnelUrl = url;
    log('Tunnel ready: ' + url);
    return { success: true, tunnelUrl: url };
  } catch (err) {
    log('startTunnel error: ' + (err && err.message ? err.message : String(err)));
    await stopAll();
    if (err && String(err).toLowerCase().includes('authtoken')) return { success: false, error: 'auth_required' };
    return { success: false, error: err.message || String(err) };
  }
}

async function stopAll() {
  log('Stopping all components...');
  try {
    // Stop proxy server first to prevent new connections
    if (processes.proxyServer) {
      try { 
        processes.proxyServer.close(); 
        log('Proxy server stopped');
      } catch (e) { log('proxy close: ' + e.message); }
      processes.proxyServer = null;
    }

    // Stop ngrok
    if (processes.ngrok) {
      try {
        if (processes.ngrok.pid && processes.ngrok.kill) {
          processes.ngrok.kill();
          log('ngrok process killed');
        } else {
          try { 
            const ngrok = require('ngrok'); 
            await ngrok.disconnect(); 
            await ngrok.kill(); 
            log('ngrok disconnected and killed');
          } catch (e) { log('ngrok programmatic stop error: ' + e.message); }
        }
      } catch (e) { log('ngrok stop error: ' + e.message); }
      processes.ngrok = null;
      tunnelUrl = '';
    } else {
      try { 
        const ngrok = require('ngrok'); 
        await ngrok.disconnect(); 
        await ngrok.kill(); 
        log('ngrok disconnected and killed (fallback)');
      } catch (e) { log('ngrok fallback stop error: ' + e.message); }
      tunnelUrl = '';
    }

    // Stop ONLY the Chrome process started by this app
    if (processes.chrome) {
      try { 
        processes.chrome.kill('SIGTERM'); 
        log('Chrome process terminated');
      } catch (e) { log('chrome kill: ' + e.message); }
      processes.chrome = null;
    }
  } catch (e) {
    log('stopAll error: ' + e.message);
  } finally {
    isRunning = false;
    log('All components stopped.');
  }
}

function startProxy(hostname) {
  return new Promise((resolve, reject) => {
    try {
      if (processes.proxyServer) {
        try { processes.proxyServer.close(); } catch (e) {}
        processes.proxyServer = null;
      }
      const httpProxy = require('http-proxy');
      const proxy = httpProxy.createProxyServer({ 
        target: `http://127.0.0.1:${DEFAULT_REMOTE_DEBUG_PORT}`, 
        changeOrigin: true, 
        ws: true,
        // Add proxy error handling
        proxyTimeout: 5000
      });

      const server = http.createServer((req, res) => {
        const originalWrite = res.write;
        const originalEnd = res.end;
        const chunks = [];

        res.write = function (chunk) {
          try {
            const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
            chunks.push(b);
            return true;
          } catch (e) {
            return originalWrite.apply(res, arguments);
          }
        };

        res.end = function (chunk) {
          if (chunk) {
            const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
            chunks.push(b);
          }
          const bodyBuffer = chunks.length ? Buffer.concat(chunks) : Buffer.from('');
          const contentType = (res.getHeader('content-type') || '').toString().toLowerCase();
          let finalBody = bodyBuffer;
          try {
            if (contentType.includes('application/json') || contentType.includes('text/') || contentType.includes('application/javascript')) {
              let s = bodyBuffer.toString();
              s = s
                .replace(/ws:\/\/127\.0\.0\.1:9222/g, `wss://${hostname}`)
                .replace(/ws:\/\/localhost:9222/g, `wss://${hostname}`)
                .replace(/http:\/\/127\.0\.0\.1:9222/g, `https://${hostname}`)
                .replace(/http:\/\/localhost:9222/g, `https://${hostname}`)
                .replace(/ws=localhost:9222/g, `ws=${hostname}`)
                .replace(/ws=127\\.0\\.0\\.1:9222/g, `ws=${hostname}`);
              finalBody = Buffer.from(s);
              if (res.getHeader('content-length')) res.setHeader('content-length', Buffer.byteLength(finalBody));
            }
          } catch (e) {
            log('Error rewriting response: ' + e.message);
          }
          originalWrite.call(res, finalBody);
          originalEnd.call(res);
        };

        proxy.web(req, res, (err) => {
          try { 
            if (!res.headersSent) {
              res.writeHead(502, { 'Content-Type': 'text/plain' }); 
              res.end('Proxy error: ' + (err ? err.message : 'Unknown error'));
            }
          } catch (e) {
            log('Error sending proxy error response: ' + e.message);
          }
        });
      });

      server.on('upgrade', (req, socket, head) => {
        proxy.ws(req, socket, head, (err) => {
          if (err) {
            log('WebSocket proxy error: ' + err.message);
            socket.destroy();
          }
        });
      });

      server.on('error', (err) => {
        log('Proxy server error: ' + err.message);
        reject(err);
      });

      // Check if proxy port is available
      isPortInUse(PROXY_PORT).then(inUse => {
        if (inUse) {
          reject(new Error(`Proxy port ${PROXY_PORT} is already in use`));
        } else {
          server.listen(PROXY_PORT, '127.0.0.1', () => {
            log('Proxy listening on http://127.0.0.1:' + PROXY_PORT + ' (hostname rewrite: ' + hostname + ')');
            processes.proxyServer = server;
            resolve();
          });
        }
      }).catch(reject);

    } catch (err) {
      reject(err);
    }
  });
}


function killExistingNgrokProcesses() {
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    const command = platform === 'win32' 
      ? 'taskkill /F /IM ngrok.exe' 
      : 'pkill -f ngrok';
    
    exec(command, (error) => {
      if (error) {
        log(`No existing ngrok processes found or error killing them: ${error.message}`);
      } else {
        log('Killed existing ngrok processes');
      }
      resolve();
    });
  });
}

app.whenReady().then(createWindow).catch(e => { 
  log('app.whenReady error: ' + e.message); 
  app.quit(); 
});

app.on('window-all-closed', async () => { 
  await stopAll(); 
  if (platform !== 'darwin') app.quit(); 
});

app.on('before-quit', async (event) => { 
  if (isRunning) { 
    event.preventDefault(); 
    await stopAll(); 
    app.quit(); 
  } 
});

process.on('uncaughtException', async (err) => { 
  log('Uncaught Exception: ' + (err && err.message ? err.message : String(err))); 
  await stopAll(); 
});

process.on('unhandledRejection', async (err) => { 
  log('Unhandled Rejection: ' + (err && err.message ? err.message : String(err))); 
  await stopAll(); 
});

ipcMain.handle('start-tunnel', startTunnel);
ipcMain.handle('stop-tunnel', async () => { 
  await stopAll(); 
  return { success: true }; 
});
ipcMain.handle('get-status', () => ({ isRunning, tunnelUrl }));
ipcMain.handle('set-ngrok-token', async (event, token) => { 
  return await setNgrokAuth(token); 
});
ipcMain.handle('check-ngrok-auth', async () => { 
  return await checkNgrokAuth(); 
});
ipcMain.handle('open-external', async (event, url) => { 
  const { shell } = require('electron'); 
  await shell.openExternal(url); 
});

module.exports = { findChrome, checkNgrokAuth, setNgrokAuth, log };