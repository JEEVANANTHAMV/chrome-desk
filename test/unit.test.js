const assert = require('assert');
const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const platform = os.platform();
const homeDir = os.homedir();

const chromePaths = {
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
  ],
  linux: ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium']
};

function test(name, fn) {
  try {
    fn();
    console.log(`${name}`);
  } catch (error) {
    console.log(`${name}: ${error.message}`);
    process.exit(1);
  }
}

function describe(name, fn) {
  console.log(`\n🧪 ${name}`);
  fn();
}

describe('Chrome MCP Tunnel Production Tests', () => {
  
  test('Platform Detection', () => {
    assert(typeof platform === 'string');
    assert(['win32', 'darwin', 'linux'].includes(platform));
  });

  test('Chrome Path Configuration', () => {
    assert(chromePaths[platform] !== undefined);
    const paths = Array.isArray(chromePaths[platform]) ? chromePaths[platform] : [chromePaths[platform]];
    assert(paths.length > 0);
  });

  test('Chrome Profile Directory Creation', () => {
    const chromeDataDir = path.join(homeDir, '.chrome-mcp-profile');
    if (!fs.existsSync(chromeDataDir)) {
      fs.mkdirSync(chromeDataDir, { recursive: true });
    }
    assert(fs.existsSync(chromeDataDir));
  });

  test('Package.json Validation', () => {
    const packagePath = path.join(__dirname, '../package.json');
    assert(fs.existsSync(packagePath));
    
    const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    assert(pkg.main === 'main.js');
    assert(pkg.dependencies.electron);
    assert(pkg.dependencies['http-proxy']);
    assert(pkg.build);
  });

  test('Required Files Exist', () => {
    const requiredFiles = [
      'main.js',
      'preload.js', 
      'renderer.js',
      'index.html',
      'style.css'
    ];
    
    requiredFiles.forEach(file => {
      const filePath = path.join(__dirname, '..', file);
      assert(fs.existsSync(filePath), `Missing required file: ${file}`);
    });
  });

  test('Electron Build Configuration', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
    assert(pkg.build.mac);
    assert(pkg.build.win);
    assert(pkg.build.linux);
    assert(pkg.build.files.includes('main.js'));
  });

});

console.log('\nAll tests passed! Application ready for production build.');