const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

let mainWindow;
let processes = { ngrok: null, chrome: null, proxy: null };
let tunnelUrl = '';
let isRunning = false;

const platform = os.platform();
const homeDir = os.homedir();
const chromeDataDir = path.join(homeDir, '.chrome-mcp-profile');

const chromePaths = {
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  ],
  linux: ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium']
};

if (!fs.existsSync(chromeDataDir)) {
  fs.mkdirSync(chromeDataDir, { recursive: true });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    title: 'Chrome MCP Tunnel',
    resizable: false
  });

  mainWindow.loadFile('index.html');
  mainWindow.setMenuBarVisibility(false);
  
  // Open DevTools in development
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }
}

function findChrome() {
  const paths = Array.isArray(chromePaths[platform]) ? chromePaths[platform] : [chromePaths[platform]];
  
  for (const chromePath of paths) {
    try {
      if (fs.existsSync(chromePath)) {
        return chromePath;
      }
    } catch (e) {
      continue;
    }
  }
  
  if (platform !== 'win32') {
    return paths[0];
  }
  
  throw new Error('Chrome not found');
}

function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}`;
  console.log(logMessage);
  
  // Write to log file
  const logFile = path.join(os.homedir(), 'chrome-mcp-tunnel.log');
  try {
    fs.appendFileSync(logFile, logMessage + '\n');
  } catch (e) {}
  
  if (mainWindow) {
    mainWindow.webContents.send('log', logMessage);
  }
}

async function setNgrokAuth(token) {
  try {
    log('Setting ngrok authtoken...');
    const ngrok = require('ngrok');
    await ngrok.authtoken(token.trim());
    log('Ngrok authtoken set successfully');
    return true;
  } catch (error) {
    log(`Failed to set authtoken: ${error.message}`);
    return false;
  }
}

async function startNgrok() {
  try {
    log('Starting ngrok tunnel on port 9223...');
    const ngrok = require('ngrok');
    
    tunnelUrl = await ngrok.connect({
      port: 9223,
      proto: 'http'
    });
    
    log(`Tunnel URL: ${tunnelUrl}`);
    return tunnelUrl;
  } catch (error) {
    log(`Ngrok error: ${error.message}`);
    if (error.message.includes('authentication') || error.message.includes('authtoken')) {
      throw new Error('Ngrok authentication required. Please set your authtoken.');
    }
    throw error;
  }
}

function startChrome() {
  return new Promise((resolve, reject) => {
    log('Starting Chrome...');
    
    try {
      const chromePath = findChrome();
      log(`Using Chrome: ${chromePath}`);
      
      const args = [
        '--remote-debugging-port=9222',
        '--remote-debugging-address=0.0.0.0',
        `--user-data-dir=${chromeDataDir}`,
        '--no-first-run',
        '--disable-default-apps',
        '--headless'
      ];
      
      processes.chrome = spawn(chromePath, args, { stdio: 'pipe' });
      
      processes.chrome.stdout.on('data', (data) => {
        log(`Chrome stdout: ${data.toString().trim()}`);
      });
      
      processes.chrome.stderr.on('data', (data) => {
        log(`Chrome stderr: ${data.toString().trim()}`);
      });
      
      processes.chrome.on('error', (error) => {
        log(`Chrome spawn error: ${error.message}`);
        reject(error);
      });
      
      processes.chrome.on('close', (code) => {
        log(`Chrome exited with code ${code}`);
      });
      
      setTimeout(() => {
        log('Chrome should be started, checking...');
        // Test if Chrome is accessible
        const testReq = http.get('http://localhost:9222/json/version', (res) => {
          log('Chrome debugging port is accessible');
          resolve();
        });
        testReq.on('error', (err) => {
          log(`Chrome not accessible: ${err.message}`);
          reject(new Error('Chrome debugging port not accessible'));
        });
        testReq.setTimeout(2000);
      }, 3000);
      
    } catch (error) {
      log(`Chrome start error: ${error.message}`);
      reject(error);
    }
  });
}

function startProxy() {
  return new Promise((resolve, reject) => {
    log('Starting proxy server...');
    
    const hostname = tunnelUrl.replace('https://', '');
    const httpProxy = require('http-proxy');
    
    const proxy = httpProxy.createProxyServer({
      target: 'http://localhost:9222',
      changeOrigin: true,
      ws: true
    });
    
    proxy.on('error', (err) => {
      log(`Proxy error: ${err.message}`);
    });
    
    const server = http.createServer((req, res) => {
      proxy.web(req, res, (err) => {
        if (err) {
          log(`Proxy web error: ${err.message}`);
          res.writeHead(502);
          res.end('Chrome not accessible');
        }
      });
    });
    
    server.on('upgrade', (req, socket, head) => {
      proxy.ws(req, socket, head);
    });
    
    server.listen(9223, () => {
      log('Proxy server started on port 9223');
      processes.proxy = { kill: () => server.close() };
      resolve();
    });
  });
}

async function stopAll() {
  log('Stopping all processes...');
  
  if (processes.proxy && processes.proxy.kill) {
    processes.proxy.kill();
  }
  
  if (tunnelUrl) {
    try {
      const ngrok = require('ngrok');
      await ngrok.disconnect(tunnelUrl);
    } catch (e) {
      log(`Error stopping ngrok: ${e.message}`);
    }
  }
  
  if (processes.chrome) {
    processes.chrome.kill('SIGTERM');
  }
  
  processes = { ngrok: null, chrome: null, proxy: null };
  isRunning = false;
  tunnelUrl = '';
}

async function startTunnel() {
  try {
    if (isRunning) {
      return { success: false, error: 'Already running' };
    }

    await startNgrok();
    await startChrome();
    await startProxy();
    
    isRunning = true;
    return { success: true, tunnelUrl };
    
  } catch (error) {
    await stopAll();
    return { success: false, error: error.message };
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  stopAll();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  stopAll();
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
  try {
    const os = require('os');
    const path = require('path');
    const fs = require('fs');
    
    const configPath = path.join(os.homedir(), '.ngrok2', 'ngrok.yml');
    if (fs.existsSync(configPath)) {
      const config = fs.readFileSync(configPath, 'utf8');
      return config.includes('authtoken:');
    }
    return false;
  } catch (error) {
    return false;
  }
});
ipcMain.handle('open-external', async (event, url) => {
  const { shell } = require('electron');
  await shell.openExternal(url);
});