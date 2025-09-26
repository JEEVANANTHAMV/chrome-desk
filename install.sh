#!/bin/bash

echo "🚀 Installing Chrome MCP Tunnel Desktop App..."

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "Node.js is not installed. Please install Node.js first."
    echo "Visit: https://nodejs.org/"
    exit 1
fi

# Check Node.js version
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 16 ]; then
    echo "Node.js version 16 or higher is required. Current version: $(node -v)"
    exit 1
fi

echo "Node.js $(node -v) detected"

# Install dependencies
echo "📦 Installing dependencies..."
npm install

echo "Installation complete!"
echo ""
echo "To start the application:"
echo "  npm start"
echo ""
echo "To build for distribution:"
echo "  npm run build"