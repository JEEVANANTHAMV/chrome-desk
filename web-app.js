let isRunning = false;
let tunnelUrl = '';

const elements = {
    startBtn: document.getElementById('start-btn'),
    stopBtn: document.getElementById('stop-btn'),
    statusDot: document.getElementById('status-dot'),
    statusText: document.getElementById('status-text'),
    urlSection: document.getElementById('url-section'),
    tunnelUrlInput: document.getElementById('tunnel-url'),
    copyBtn: document.getElementById('copy-btn'),
    terminal: document.getElementById('terminal'),
    toggleTerminal: document.getElementById('toggle-terminal')
};

function updateUI() {
    if (isRunning) {
        elements.statusDot.className = 'status-dot running';
        elements.statusText.textContent = 'Running';
        elements.startBtn.disabled = true;
        elements.stopBtn.disabled = false;
        elements.urlSection.style.display = 'block';
    } else {
        elements.statusDot.className = 'status-dot stopped';
        elements.statusText.textContent = 'Stopped';
        elements.startBtn.disabled = false;
        elements.stopBtn.disabled = true;
        elements.urlSection.style.display = 'none';
        elements.tunnelUrlInput.value = '';
    }
}

function addLog(message) {
    elements.terminal.textContent += message + '\n';
    elements.terminal.scrollTop = elements.terminal.scrollHeight;
}

async function setNgrokToken() {
    const token = prompt('Enter your ngrok authtoken:\n\n1. Sign up at https://ngrok.com\n2. Get your authtoken from dashboard\n3. Enter it below:');
    
    if (!token) return false;
    
    try {
        const response = await fetch('/api/set-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token })
        });
        
        const result = await response.json();
        return result.success;
    } catch (error) {
        addLog(`Error setting token: ${error.message}`);
        return false;
    }
}

async function startTunnel() {
    elements.startBtn.classList.add('loading');
    elements.startBtn.querySelector('.btn-text').textContent = 'Starting...';
    
    try {
        const response = await fetch('/api/start', { method: 'POST' });
        const result = await response.json();
        
        if (result.success) {
            isRunning = true;
            tunnelUrl = result.tunnelUrl;
            elements.tunnelUrlInput.value = tunnelUrl;
            addLog(`✅ Tunnel started: ${tunnelUrl}`);
            addLog(`🌐 WebSocket URL: ${tunnelUrl.replace('https://', 'wss://')}/`);
            updateUI();
        } else {
            if (result.error.includes('Already running')) {
                // Update UI to reflect running state
                const statusResponse = await fetch('/api/status');
                const status = await statusResponse.json();
                isRunning = status.isRunning;
                tunnelUrl = status.tunnelUrl;
                if (tunnelUrl) {
                    elements.tunnelUrlInput.value = tunnelUrl;
                }
                updateUI();
                addLog(`ℹ️ ${result.error}`);
            } else {
                addLog(`❌ Error: ${result.error}`);
                
                if (result.error.includes('authentication')) {
                    const tokenSet = await setNgrokToken();
                    if (tokenSet) {
                        addLog('✅ Token set, please try starting again');
                    }
                }
            }
        }
    } catch (error) {
        addLog(`❌ Error: ${error.message}`);
    }
    
    elements.startBtn.classList.remove('loading');
    elements.startBtn.querySelector('.btn-text').textContent = 'Start Tunnel';
}

async function stopTunnel() {
    elements.stopBtn.classList.add('loading');
    elements.stopBtn.querySelector('.btn-text').textContent = 'Stopping...';
    
    try {
        await fetch('/api/stop', { method: 'POST' });
        isRunning = false;
        tunnelUrl = '';
        addLog('🛑 Tunnel stopped');
        updateUI();
    } catch (error) {
        addLog(`❌ Error: ${error.message}`);
    }
    
    elements.stopBtn.classList.remove('loading');
    elements.stopBtn.querySelector('.btn-text').textContent = 'Stop Tunnel';
}

async function copyUrl() {
    try {
        await navigator.clipboard.writeText(elements.tunnelUrlInput.value);
        elements.copyBtn.classList.add('copied');
        elements.copyBtn.textContent = 'Copied!';
        
        setTimeout(() => {
            elements.copyBtn.classList.remove('copied');
            elements.copyBtn.textContent = 'Copy';
        }, 2000);
    } catch (error) {
        addLog(`Copy failed: ${error.message}`);
    }
}

function toggleTerminal() {
    const isVisible = elements.terminal.style.display !== 'none';
    elements.terminal.style.display = isVisible ? 'none' : 'block';
    elements.toggleTerminal.textContent = isVisible ? 'Show' : 'Hide';
}

// Event listeners
elements.startBtn.addEventListener('click', startTunnel);
elements.stopBtn.addEventListener('click', stopTunnel);
elements.copyBtn.addEventListener('click', copyUrl);
elements.toggleTerminal.addEventListener('click', toggleTerminal);

// Initialize
async function init() {
    try {
        const response = await fetch('/api/status');
        const status = await response.json();
        isRunning = status.isRunning;
        tunnelUrl = status.tunnelUrl;
        if (tunnelUrl) {
            elements.tunnelUrlInput.value = tunnelUrl;
        }
        updateUI();
        addLog('🚀 Chrome MCP Tunnel Web Interface Ready');
        addLog('💡 Click "Start Tunnel" to begin');
    } catch (error) {
        addLog(`❌ Initialization error: ${error.message}`);
    }
}

init();