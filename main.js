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
let isShuttingDown = false;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(path.join(homeDir, 'chrome-mcp-tunnel.log'), line + '\n'); } catch (e) {}
  // Use the safe sender instead of direct access
  safeSendToRenderer('log', line);
}

function safeSendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
    try {
      mainWindow.webContents.send(channel, data);
      return true;
    } catch (e) {
      return false;
    }
  }
  return false;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 720,
    icon: path.join(__dirname, 'images.png'),
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

// Replace the createNgrokConfig function with this
function createNgrokConfig(webAddr) {
  const configPath = path.join(app.getPath('userData'), 'ngrok-temp.yml');
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

// Add this function to download ngrok at runtime
async function ensureNgrokBinary() {
  if (app.isPackaged) {
    const fs = require('fs');
    const path = require('path');
    const https = require('https');
    const { pipeline } = require('stream');
    const { promisify } = require('util');
    const streamPipeline = promisify(pipeline);
    
    const appPath = app.getPath('exe');
    const appDir = path.dirname(appPath);
    const ngrokPath = path.join(appDir, platform === 'win32' ? 'ngrok.exe' : 'ngrok');
    
    if (!fs.existsSync(ngrokPath)) {
      log('Ngrok binary not found, downloading...');
      
      // Try multiple download URLs in case one fails
      const downloadUrls = platform === 'win32' 
        ? [
            'https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-windows-amd64.zip',
            'https://github.com/ngrok/ngrok/releases/download/v3.1.0/ngrok-v3-stable-windows-amd64.zip'
          ]
        : platform === 'darwin'
          ? [
              'https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-darwin-amd64.zip',
              'https://github.com/ngrok/ngrok/releases/download/v3.1.0/ngrok-v3-stable-darwin-amd64.zip'
            ]
          : [
              'https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.zip',
              'https://github.com/ngrok/ngrok/releases/download/v3.1.0/ngrok-v3-stable-linux-amd64.zip'
            ];
      
      const zipPath = path.join(appDir, 'ngrok.zip');
      
      let downloadSuccess = false;
      
      // Try each URL until one succeeds
      for (const downloadUrl of downloadUrls) {
        try {
          log(`Attempting to download ngrok from: ${downloadUrl}`);
          
          // Download the zip file
          await new Promise((resolve, reject) => {
            const file = fs.createWriteStream(zipPath);
            https.get(downloadUrl, response => {
              if (response.statusCode === 200) {
                streamPipeline(response, file)
                  .then(() => resolve())
                  .catch(reject);
              } else {
                reject(new Error(`HTTP ${response.statusCode}`));
              }
            }).on('error', reject);
          });
          
          // Extract the zip file
          const AdmZip = require('adm-zip');
          const zip = new AdmZip(zipPath);
          zip.extractAllTo(appDir, true);
          
          // Make it executable on non-Windows
          if (platform !== 'win32') {
            fs.chmodSync(ngrokPath, '755');
          }
          
          // Clean up
          fs.unlinkSync(zipPath);
          
          log('Ngrok binary downloaded successfully');
          downloadSuccess = true;
          break; // Exit the loop if download succeeds
        } catch (err) {
          log(`Failed to download ngrok from ${downloadUrl}: ${err.message}`);
          // Continue to the next URL
        }
      }
      
      if (!downloadSuccess) {
        throw new Error('Failed to download ngrok from all sources');
      }
    } else {
      log('Ngrok binary found at: ' + ngrokPath);
    }
  }
}

// Modify the startNgrok function to handle network restrictions
async function startNgrok() {
  // Use CLI approach for both development and packaged versions
  log('Using ngrok CLI approach');
  
  try {
    return await spawnNgrokCli();
  } catch (err) {
    log(`ngrok CLI failed: ${err.message}`);
    
    // Check if it's a network-related error
    if (err.message.includes('EACCES') || 
        err.message.includes('ENOTFOUND') || 
        err.message.includes('ECONNREFUSED') ||
        err.message.includes('network') ||
        err.message.includes('firewall')) {
      log('Network restriction detected. Trying alternative approach...');
      
      // Try with different port ranges
      for (let port = 8080; port <= 8090; port++) {
        try {
          log(`Trying with port ${port}...`);
          // Modify the spawnNgrokCli function to accept a port parameter
          return await spawnNgrokCliWithPort(port);
        } catch (portErr) {
          log(`Port ${port} failed: ${portErr.message}`);
        }
      }
      
      throw new Error('All ports blocked by network restrictions');
    }
    
    throw err;
  }
}

// Replace the entire startNgrok function with this
async function startNgrok() {
  // Use CLI approach for both development and packaged versions
  log('Using ngrok CLI approach');
  return await spawnNgrokCli();
}

// Replace the spawnNgrokCli function with this
function spawnNgrokCli() {
  return new Promise(async (resolve, reject) => {
    try {
      // Find an available port for the web interface
      const webPort = await findAvailablePort();
      const webAddr = `127.0.0.1:${webPort}`;
      
      // Create temporary config file with the available port
      const configPath = createNgrokConfig(webAddr);
      
      // binary path resolution
      let binary;
      if (app.isPackaged) {
        // In packaged app, look in resources/ngrok-bin/
        const resourcesPath = process.resourcesPath;
        binary = path.join(resourcesPath, 'ngrok-bin', platform, platform === 'win32' ? 'ngrok.exe' : 'ngrok');
        
        if (!fs.existsSync(binary)) {
          throw new Error(`ngrok binary not found at ${binary}. Please ensure ngrok is properly packaged with your application.`);
        }
      } else {
        // In development environment, use local binaries
        binary = path.join(__dirname, 'ngrok-binaries', platform, platform === 'win32' ? 'ngrok.exe' : 'ngrok');
        if (!fs.existsSync(binary)) {
          throw new Error(`ngrok binary not found at ${binary}. Run 'npm run download-ngrok' first.`);
        }
      }

      // Get authtoken from config
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

// Replace the setNgrokAuth function to work without the ngrok package in packaged version
async function setNgrokAuth(token) {
  try {
    if (!token || typeof token !== 'string' || token.trim() === '') {
      log('setNgrokAuth: invalid token');
      return false;
    }
    
    if (!app.isPackaged) {
      // In development, use the ngrok package
      const ngrok = require('ngrok');
      await ngrok.authtoken(token.trim());
      log('ngrok authtoken saved programmatically.');
    } else {
      // In packaged version, save to config file directly
      const ngrokDir = path.join(homeDir, '.ngrok2');
      if (!fs.existsSync(ngrokDir)) {
        fs.mkdirSync(ngrokDir, { recursive: true });
      }
      
      const configPath = path.join(ngrokDir, 'ngrok.yml');
      let configContent = '';
      
      if (fs.existsSync(configPath)) {
        configContent = fs.readFileSync(configPath, 'utf8');
      }
      
      // Remove existing authtoken if any
      configContent = configContent.replace(/^authtoken:.*$/m, '').trim();
      
      // Add new authtoken
      configContent += `\nauthtoken: ${token.trim()}\n`;
      
      fs.writeFileSync(configPath, configContent);
      log('ngrok authtoken saved to config file.');
    }
    
    return true;
  } catch (err) {
    log('setNgrokAuth error: ' + (err && err.message ? err.message : String(err)));
    return false;
  }
}

// Remove the ensureNgrokBinary function entirely - we don't need it anymore
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
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--no-sandbox', // Helps with process cleanup
        '--disable-dev-shm-usage', // Helps with resource cleanup
        '--disable-features=TranslateUI', // Prevents automatic closing
        '--disable-ipc-flooding-protection', // Prevents automatic closing
        '--disable-logging', // Reduces log noise
        '--disable-breakpad', // Disables crash reporting
        '--disable-component-update', // Prevents automatic updates
        '--disable-domain-reliability', // Prevents automatic closing
        '--disable-client-side-phishing-detection', // Prevents automatic closing
        '--disable-popup-blocking', // Prevents popups that might cause issues
        '--disable-prompt-on-repost', // Prevents prompts that might cause issues
        '--disable-hang-monitor', // Prevents hang monitoring that might close Chrome
        '--disable-sync-preferences', // Prevents sync that might cause issues
        '--disable-restore-session-state', // Prevents session restore that might cause issues
        '--disable-component-extensions-with-background-pages', // Prevents extensions from running
        '--disable-background-mode' // Prevents background mode that might cause issues
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
        processes.chrome = null; // Clear the reference immediately
        
        // Only reject if we haven't resolved yet and we're not in the process of shutting down
        if (!resolved && !isShuttingDown) {
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
  console.log('Stopping all components...');
  isRunning = false;
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  const stopPromises = [];
  
  // Stop proxy server first to prevent new connections
  if (processes.proxyServer) {
    stopPromises.push(new Promise((resolve) => {
      try { 
        processes.proxyServer.close(() => {
          console.log('Proxy server stopped');
          resolve();
        }); 
      } catch (e) { 
        console.error('proxy close error:', e.message); 
        resolve();
      }
    }));
    processes.proxyServer = null;
  }

  // Stop ngrok
  if (processes.ngrok) {
    stopPromises.push(new Promise(async (resolve) => {
      try {
        if (processes.ngrok.pid && processes.ngrok.kill) {
          processes.ngrok.kill('SIGTERM');
          console.log('ngrok process killed');
        } else {
          try { 
            const ngrok = require('ngrok'); 
            await ngrok.disconnect(); 
            await ngrok.kill(); 
            console.log('ngrok disconnected and killed');
          } catch (e) { console.error('ngrok programmatic stop error:', e.message); }
        }
      } catch (e) { console.error('ngrok stop error:', e.message); }
      resolve();
    }));
    processes.ngrok = null;
    tunnelUrl = '';
  } else {
    // Fallback cleanup
    stopPromises.push(new Promise(async (resolve) => {
      try { 
        const ngrok = require('ngrok'); 
        await ngrok.disconnect(); 
        await ngrok.kill(); 
        console.log('ngrok disconnected and killed (fallback)');
      } catch (e) { console.error('ngrok fallback stop error:', e.message); }
      resolve();
    }));
    tunnelUrl = '';
  }

  // Stop Chrome process
  if (processes.chrome) {
    stopPromises.push(new Promise((resolve) => {
      try { 
        processes.chrome.kill('SIGTERM'); 
        console.log('Chrome process terminated');
        // Give Chrome time to close gracefully
        setTimeout(() => {
          if (processes.chrome && !processes.chrome.killed) {
            try {
              processes.chrome.kill('SIGKILL');
              console.log('Chrome process force killed');
            } catch (e) {}
          }
          resolve();
        }, 2000);
      } catch (e) { 
        console.error('chrome kill error:', e.message); 
        resolve();
      }
    }));
    processes.chrome = null;
  }

  // Wait for all cleanup operations with timeout
  try {
    await Promise.race([
      Promise.all(stopPromises),
      new Promise(resolve => setTimeout(resolve, 5000)) // 5 second timeout
    ]);
  } catch (e) {
    console.error('stopAll error:', e.message);
  }
  
  console.log('All components stopped.');
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
        console.log(`No existing ngrok processes found or error killing them: ${error.message}`);
      } else {
        console.log('Killed existing ngrok processes');
      }
      resolve();
    });
  });
}

