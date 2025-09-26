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

// Initialize UI
window.electronAPI.getStatus().then(status => {
    isRunning = status.isRunning;
    if (status.tunnelUrl) {
        elements.tunnelUrl.value = status.tunnelUrl;
    }
    updateUI();
});

updateUI();