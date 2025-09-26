let isRunning = false;
let logs = [];

const elements = {
    startBtn: document.getElementById('start-btn'),
    stopBtn: document.getElementById('stop-btn'),
    statusDot: document.getElementById('status-dot'),
    statusText: document.getElementById('status-text'),
    urlSection: document.getElementById('url-section'),
    tunnelUrl: document.getElementById('tunnel-url'),
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
        elements.tunnelUrl.value = '';
    }
}

function addLog(message) {
    logs.push(message);
    elements.terminal.textContent = logs.join('\n');
    elements.terminal.scrollTop = elements.terminal.scrollHeight;
}

function clearLogs() {
    logs = [];
    elements.terminal.textContent = '';
}

async function startTunnel() {
    elements.startBtn.classList.add('loading');
    elements.startBtn.querySelector('.btn-text').textContent = 'Starting...';
    clearLogs();
    
    try {
        // Check if ngrok is authenticated
        const hasAuth = await window.electronAPI.checkNgrokAuth();
        if (!hasAuth) {
            showAuthDialog();
            return;
        }
        
        const result = await window.electronAPI.startTunnel();
        
        if (result.success) {
            isRunning = true;
            elements.tunnelUrl.value = result.tunnelUrl;
            updateUI();
        } else {
            addLog(`Error: ${result.error}`);
        }
    } catch (error) {
        addLog(`Error: ${error.message}`);
    }
    
    elements.startBtn.classList.remove('loading');
    elements.startBtn.querySelector('.btn-text').textContent = 'Start Tunnel';
}

async function stopTunnel() {
    elements.stopBtn.classList.add('loading');
    elements.stopBtn.querySelector('.btn-text').textContent = 'Stopping...';
    
    try {
        await window.electronAPI.stopTunnel();
        isRunning = false;
        updateUI();
    } catch (error) {
        addLog(`Error: ${error.message}`);
    }
    
    elements.stopBtn.classList.remove('loading');
    elements.stopBtn.querySelector('.btn-text').textContent = 'Stop Tunnel';
}

async function copyUrl() {
    try {
        await navigator.clipboard.writeText(elements.tunnelUrl.value);
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

// Listen for logs from main process
window.electronAPI.onLog((event, message) => {
    addLog(message);
});

function showAuthDialog() {
    const dialog = document.createElement('div');
    dialog.className = 'auth-dialog';
    dialog.innerHTML = `
        <div class="auth-content">
            <h3>Ngrok Authentication Required</h3>
            <p>1. Sign up at <a href="#" onclick="window.electronAPI.openExternal('https://ngrok.com')">https://ngrok.com</a></p>
            <p>2. Get your authtoken from dashboard</p>
            <p>3. Enter it below:</p>
            <input type="text" id="auth-token" placeholder="Enter your ngrok authtoken">
            <div class="auth-buttons">
                <button id="auth-cancel">Cancel</button>
                <button id="auth-submit">Submit</button>
            </div>
        </div>
    `;
    document.body.appendChild(dialog);
    
    document.getElementById('auth-cancel').onclick = () => {
        document.body.removeChild(dialog);
        addLog('Ngrok authentication cancelled');
    };
    
    document.getElementById('auth-submit').onclick = async () => {
        const token = document.getElementById('auth-token').value.trim();
        if (!token) return;
        
        const authResult = await window.electronAPI.setNgrokToken(token);
        document.body.removeChild(dialog);
        
        if (authResult) {
            startTunnel();
        } else {
            addLog('Failed to set ngrok authtoken');
        }
    };
}

// Initialize UI
window.electronAPI.getStatus().then(status => {
    isRunning = status.isRunning;
    if (status.tunnelUrl) {
        elements.tunnelUrl.value = status.tunnelUrl;
    }
    updateUI();
});

updateUI();