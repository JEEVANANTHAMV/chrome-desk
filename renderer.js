// renderer.js
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
    const hasAuth = await window.electronAPI.checkNgrokAuth();
    if (!hasAuth) {
      showAuthDialog();
      elements.startBtn.classList.remove('loading');
      elements.startBtn.querySelector('.btn-text').textContent = 'Start Tunnel';
      return;
    }

    const result = await window.electronAPI.startTunnel();
    if (result.success) {
      isRunning = true;
      elements.tunnelUrl.value = result.tunnelUrl;
      addLog('✅ Tunnel started: ' + result.tunnelUrl);
      updateUI();
    } else {
      if (result.error === 'auth_required') {
        showAuthDialog();
      } else {
        addLog('❌ ' + result.error);
      }
    }
  } catch (err) {
    addLog('Error: ' + (err && err.message ? err.message : String(err)));
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
    addLog('Stopped');
  } catch (err) {
    addLog('Stop failed: ' + (err && err.message ? err.message : String(err)));
  }
  elements.stopBtn.classList.remove('loading');
  elements.stopBtn.querySelector('.btn-text').textContent = 'Stop Tunnel';
}

async function copyUrl() {
  try {
    await navigator.clipboard.writeText(elements.tunnelUrl.value);
    elements.copyBtn.textContent = 'Copied!';
    setTimeout(() => elements.copyBtn.textContent = 'Copy', 1500);
  } catch (err) {
    addLog('Copy failed: ' + (err && err.message ? err.message : String(err)));
  }
}

function toggleTerminal() {
  const visible = elements.terminal.style.display !== 'none';
  elements.terminal.style.display = visible ? 'none' : 'block';
  elements.toggleTerminal.textContent = visible ? 'Show' : 'Hide';
}

function showAuthDialog() {
  const dialog = document.createElement('div');
  dialog.className = 'auth-dialog';
  dialog.innerHTML = `
    <div class="auth-content" style="position:fixed;left:50%;top:30%;transform:translate(-50%,-30%);background:#fff;padding:18px;border-radius:8px;box-shadow:0 6px 18px rgba(0,0,0,0.2);z-index:9999">
      <h3>Ngrok Authentication Required</h3>
      <p>1. Sign up at <a href="#" id="ngrok-link">https://ngrok.com</a></p>
      <p>2. Get your authtoken from dashboard</p>
      <input type="text" id="auth-token" placeholder="Enter your ngrok authtoken" style="width:100%;padding:8px;margin:8px 0">
      <div style="text-align:right">
        <button id="auth-cancel" style="margin-right:8px">Cancel</button>
        <button id="auth-submit">Submit</button>
      </div>
    </div>
  `;
  document.body.appendChild(dialog);

  document.getElementById('ngrok-link').addEventListener('click', (e) => { e.preventDefault(); window.electronAPI.openExternal('https://ngrok.com'); });

  document.getElementById('auth-cancel').onclick = () => {
    document.body.removeChild(dialog);
    addLog('Authentication cancelled');
  };

  document.getElementById('auth-submit').onclick = async () => {
    const token = document.getElementById('auth-token').value.trim();
    if (!token) return alert('Please enter your ngrok authtoken');
    const submitBtn = document.getElementById('auth-submit');
    submitBtn.disabled = true; submitBtn.textContent = 'Setting...';
    const ok = await window.electronAPI.setNgrokToken(token);
    submitBtn.disabled = false; submitBtn.textContent = 'Submit';
    if (ok) {
      document.body.removeChild(dialog);
      addLog('Token set. Starting tunnel...');
      startTunnel();
    } else {
      alert('Failed to set token. Please check token and try again.');
    }
  };
}

elements.startBtn.addEventListener('click', startTunnel);
elements.stopBtn.addEventListener('click', stopTunnel);
elements.copyBtn.addEventListener('click', copyUrl);
elements.toggleTerminal.addEventListener('click', toggleTerminal);

if (window.electronAPI && window.electronAPI.onLog) {
  window.electronAPI.onLog((event, message) => addLog(message));
  window.electronAPI.getStatus().then(status => {
    isRunning = status.isRunning;
    if (status.tunnelUrl) elements.tunnelUrl.value = status.tunnelUrl;
    updateUI();
  }).catch(() => updateUI());
} else {
  updateUI();
}