// Add function to kill all related processes on app exit
function forceKillAllProcesses() {
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    const commands = [];
    
    if (platform === 'win32') {
      commands.push('taskkill /F /IM ngrok.exe');
      commands.push('taskkill /F /IM chrome.exe /FI "COMMANDLINE eq *--remote-debugging-port*"');
    } else {
      commands.push('pkill -f ngrok');
      commands.push('pkill -f "chrome.*--remote-debugging-port"');
    }
    
    let completed = 0;
    const total = commands.length;
    
    if (total === 0) {
      resolve();
      return;
    }
    
    commands.forEach(command => {
      exec(command, (error) => {
        if (error) {
          console.log(`Process cleanup command failed: ${command} - ${error.message}`);
        } else {
          console.log(`Process cleanup successful: ${command}`);
        }
        completed++;
        if (completed === total) {
          resolve();
        }
      });
    });
    
    // Timeout after 3 seconds
    setTimeout(() => {
      if (completed < total) {
        console.log('Process cleanup timeout');
        resolve();
      }
    }, 3000);
  });
}

app.whenReady().then(createWindow).catch(e => { 
  log('app.whenReady error: ' + e.message); 
  app.quit(); 
});

app.on('window-all-closed', async () => { 
  if (isShuttingDown) return; // Add this at the beginning
  try {
    await stopAll();
    await forceKillAllProcesses();
  } catch (e) {
    console.error('Error during cleanup:', e);
  }
  if (platform !== 'darwin') {
    app.exit(0);
  }
});

