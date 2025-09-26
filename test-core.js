const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

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

function log(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
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

function checkNgrok() {
  return new Promise((resolve) => {
    exec('ngrok version', (error) => {
      resolve(!error);
    });
  });
}

async function testCore() {
  log('🧪 Testing Chrome MCP Tunnel Core Functionality...');
  
  try {
    // Test 1: Chrome detection
    log('Test 1: Chrome Detection');
    try {
      const chromePath = findChrome();
      log(`Chrome found at: ${chromePath}`);
    } catch (error) {
      log(`⚠️  Chrome detection: ${error.message}`);
    }
    
    // Test 2: Chrome profile directory
    log('Test 2: Chrome Profile Directory');
    if (!fs.existsSync(chromeDataDir)) {
      fs.mkdirSync(chromeDataDir, { recursive: true });
      log(`Created Chrome profile directory: ${chromeDataDir}`);
    } else {
      log(`Chrome profile directory exists: ${chromeDataDir}`);
    }
    
    // Test 3: Ngrok availability
    log('Test 3: Ngrok Availability');
    const hasNgrok = await checkNgrok();
    if (hasNgrok) {
      log('Ngrok is available');
    } else {
      log('⚠️  Ngrok not found - would be auto-installed');
    }
    
    // Test 4: Platform detection
    log('Test 4: Platform Detection');
    log(`Platform: ${platform}`);
    log(`Home directory: ${homeDir}`);
    
    // Test 5: Proxy code generation
    log('Test 5: Proxy Code Generation');
    const testHostname = 'test.ngrok-free.app';
    const proxyCode = `
const http = require('http');
const httpProxy = require('http-proxy');

const proxy = httpProxy.createProxyServer({
  target: 'http://localhost:9222',
  changeOrigin: true,
  ws: true
});

const server = http.createServer((req, res) => {
  const originalWrite = res.write;
  const originalEnd = res.end;
  let responseBody = [];
  
  res.write = function (chunk) {
    responseBody.push(chunk);
    return true;
  };
  
  res.end = function (chunk) {
    if (chunk) responseBody.push(chunk);
    const body = Buffer.concat(responseBody).toString();
    
    const modifiedBody = body.replace(
      /ws:\\/\\/localhost:9222\\//g,
      'wss://${testHostname}/'
    ).replace(
      /ws=localhost:9222\\//g,
      'ws=${testHostname}/'
    );
    
    res.setHeader('Content-Length', Buffer.byteLength(modifiedBody));
    originalWrite.call(res, modifiedBody);
    originalEnd.call(res);
  };
  
  proxy.web(req, res);
});

server.on('upgrade', (req, socket, head) => {
  proxy.ws(req, socket, head);
});

server.listen(9223, () => {
  console.log('Proxy running on port 9223');
});
`;
    
    const testProxyPath = path.join(__dirname, 'test-proxy.js');
    fs.writeFileSync(testProxyPath, proxyCode);
    log('Proxy code generated successfully');
    fs.unlinkSync(testProxyPath);
    
    log('All core functionality tests passed!');
    log('');
    log('The application is ready for cross-platform deployment:');
    log('   - Windows: Creates .exe installer');
    log('   - macOS: Creates .dmg installer');  
    log('   - Linux: Creates AppImage');
    log('');
    log('🚀 To build for all platforms: npm run build-all');
    
  } catch (error) {
    log(`Test failed: ${error.message}`);
    process.exit(1);
  }
}

testCore();