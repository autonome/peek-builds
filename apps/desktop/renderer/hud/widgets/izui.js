/**
 * IZUI State Widget — displays current IZUI state
 */

const api = window.app;

const izuiValue = document.getElementById('izui-value');

let currentIzuiState = 'idle';

const updateDisplay = () => {
  if (!izuiValue) return;

  // Remove old state classes
  izuiValue.classList.remove('izui-idle', 'izui-transient', 'izui-active', 'izui-overlay');

  izuiValue.textContent = currentIzuiState;
  izuiValue.classList.add(`izui-${currentIzuiState}`);

};

const refreshIzuiState = async () => {
  try {
    const state = await api.izui.getState();
    if (state) {
      currentIzuiState = state;
      updateDisplay();
    }
  } catch (error) {
    console.error('[hud:izui] Error:', error);
  }
};

const init = async () => {
  if (api.initialize) {
    await api.initialize();
  }

  await refreshIzuiState();

  // Subscribe to IZUI state changes
  api.subscribe('izui:state-changed', (msg) => {
    if (msg.state) {
      currentIzuiState = msg.state;
      updateDisplay();
    }
  });

  // Periodic fallback
  setInterval(refreshIzuiState, 5000);
};

init().catch(error => console.error('[hud:izui] Init error:', error));