app.on('before-quit', async (event) => {
  if (isShuttingDown) return;
  event.preventDefault();
  try {
    await stopAll();
    await forceKillAllProcesses();
  } catch (e) {
    console.error('Error during cleanup:', e);
  }
  // Force quit after cleanup
  setImmediate(() => {
    app.exit(0);
  });
});

process.on('uncaughtException', async (err) => { 
  if (isShuttingDown || (err.message && err.message.includes('Object has been destroyed'))) {
    process.exit(1);
}
  console.error('Uncaught Exception:', err); 
  try {
    await stopAll(); 
    await forceKillAllProcesses();
  } catch (e) {
    console.error('Error during cleanup:', e);
  }
  process.exit(1);
});

// Handle process termination signals
process.on('SIGTERM', async () => {
  if (isShuttingDown) return;
  console.log('Received SIGTERM, shutting down gracefully');
  try {
    await stopAll();
    await forceKillAllProcesses();
  } catch (e) {
    console.error('Error during SIGTERM cleanup:', e);
  }
  process.exit(0);
});

process.on('SIGINT', async () => {
  if (isShuttingDown) return;
  console.log('Received SIGINT, shutting down gracefully');
  try {
    await stopAll();
    await forceKillAllProcesses();
  } catch (e) {
    console.error('Error during SIGINT cleanup:', e);
  }
  process.exit(0);
});

// Windows specific signal
if (platform === 'win32') {
  process.on('SIGBREAK', async () => {
    if (isShuttingDown) return;
    console.log('Received SIGBREAK, shutting down gracefully');
    try {
      await stopAll();
      await forceKillAllProcesses();
    } catch (e) {
      console.error('Error during SIGBREAK cleanup:', e);
    }
    process.exit(0);
  });
}

process.on('unhandledRejection', (err) => { 
  // Only log if it's not the "Object has been destroyed" error or if we're not shutting down
  if (!isShuttingDown && (!err.message || !err.message.includes('Object has been destroyed'))) {
    console.error('Unhandled Rejection:', err);
  }
  // Don't call stopAll for unhandled rejections as it might cause more issues
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