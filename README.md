# Chrome MCP Tunnel Desktop Application

A standalone desktop application that provides easy Chrome remote debugging access via ngrok tunnel for MCP (Model Context Protocol) clients.

## Features

- 🖥️ **Desktop Application** - No web browser needed, runs as native app
- 🚀 **One-click setup** - Start/stop tunnel with smart buttons
- 🔧 **Auto-installation** - Automatically installs ngrok if not present
- 🌐 **Cross-platform** - Works on Windows, macOS, and Linux
- 📊 **Live logs** - Toggleable terminal showing all process activity
- 📋 **Easy copy** - One-click copy of tunnel URL
- 🔒 **Secure** - Uses dedicated Chrome profile in hidden directory

## Quick Start

### Windows
```cmd
install.bat
start.bat
```

### macOS/Linux
```bash
./install.sh
./start.sh
```

## How it works

1. **Ngrok Setup** - Checks for ngrok installation and installs if needed
2. **Tunnel Creation** - Creates ngrok tunnel on port 9223
3. **Chrome Launch** - Starts Chrome with remote debugging enabled
4. **Proxy Server** - Runs proxy to handle WebSocket URL rewriting
5. **URL Generation** - Provides tunnel URL for MCP client connection

## Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Electron      │────│   Chrome        │────│   Ngrok         │
│   Desktop App   │    │   (Port 9222)   │    │   Tunnel        │
└─────────────────┘    └─────────────────┘    └─────────────────┘
                              │
                       ┌─────────────────┐
                       │   Proxy         │
                       │   (Port 9223)   │
                       └─────────────────┘
```

## File Structure

```
chrome-desk/
├── main.js              # Electron main process
├── preload.js           # IPC preload script  
├── renderer.js          # UI logic
├── index.html           # Application UI
├── style.css            # Application styles
├── package.json         # Dependencies and build config
├── install.sh/.bat      # Installation scripts
├── start.sh/.bat        # Start scripts
├── test/                # Test files
│   ├── unit.test.js     # Unit tests
│   ├── build.test.js    # Build validation
│   └── integration.test.js # Integration tests
├── validate-production.js # Production validator
└── README.md
```

## Development Commands

```bash
# Install dependencies
npm install

# Start application (requires GUI)
npm start

# Build for distribution
npm run build
```

## Scripts

- `npm start` - Start the desktop application
- `npm run build` - Build for current platform
- `npm run build-all` - Build for all platforms (Windows, macOS, Linux)

## Requirements

- Node.js 16+
- Chrome/Chromium browser
- Internet connection (for ngrok)

## Platform Support

- **Linux** - AppImage distribution
- **macOS** - DMG distribution
- **Windows** - NSIS installer

## Security Notes

- Chrome profile stored in `~/.chrome-mcp-profile` (hidden)
- No admin privileges required
- Tunnel URLs are temporary and expire when stopped
- All processes are properly cleaned up on exit

## Building Installers for Distribution

### Prerequisites
```bash
npm install
```

### Build Commands

**Windows (.exe installer):**
```bash
npm run build-win
# Output: dist/Chrome MCP Tunnel Setup 1.0.0.exe
```

**Windows (.exe installer):**
```bash
npm run build-win
# Output: dist/Chrome MCP Tunnel Setup 1.0.0.exe
```

**macOS (.dmg installer):**
```bash
npm run build-mac
# Output: dist/Chrome MCP Tunnel-1.0.0.dmg
```

**Linux (AppImage):**
```bash
npm run build-linux
# Output: dist/Chrome MCP Tunnel-1.0.0.AppImage
```

**Current Platform:**
```bash
npm run build
```

### Build Output Files
```
dist/
├── Chrome MCP Tunnel-1.0.0-mac.zip       # macOS app (zip)
├── Chrome MCP Tunnel-1.0.0.AppImage       # Linux installer
├── win-unpacked/Chrome MCP Tunnel.exe     # Windows executable
└── mac/Chrome MCP Tunnel.app              # macOS app bundle
```

### Cross-Platform Notes
- **macOS builds**: ✅ Creates .zip and .app bundle
- **Linux builds**: ✅ Creates AppImage
- **Windows builds**: ⚠️ Creates unpacked .exe (requires wine for installer)

### Working Commands
```bash
npm run build-mac    # ✅ Works - creates macOS .zip
npm run build-linux  # ✅ Works - creates Linux AppImage  
npm run build-win    # ⚠️ Creates unpacked Windows .exe
```

## Troubleshooting

1. **Ngrok not found** - App will auto-install ngrok
2. **Chrome not found** - Ensure Chrome is installed in standard location
3. **Port conflicts** - App uses ports 9222, 9223 internally
4. **Tunnel timeout** - Check internet connection and try again

## License

MIT License