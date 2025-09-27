const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

let processes = { ngrok: null, chrome: null, proxy: null };
let tunnelUrl = '';
let isRunning = false;

const mimeTypes = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.png': 'image/png'
};

function log(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

async function setNgrokAuth(token) {
  return new Promise((resolve) => {
    log('Setting ngrok authtoken...');
    
    const authProcess = spawn('npx', ['ngrok', 'config', 'add-authtoken', token.trim()]);
    
    authProcess.on('close', (code) => {
      if (code === 0) {
        log('Ngrok authtoken set successfully');
        resolve(true);
      } else {
        log('Failed to set ngrok authtoken');
        resolve(false);
      }
    });
    
    authProcess.on('error', (error) => {
      log(`Error setting authtoken: ${error.message}`);
      resolve(false);
    });
  });
}

async function startNgrok() {
  return new Promise((resolve, reject) => {
    log('Starting ngrok tunnel...');
    
    processes.ngrok = spawn('npx', ['ngrok', 'http', '9223', '--log=stdout'], {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    let tunnelFound = false;
    let output = '';
    
    log(`Ngrok PID: ${processes.ngrok.pid}`);
    
    processes.ngrok.stdout.on('data', (data) => {
      output += data.toString();
      log(`Ngrok: ${data.toString().trim()}`);
      
      const urlMatch = output.match(/url=https:\/\/[^\s]+/);
      if (urlMatch && !tunnelFound) {
        tunnelFound = true;
        tunnelUrl = urlMatch[0].replace('url=', '');
        log(`Tunnel URL: ${tunnelUrl}`);
        resolve(tunnelUrl);
      }
    });
    
    processes.ngrok.stderr.on('data', (data) => {
      const error = data.toString();
      log(`Ngrok stderr: ${error.trim()}`);
    });
    
    processes.ngrok.on('close', (code) => {
      log(`Ngrok exited with code ${code}`);
      if (!tunnelFound && code !== 0) {
        reject(new Error('Ngrok failed to start'));
      }
    });
    
    setTimeout(() => {
      if (!tunnelFound) {
        reject(new Error('Ngrok timeout'));
      }
    }, 15000);
  });
}

function startChrome() {
  return new Promise((resolve, reject) => {
    log('Starting Chrome...');
    
    const chromePaths = [
      'google-chrome',
      'google-chrome-stable', 
      'chromium-browser',
      'chromium'
    ];
    
    let chromePath = 'google-chrome';
    const hostname = tunnelUrl.replace('https://', '');
    
    const args = [
      '--remote-debugging-port=9222',
      '--remote-debugging-address=0.0.0.0',
      `--remote-debugging-hostname=${hostname}`,
      '--user-data-dir=/tmp/chrome-mcp-profile',
      '--no-first-run',
      '--disable-default-apps',
      '--no-sandbox'
    ];
    
    processes.chrome = spawn(chromePath, args);
    
    processes.chrome.on('error', (error) => {
      log(`Chrome error: ${error.message}`);
      reject(error);
    });
    
    processes.chrome.on('close', (code) => {
      log(`Chrome exited with code ${code}`);
    });
    
    setTimeout(() => {
      log('Chrome started');
      resolve();
    }, 3000);
  });
}

function startProxy() {
  return new Promise((resolve) => {
    log('Starting proxy server...');
    
    const hostname = tunnelUrl.replace('https://', '');
    
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
            .replace(/ws:\/\/localhost:9222\//g, `wss://${hostname}/`)
            .replace(/ws=localhost:9222\//g, `ws=${hostname}/`);
          
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          res.end(modifiedBody);
        });
      });
      
      proxyReq.on('error', (err) => {
        res.writeHead(500);
        res.end('Proxy error');
      });
      
      req.pipe(proxyReq);
    });
    
    server.listen(9223, () => {
      log('Proxy server started on port 9223');
      processes.proxy = server;
      resolve();
    });
  });
}

function stopAll() {
  log('Stopping all processes...');
  
  if (processes.proxy && processes.proxy.close) {
    processes.proxy.close();
  }
  
  if (processes.ngrok) {
    log(`Killing ngrok PID: ${processes.ngrok.pid}`);
    processes.ngrok.kill('SIGTERM');
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

    // Set token first
    const tokenSet = await setNgrokAuth('2wbRRiWbXn4G1PmHJL4HKhGZ4Rs_577ur4bfBHSBy26H2NEDd');
    if (!tokenSet) {
      return { success: false, error: 'Failed to set ngrok token' };
    }

    await startNgrok();
    await startChrome();
    await startProxy();
    
    isRunning = true;
    return { success: true, tunnelUrl };
    
  } catch (error) {
    stopAll();
    return { success: false, error: error.message };
  }
}

// Web server
const server = http.createServer((req, res) => {
  const url = req.url;
  
  // API endpoints
  if (url === '/api/start' && req.method === 'POST') {
    startTunnel().then(result => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
    return;
  }
  
  if (url === '/api/stop' && req.method === 'POST') {
    stopAll();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }
  
  if (url === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ isRunning, tunnelUrl }));
    return;
  }
  
  if (url === '/api/set-token' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      const { token } = JSON.parse(body);
      const result = await setNgrokAuth(token);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: result }));
    });
    return;
  }
  
  // Serve static files
  let filePath = url === '/' ? '/index.html' : url;
  filePath = path.join(__dirname, filePath);
  
  const ext = path.extname(filePath);
  const contentType = mimeTypes[ext] || 'text/plain';
  
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('File not found');
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    }
  });
});

const PORT = 8080;
server.listen(PORT, () => {
  console.log(`🌐 Chrome MCP Tunnel Web Server running at http://localhost:${PORT}`);
  console.log(`📱 Open this URL in your browser to test the application`);
});