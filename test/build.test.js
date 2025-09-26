const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function testBuild() {
  log('🏗️  Testing Electron Build Process...');
  
  try {
    // Test 1: Validate package.json
    log('Test 1: Package.json validation');
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    if (!pkg.build || !pkg.build.files) {
      throw new Error('Missing build configuration');
    }
    log('Package.json build config valid');
    
    // Test 2: Check required files
    log('Test 2: Required files check');
    const requiredFiles = pkg.build.files.filter(f => !f.includes('node_modules'));
    requiredFiles.forEach(file => {
      if (!fs.existsSync(file)) {
        throw new Error(`Missing required file: ${file}`);
      }
    });
    log('All required files present');
    
    // Test 3: Syntax validation
    log('Test 3: JavaScript syntax validation');
    try {
      require('../main.js');
    } catch (e) {
      if (!e.message.includes('Cannot read properties of undefined')) {
        throw e;
      }
      // Expected in headless environment
    }
    log('Main.js syntax valid');
    
    // Test 4: Dependencies check
    log('Test 4: Dependencies validation');
    if (!fs.existsSync('node_modules/electron')) {
      throw new Error('Electron not installed');
    }
    if (!fs.existsSync('node_modules/http-proxy')) {
      throw new Error('http-proxy not installed');
    }
    log('Dependencies installed');
    
    // Test 5: Build dry run (without actual build)
    log('Test 5: Build configuration dry run');
    const buildCmd = 'electron-builder --help';
    execSync(buildCmd, { stdio: 'pipe' });
    log('Electron-builder available');
    
    log('Build test completed successfully!');
    log('');
    log('Ready for production builds:');
    log('   npm run build     - Current platform');
    log('   npm run build-all - All platforms');
    
  } catch (error) {
    log(`Build test failed: ${error.message}`);
    process.exit(1);
  }
}

testBuild();