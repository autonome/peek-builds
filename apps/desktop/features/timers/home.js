/**
 * Timers Home UI
 *
 * Displays all timers in a card grid with live-updating displays.
 * Active timers update every second via timer:tick pubsub events.
 * Completed/stopped timers shown in a muted history section below.
 */

const api = window.app;

// Timer type icons (text-based, no emoji)
const TIMER_ICONS = {
  countdown: 'CD',
  alarm: 'AL',
  stopwatch: 'SW',
  interval: 'IV'
};

// Timer type labels
const TIMER_LABELS = {
  countdown: 'Countdown',
  alarm: 'Alarm',
  stopwatch: 'Stopwatch',
  interval: 'Interval'
};

// All timers loaded from datastore
let allTimers = [];

// Map of timer ID -> card element for fast tick updates
const cardMap = new Map();

// ===== Format Helpers =====

const formatDuration = (ms) => {
  if (ms < 0) ms = 0;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
};

const getTimerDisplay = (timer) => {
  const meta = timer.metadata;
  const now = Date.now();

  if (meta.status === 'paused') {
    if (meta.timerType === 'stopwatch') {
      return formatDuration(meta.elapsed);
    }
    if (meta.timerType === 'countdown') {
      const elapsed = meta.pausedAt - meta.startedAt;
      return formatDuration(meta.duration - elapsed);
    }
    if (meta.timerType === 'alarm') {
      return formatDuration(meta.targetTime - meta.pausedAt);
    }
    if (meta.timerType === 'interval') {
      const elapsed = meta.pausedAt - meta.startedAt;
      const inCycle = elapsed % meta.duration;
      return formatDuration(meta.duration - inCycle);
    }
  }

  if (meta.status === 'running') {
    if (meta.timerType === 'countdown') {
      return formatDuration(meta.duration - (now - meta.startedAt));
    }
    if (meta.timerType === 'alarm') {
      return formatDuration(meta.targetTime - now);
    }
    if (meta.timerType === 'stopwatch') {
      return formatDuration(meta.elapsed + (now - meta.startedAt));
    }
    if (meta.timerType === 'interval') {
      const elapsed = now - meta.startedAt;
      const inCycle = elapsed % meta.duration;
      return formatDuration(meta.duration - inCycle);
    }
  }

  if (meta.status === 'completed' || meta.status === 'stopped') {
    if (meta.timerType === 'stopwatch') {
      return formatDuration(meta.elapsed);
    }
    if (meta.timerType === 'countdown') {
      return formatDuration(meta.duration);
    }
    return 'Done';
  }

  return '0:00';
};

const formatCompletedTime = (timer) => {
  const meta = timer.metadata;
  if (!meta.stoppedAt && !meta.startedAt) return '';
  const ts = meta.stoppedAt || meta.startedAt;
  const d = new Date(ts);
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

// ===== Card Creation =====

const createTimerCard = (timer) => {
  const meta = timer.metadata;
  const isActive = meta.status === 'running' || meta.status === 'paused';

  const card = document.createElement('peek-card');
  card.className = 'timer-card';
  if (isActive) card.classList.add('active-timer');
  if (meta.status === 'paused') card.classList.add('paused-timer');
  card.elevated = true;
  card.dataset.timerId = timer.id;

  // Header: type badge + title
  const header = document.createElement('div');
  header.slot = 'header';
  header.style.display = 'flex';
  header.style.alignItems = 'center';
  header.style.gap = '8px';

  const badge = document.createElement('span');
  badge.className = `timer-badge timer-badge-${meta.timerType}`;
  badge.textContent = TIMER_ICONS[meta.timerType] || '??';

  const title = document.createElement('h2');
  title.className = 'card-title';
  title.textContent = timer.title || TIMER_LABELS[meta.timerType] || 'Timer';
  title.style.margin = '0';
  title.style.flex = '1';
  title.style.minWidth = '0';

  if (meta.status === 'paused') {
    const pauseBadge = document.createElement('span');
    pauseBadge.className = 'status-badge paused';
    pauseBadge.textContent = 'paused';
    header.appendChild(badge);
    header.appendChild(title);
    header.appendChild(pauseBadge);
  } else {
    header.appendChild(badge);
    header.appendChild(title);
  }

  card.appendChild(header);

  // Body: large time display
  const body = document.createElement('div');
  body.className = 'timer-display';
  body.textContent = getTimerDisplay(timer);
  card.appendChild(body);

  // Interval count for interval timers
  if (meta.timerType === 'interval' && meta.intervalCount > 0) {
    const countEl = document.createElement('div');
    countEl.className = 'interval-count';
    countEl.textContent = `${meta.intervalCount} interval${meta.intervalCount !== 1 ? 's' : ''} completed`;
    card.appendChild(countEl);
  }

  // Footer: action buttons for active timers, timestamp for inactive
  const footer = document.createElement('div');
  footer.slot = 'footer';
  footer.className = 'card-meta timer-footer';

  if (isActive) {
    const btnContainer = document.createElement('div');
    btnContainer.className = 'timer-actions';

    // Pause/Resume button
    if (meta.timerType !== 'alarm') {
      const pauseBtn = document.createElement('peek-button');
      pauseBtn.variant = 'ghost';
      pauseBtn.size = 'sm';
      pauseBtn.textContent = meta.status === 'paused' ? 'Resume' : 'Pause';
      pauseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (meta.status === 'paused') {
          api.pubsub.publish('timer:resume', { id: timer.id });
        } else {
          api.pubsub.publish('timer:pause', { id: timer.id });
        }
      });
      btnContainer.appendChild(pauseBtn);
    }

    // Stop button
    const stopBtn = document.createElement('peek-button');
    stopBtn.variant = 'ghost';
    stopBtn.size = 'sm';
    stopBtn.textContent = 'Stop';
    stopBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      api.pubsub.publish('timer:stop', { id: timer.id });
    });
    btnContainer.appendChild(stopBtn);

    footer.appendChild(btnContainer);
  } else {
    // Completed/stopped: show timestamp and delete button
    const timeSpan = document.createElement('span');
    timeSpan.textContent = formatCompletedTime(timer);
    footer.appendChild(timeSpan);

    const deleteBtn = document.createElement('peek-button');
    deleteBtn.variant = 'ghost';
    deleteBtn.size = 'sm';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      api.pubsub.publish('timer:delete', { id: timer.id });
    });
    footer.appendChild(deleteBtn);
  }

  card.appendChild(footer);

  return card;
};

