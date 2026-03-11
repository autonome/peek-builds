/**
 * Wonderwall Home UI
 *
 * Renders a grid of service cards showing connection status.
 * Each card has Connect / Disconnect actions.
 */

import services from './services/index.js';

const api = typeof window !== 'undefined' && window.app ? window.app : null;

// ============================================================================
// DOM references
// ============================================================================

const servicesGrid = document.getElementById('services-grid');
const statusBar = document.getElementById('status-bar');
const statusMessage = document.getElementById('status-message');

// ============================================================================
// Status bar helpers
// ============================================================================

function showStatus(message, type = 'info') {
  statusBar.className = `status-bar ${type}`;
  statusMessage.textContent = message;
  statusBar.style.display = 'block';

  if (type === 'success') {
    setTimeout(() => { statusBar.style.display = 'none'; }, 3000);
  }
}

function hideStatus() {
  statusBar.style.display = 'none';
}

// ============================================================================
// Render a single service card
// ============================================================================

function createServiceCard(service, tokenData) {
  const connected = tokenData !== null;

  const card = document.createElement('div');
  card.className = 'service-card';
  card.dataset.serviceId = service.id;

  // Determine status info text
  let infoText = '';
  if (connected && tokenData.connectedAt) {
    const date = new Date(tokenData.connectedAt);
    infoText = `Connected ${date.toLocaleDateString()}`;
  }

  // Check if token is expired
  let expired = false;
  if (connected && tokenData.expiresAt && tokenData.expiresAt < Date.now()) {
    expired = true;
    infoText = 'Token expired — reconnect';
  }

  card.innerHTML = `
    <div class="service-card-header">
      <div class="service-icon" style="background: ${service.color}">
        ${service.icon}
      </div>
      <div class="service-name">${service.name}</div>
    </div>
    <div class="service-status">
      <span class="status-dot ${connected && !expired ? 'connected' : 'disconnected'}"></span>
      <span>${connected && !expired ? 'Connected' : expired ? 'Expired' : 'Not connected'}</span>
    </div>
    <div class="service-info">${infoText}</div>
    <button class="btn ${connected ? 'btn-disconnect' : 'btn-connect'}" data-action="${connected ? 'disconnect' : 'connect'}">
      ${connected ? 'Disconnect' : 'Connect'}
    </button>
  `;

  // Wire up button
  const btn = card.querySelector('.btn');
  btn.addEventListener('click', async () => {
    if (btn.dataset.action === 'connect') {
      await handleConnect(service, card);
    } else {
      await handleDisconnect(service, card);
    }
  });

  return card;
}

// ============================================================================
// Connect / Disconnect handlers
// ============================================================================

async function handleConnect(service, card) {
  const btn = card.querySelector('.btn');
  btn.disabled = true;
  btn.textContent = 'Connecting...';
  card.classList.add('connecting');
  hideStatus();

  try {
    await service.connect();
    showStatus(`Connected to ${service.name}`, 'success');
    await renderServices(); // re-render all cards to update status
  } catch (err) {
    console.error(`[wonderwall] Connect error for ${service.id}:`, err);
    showStatus(`Failed to connect ${service.name}: ${err.message}`, 'error');
    btn.disabled = false;
    btn.textContent = 'Connect';
    card.classList.remove('connecting');
  }
}

async function handleDisconnect(service, card) {
  const btn = card.querySelector('.btn');
  btn.disabled = true;
  btn.textContent = 'Disconnecting...';
  hideStatus();

  try {
    await service.disconnect();
    showStatus(`Disconnected from ${service.name}`, 'success');
    await renderServices(); // re-render all cards
  } catch (err) {
    console.error(`[wonderwall] Disconnect error for ${service.id}:`, err);
    showStatus(`Failed to disconnect ${service.name}: ${err.message}`, 'error');
    btn.disabled = false;
    btn.textContent = 'Disconnect';
  }
}

// ============================================================================
// Render all service cards
// ============================================================================

async function renderServices() {
  servicesGrid.innerHTML = '';

  for (const service of services) {
    const tokenData = await service.getToken();
    const card = createServiceCard(service, tokenData);
    servicesGrid.appendChild(card);
  }
}

// ============================================================================
// Init
// ============================================================================

renderServices();
