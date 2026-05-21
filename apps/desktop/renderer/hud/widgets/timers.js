/**
 * Timers Widget — displays active timer count + display from timer:hud-update.
 *
 * The timers feature publishes timer:hud-update once per tick with
 * { text, count } when timers are running, or { text: '' } when none.
 */

const api = window.app;

const valueEl = document.getElementById('timers-value');

const setIdle = () => {
  if (!valueEl) return;
  valueEl.textContent = '—';
  valueEl.classList.remove('has-active');
};

const setActive = (text) => {
  if (!valueEl) return;
  valueEl.textContent = text;
  valueEl.classList.add('has-active');
};

const handleHudUpdate = (msg) => {
  if (!msg || !msg.text) {
    setIdle();
    return;
  }
  setActive(msg.text);
};

const init = async () => {
  if (api.initialize) {
    await api.initialize();
  }

  setIdle();

  api.pubsub.subscribe('timer:hud-update', handleHudUpdate);

  // Pull current state on load — background may already have running timers
  // and we'll only see ticks once a second; this avoids a flash of "—".
  api.pubsub.subscribe('timer:state-response', (msg) => {
    if (!msg || !Array.isArray(msg.timers)) return;
    const running = msg.timers.filter((t) => t.metadata && t.metadata.status === 'running');
    if (running.length === 0) {
      setIdle();
      return;
    }
    // Background recomputes hud text from tickData, but on first load before a
    // tick fires, just show the count so the widget isn't blank.
    setActive(running.length === 1 ? '1 timer' : `${running.length} timers`);
  });
  api.pubsub.publish('timer:request-state', {});
};

init().catch((error) => console.error('[hud:timers] Init error:', error));
