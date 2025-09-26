const { app, BrowserWindow, ipcMain } = require('electron');
const isDev = process.env.NODE_ENV === 'development';

// Handle app not ready in headless environment
if (!app) {
  console.log('Electron app not available - running in headless mode');
  process.exit(0);
}
const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

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
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
  ],
  linux: ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium']
};

// Ensure chrome data directory exists
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
  if (mainWindow) {
    mainWindow.webContents.send('log', logMessage);
  }
}

function getNgrokPath() {
  const ngrok = require('ngrok');
  return ngrok;
}

async function startNgrok() {
  log('Starting ngrok tunnel...');
  try {
    const ngrok = getNgrokPath();
    tunnelUrl = await ngrok.connect(9223);
    log(`Tunnel URL: ${tunnelUrl}`);
    return tunnelUrl;
  } catch (error) {
    log(`Ngrok error: ${error.message}`);
    throw error;
  }
}

async function checkNgrokAuth() {
  try {
    const ngrok = getNgrokPath();
    // Check if authtoken exists in ngrok config
    return await ngrok.getAuthtoken();
  } catch (error) {
    return false;
  }
}

async function setNgrokAuth(token) {
  try {
    const ngrok = getNgrokPath();
    await ngrok.authtoken(token.trim());
    log('Ngrok authtoken set successfully');
    return true;
  } catch (error) {
    log(`Failed to set authtoken: ${error.message}`);
    return false;
  }
}

function startChrome() {
  return new Promise((resolve, reject) => {
    log('Starting Chrome with remote debugging...');
    
    try {
      const chromePath = findChrome();
      const hostname = tunnelUrl.replace('https://', '');
      
      const chromeArgs = [
        '--remote-debugging-port=9222',
        '--remote-debugging-address=0.0.0.0',
        `--remote-debugging-hostname=${hostname}`,
        `--user-data-dir=${chromeDataDir}`,
        '--no-first-run',
        '--disable-default-apps'
      ];
      
      log(`Using Chrome at: ${chromePath}`);
      processes.chrome = spawn(chromePath, chromeArgs);
      
      processes.chrome.on('error', (error) => {
        log(`Chrome error: ${error.message}`);
        reject(error);
      });
      
      processes.chrome.on('close', (code) => {
        log(`Chrome process exited with code ${code}`);
      });
      
      setTimeout(() => {
        log('Chrome started successfully');
        resolve();
      }, 3000);
      
    } catch (error) {
      log(`Error finding Chrome: ${error.message}`);
      reject(error);
    }
  });
}

function startProxy() {
  return new Promise((resolve) => {
    log('Starting proxy server...');
    
    const hostname = tunnelUrl.replace('https://', '');
    const proxyCode = `
const http = require('http');

const server = http.createServer((req, res) => {
  const options = {
    hostname: 'localhost',
    port: 9222,
    path: req.url,
    method: req.method,
    headers: req.headers
  };
  
  const proxyReq = http.request(options, (proxyRes) => {
    let body = '';
    proxyRes.on('data', chunk => body += chunk);
    proxyRes.on('end', () => {
      const modifiedBody = body
        .replace(/ws:\\/\\/localhost:9222\\//g, 'wss://${hostname}/')
        .replace(/ws=localhost:9222\\//g, 'ws=${hostname}/');
      
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      res.end(modifiedBody);
    });
  });
  
  req.pipe(proxyReq);
});

server.listen(9223, () => console.log('Proxy running'));
`;
    
    fs.writeFileSync(path.join(__dirname, 'proxy-temp.js'), proxyCode);
    processes.proxy = spawn('node', [path.join(__dirname, 'proxy-temp.js')]);
    
    processes.proxy.on('close', (code) => {
      log(`Proxy process exited with code ${code}`);
    });
    
    setTimeout(() => {
      log('Proxy started successfully');
      resolve();
    }, 2000);
  });
}

async function stopAllProcesses() {
  log('Stopping all processes...');
  
  // Stop ngrok
  try {
    const ngrok = getNgrokPath();
    await ngrok.disconnect();
  } catch (e) {}
  
  // Stop other processes
  Object.keys(processes).forEach(key => {
    if (processes[key]) {
      processes[key].kill();
      processes[key] = null;
    }
  });
  
  // Clean up temp proxy file
  try {
    fs.unlinkSync(path.join(__dirname, 'proxy-temp.js'));
  } catch (e) {}
  
  isRunning = false;
  tunnelUrl = '';
  log('All processes stopped');
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
    log('All services started successfully');
    return { success: true, tunnelUrl };
    
  } catch (error) {
    log(`Error starting services: ${error.message}`);
    await stopAllProcesses();
    return { success: false, error: error.message };
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  stopAllProcesses();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('before-quit', () => {
  stopAllProcesses();
});

app.on('will-quit', (event) => {
  if (isRunning) {
    event.preventDefault();
    stopAllProcesses().then(() => {
      app.quit();
    });
  }
});

ipcMain.handle('start-tunnel', startTunnel);
ipcMain.handle('stop-tunnel', () => {
  stopAllProcesses();
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