// ===== Rendering =====

const render = () => {
  cardMap.clear();

  const activeContainer = document.querySelector('.active-cards');
  const completedContainer = document.querySelector('.completed-cards');
  const activeSection = document.getElementById('active-section');
  const completedSection = document.getElementById('completed-section');

  activeContainer.innerHTML = '';
  completedContainer.innerHTML = '';

  // Separate active from inactive
  const active = allTimers.filter(t => t.metadata.status === 'running' || t.metadata.status === 'paused');
  const inactive = allTimers.filter(t => t.metadata.status === 'completed' || t.metadata.status === 'stopped');

  // Sort: running before paused, most recent first
  active.sort((a, b) => {
    if (a.metadata.status !== b.metadata.status) {
      return a.metadata.status === 'running' ? -1 : 1;
    }
    return (b.metadata.startedAt || 0) - (a.metadata.startedAt || 0);
  });

  // Sort inactive by most recently completed
  inactive.sort((a, b) => (b.metadata.stoppedAt || b.metadata.startedAt || 0) - (a.metadata.stoppedAt || a.metadata.startedAt || 0));

  // Show/hide sections
  activeSection.style.display = active.length > 0 ? '' : 'none';
  completedSection.style.display = inactive.length > 0 ? '' : 'none';

  if (active.length === 0 && inactive.length === 0) {
    activeSection.style.display = '';
    activeContainer.innerHTML = '<div class="empty-state">No timers yet. Use the command palette to start one:<br><code>timer countdown 5m</code></div>';
  }

  for (const timer of active) {
    const card = createTimerCard(timer);
    activeContainer.appendChild(card);
    cardMap.set(timer.id, card);
  }

  for (const timer of inactive) {
    const card = createTimerCard(timer);
    completedContainer.appendChild(card);
    cardMap.set(timer.id, card);
  }
};

// ===== Live Tick Updates =====

const handleTick = (msg) => {
  if (!msg.timers) return;

  for (const tickInfo of msg.timers) {
    const card = cardMap.get(tickInfo.id);
    if (!card) continue;

    // Update the time display
    const display = card.querySelector('.timer-display');
    if (display) {
      display.textContent = tickInfo.display;
    }

    // Update interval count
    if (tickInfo.timerType === 'interval' && tickInfo.intervalCount > 0) {
      let countEl = card.querySelector('.interval-count');
      if (!countEl) {
        countEl = document.createElement('div');
        countEl.className = 'interval-count';
        // Insert before footer
        const footer = card.querySelector('[slot="footer"]');
        if (footer) {
          card.insertBefore(countEl, footer);
        } else {
          card.appendChild(countEl);
        }
      }
      countEl.textContent = `${tickInfo.intervalCount} interval${tickInfo.intervalCount !== 1 ? 's' : ''} completed`;
    }
  }
};

// ===== Initialization =====

const init = async () => {

  // Register escape handler
  api.escape.onEscape(() => {
    return { handled: false }; // Let window close
  });

  // Request current timer state from background
  api.pubsub.subscribe('timer:state-response', (msg) => {
    if (msg.timers) {
      allTimers = msg.timers;
      render();
    }
  });

  // Subscribe to tick events for live display updates
  api.pubsub.subscribe('timer:tick', handleTick);

  // Subscribe to state changes (pause, resume, stop, delete, complete)
  api.pubsub.subscribe('timer:state-changed', () => {
    // Re-request full state to re-render
    api.pubsub.publish('timer:request-state', {});
  });

  api.pubsub.subscribe('timer:completed', () => {
    api.pubsub.publish('timer:request-state', {});
  });

  // Request initial state
  api.pubsub.publish('timer:request-state', {});
};

document.addEventListener('DOMContentLoaded', init);
