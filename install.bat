@echo off
echo 🚀 Installing Chrome MCP Tunnel Desktop App...

REM Check if Node.js is installed
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo Node.js is not installed. Please install Node.js first.
    echo Visit: https://nodejs.org/
    pause
    exit /b 1
)

echo Node.js detected
node --version

REM Install dependencies
echo 📦 Installing dependencies...
npm install
if %errorlevel% neq 0 (
    echo Failed to install dependencies
    pause
    exit /b 1
)

echo Installation complete!
echo.
echo To start the application:
echo   npm start
echo.
echo To build for distribution:
echo   npm run build
pause