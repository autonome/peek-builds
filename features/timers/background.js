/**
 * Timers Extension Background Script
 *
 * Timer engine: countdown, alarm, stopwatch, and interval timers.
 * Stores timers as items in the datastore with type "timer".
 * Runs a 1-second tick loop that updates elapsed time, checks completions,
 * fires notifications, and publishes tick events for the UI.
 *
 * Commands and shortcuts are declared in manifest.json.
 * This extension loads lazily on first command invocation.
 *
 * Runs in isolated extension process (peek://ext/timers/background.html)
 */

import { id, labels, schemas, storageKeys, defaults } from './config.js';

const api = window.app;
const debug = api.debug;

// Extension content is served from peek://ext/timers/
const address = 'peek://ext/timers/home.html';

// In-memory timer state: id -> { item, tickState }
const activeTimers = new Map();

// Single tick interval reference
let tickInterval = null;

// Audio context for bell sound (created lazily)
let audioCtx = null;

// ===== Duration Parsing =====

/**
 * Parse flexible duration strings into milliseconds.
 * Supports: "1hr", "1h", "30m", "30min", "5m30s", "90s", "90sec", "1h30m", "60" (seconds)
 * @param {string} str - Duration string
 * @returns {number|null} Duration in ms, or null if unparseable
 */
const parseDuration = (str) => {
  if (!str) return null;
  str = str.trim().toLowerCase();

  // Just a number — treat as seconds
  if (/^\d+$/.test(str)) {
    return parseInt(str, 10) * 1000;
  }

  let totalMs = 0;
  let matched = false;

  // Match hours
  const hourMatch = str.match(/(\d+)\s*(?:hr|hours?|h)/);
  if (hourMatch) {
    totalMs += parseInt(hourMatch[1], 10) * 3600000;
    matched = true;
  }

  // Match minutes
  const minMatch = str.match(/(\d+)\s*(?:min|minutes?|m)(?!s)/);
  if (minMatch) {
    totalMs += parseInt(minMatch[1], 10) * 60000;
    matched = true;
  }

  // Match seconds
  const secMatch = str.match(/(\d+)\s*(?:sec|seconds?|s)/);
  if (secMatch) {
    totalMs += parseInt(secMatch[1], 10) * 1000;
    matched = true;
  }

  return matched ? totalMs : null;
};

// ===== Time Parsing (for alarm) =====

/**
 * Parse a time string into a target epoch ms.
 * Supports: "6pm", "14:30", "6:30pm", "6:30am"
 * If the time has already passed today, sets it for tomorrow.
 * @param {string} str - Time string
 * @returns {number|null} Target epoch ms, or null if unparseable
 */
const parseTime = (str) => {
  if (!str) return null;
  str = str.trim().toLowerCase();

  let hours = null;
  let minutes = 0;

  // Match "6pm", "6am", "6:30pm", "6:30am", "14:30"
  const match12 = str.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  const match24 = str.match(/^(\d{1,2}):(\d{2})$/);

  if (match12) {
    hours = parseInt(match12[1], 10);
    minutes = match12[2] ? parseInt(match12[2], 10) : 0;
    const period = match12[3];
    if (period === 'pm' && hours !== 12) hours += 12;
    if (period === 'am' && hours === 12) hours = 0;
  } else if (match24) {
    hours = parseInt(match24[1], 10);
    minutes = parseInt(match24[2], 10);
  }

  if (hours === null || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }

  const now = new Date();
  const target = new Date(now);
  target.setHours(hours, minutes, 0, 0);

  // If the time has already passed today, set for tomorrow
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }

  return target.getTime();
};

// ===== Format Helpers =====

/**
 * Format milliseconds as HH:MM:SS or MM:SS or 0:SS
 * @param {number} ms - Milliseconds
 * @returns {string} Formatted time string
 */
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

/**
 * Format remaining time until a target timestamp
 * @param {number} targetMs - Target epoch ms
 * @returns {string} Formatted time remaining
 */
const formatTimeRemaining = (targetMs) => {
  const remaining = targetMs - Date.now();
  return formatDuration(remaining);
};

/**
 * Format a human-readable timer status
 * @param {object} timer - Timer metadata
 * @returns {string} Status string
 */
const formatTimerStatus = (timer) => {
  const meta = timer;
  switch (meta.status) {
    case 'running': {
      if (meta.timerType === 'countdown') {
        const remaining = meta.duration - (Date.now() - meta.startedAt);
        return `Countdown: ${formatDuration(remaining)} remaining`;
      }
      if (meta.timerType === 'alarm') {
        return `Alarm: ${formatTimeRemaining(meta.targetTime)} until alarm`;
      }
      if (meta.timerType === 'stopwatch') {
        const elapsed = meta.elapsed + (Date.now() - meta.startedAt);
        return `Stopwatch: ${formatDuration(elapsed)}`;
      }
      if (meta.timerType === 'interval') {
        const elapsed = Date.now() - meta.startedAt;
        const inCycle = elapsed % meta.duration;
        return `Interval: ${formatDuration(meta.duration - inCycle)} (${meta.intervalCount} cycles)`;
      }
      return 'Running';
    }
    case 'paused': return 'Paused';
    case 'completed': return 'Completed';
    case 'stopped': return 'Stopped';
    default: return meta.status || 'Unknown';
  }
};

// ===== Bell Sound =====

/**
 * Play a bell tone using Web Audio API (no external file needed)
 */
const playBell = () => {
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    const ctx = audioCtx;

    // Bell tone: two overlapping sine waves with decay
    const now = ctx.currentTime;
    const duration = 0.8;

    // Primary tone
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.value = 830; // approximately A5-ish bell tone
    gain1.gain.setValueAtTime(0.3, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + duration);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + duration);

    // Harmonic overtone
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.value = 1660; // octave above
    gain2.gain.setValueAtTime(0.15, now);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + duration * 0.6);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now);
    osc2.stop(now + duration);

    // Third harmonic for richness
    const osc3 = ctx.createOscillator();
    const gain3 = ctx.createGain();
    osc3.type = 'sine';
    osc3.frequency.value = 2490;
    gain3.gain.setValueAtTime(0.08, now);
    gain3.gain.exponentialRampToValueAtTime(0.001, now + duration * 0.4);
    osc3.connect(gain3);
    gain3.connect(ctx.destination);
    osc3.start(now);
    osc3.stop(now + duration);
  } catch (err) {
    debug && console.log('[ext:timers] Bell playback failed:', err);
  }
};

// ===== Timer Data Operations =====

/**
 * Create a timer item in the datastore
 * @param {object} opts - Timer options
 * @returns {object|null} Created item or null
 */
const createTimerItem = async (opts) => {
  const metadata = {
    timerType: opts.timerType,
    duration: opts.duration || 0,
    targetTime: opts.targetTime || 0,
    startedAt: Date.now(),
    stoppedAt: null,
    pausedAt: null,
    elapsed: 0,
    intervalCount: 0,
    status: 'running',
    notification: {
      type: 'system',
      sound: null
    }
  };

  const result = await api.datastore.addItem('timer', {
    content: '',
    title: opts.title || `${opts.timerType} timer`,
    metadata: JSON.stringify(metadata)
  });

  if (!result.success) {
    console.error('[ext:timers] Failed to create timer:', result.error);
    return null;
  }

  const item = {
    id: result.data.id,
    title: opts.title || `${opts.timerType} timer`,
    metadata
  };

  // Track in active timers
  activeTimers.set(item.id, item);

  debug && console.log('[ext:timers] Created timer:', item.id, metadata.timerType);
  return item;
};

/**
 * Update timer metadata in the datastore
 * @param {string} timerId - Timer item ID
 * @param {object} metadata - Updated metadata
 */
const updateTimerMetadata = async (timerId, metadata) => {
  try {
    await api.datastore.updateItem(timerId, {
      metadata: JSON.stringify(metadata)
    });
  } catch (err) {
    console.error('[ext:timers] Failed to update timer:', err);
  }
};

/**
 * Complete a timer: update status, fire notification, play bell
 * @param {object} timer - Timer object from activeTimers
 */
const completeTimer = async (timer) => {
  timer.metadata.status = 'completed';
  timer.metadata.stoppedAt = Date.now();
  await updateTimerMetadata(timer.id, timer.metadata);

  // Remove from active tracking
  activeTimers.delete(timer.id);

  // Fire system notification
  try {
    new Notification(timer.title || 'Timer Complete', {
      body: formatTimerStatus(timer.metadata)
    });
  } catch (err) {
    debug && console.log('[ext:timers] Notification failed:', err);
  }

  // Play bell sound
  playBell();

  // Publish completion event
  api.pubsub.publish('timer:completed', {
    id: timer.id,
    title: timer.title,
    timerType: timer.metadata.timerType
  }, api.scopes.GLOBAL);

  debug && console.log('[ext:timers] Timer completed:', timer.id);
};

/**
 * Fire an interval notification (does not complete the timer)
 * @param {object} timer - Timer object
 */
const fireIntervalNotification = (timer) => {
  timer.metadata.intervalCount++;

  try {
    new Notification(timer.title || 'Interval Timer', {
      body: `Interval #${timer.metadata.intervalCount} completed`
    });
  } catch (err) {
    debug && console.log('[ext:timers] Interval notification failed:', err);
  }

  playBell();

  api.pubsub.publish('timer:interval', {
    id: timer.id,
    title: timer.title,
    count: timer.metadata.intervalCount
  }, api.scopes.GLOBAL);
};

// ===== Tick Loop =====

/**
 * Process one tick for all active timers.
 * Called every 1 second by the tick interval.
 */
const tick = () => {
  const now = Date.now();
  const tickData = [];

  for (const [timerId, timer] of activeTimers) {
    const meta = timer.metadata;
    if (meta.status !== 'running') continue;

    let display = '';
    let remaining = 0;

    switch (meta.timerType) {
      case 'countdown': {
        const elapsed = now - meta.startedAt;
        remaining = meta.duration - elapsed;
        if (remaining <= 0) {
          completeTimer(timer);
          continue;
        }
        display = formatDuration(remaining);
        break;
      }

      case 'alarm': {
        remaining = meta.targetTime - now;
        if (remaining <= 0) {
          completeTimer(timer);
          continue;
        }
        display = formatDuration(remaining);
        break;
      }

      case 'stopwatch': {
        const elapsed = meta.elapsed + (now - meta.startedAt);
        display = formatDuration(elapsed);
        break;
      }

      case 'interval': {
        const totalElapsed = now - meta.startedAt;
        const expectedIntervals = Math.floor(totalElapsed / meta.duration);
        // Fire notification for any new intervals
        while (meta.intervalCount < expectedIntervals) {
          fireIntervalNotification(timer);
          // Update metadata in datastore (fire-and-forget)
          updateTimerMetadata(timerId, meta);
        }
        const inCycle = totalElapsed % meta.duration;
        remaining = meta.duration - inCycle;
        display = formatDuration(remaining);
        break;
      }
    }

    tickData.push({
      id: timerId,
      title: timer.title,
      timerType: meta.timerType,
      status: meta.status,
      display,
      remaining,
      intervalCount: meta.intervalCount || 0
    });
  }

  // Publish tick for UI updates
  if (tickData.length > 0) {
    api.pubsub.publish('timer:tick', { timers: tickData }, api.scopes.GLOBAL);
  }

  // Update HUD with active timer summary
  updateHud(tickData);
};

/**
 * Start the tick loop if not already running
 */
const startTickLoop = () => {
  if (tickInterval) return;
  tickInterval = setInterval(tick, 1000);
  debug && console.log('[ext:timers] Tick loop started');
};

/**
 * Stop the tick loop if no active timers remain
 */
const stopTickLoopIfEmpty = () => {
  if (activeTimers.size === 0 && tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
    debug && console.log('[ext:timers] Tick loop stopped (no active timers)');
    // Clear HUD
    updateHud([]);
  }
};

// ===== HUD Integration =====

/**
 * Publish active timer info for HUD display
 * @param {Array} tickData - Array of active timer tick info
 */
const updateHud = (tickData) => {
  const running = tickData.filter(t => t.status === 'running');
  if (running.length === 0) {
    api.pubsub.publish('timer:hud-update', { text: '' }, api.scopes.GLOBAL);
    return;
  }

  const displays = running.slice(0, 3).map(t => t.display);
  const count = running.length;
  const text = count === 1
    ? `${running[0].display}`
    : `${count} timers: ${displays.join(', ')}`;
  api.pubsub.publish('timer:hud-update', { text, count }, api.scopes.GLOBAL);
};

// ===== Restore Running Timers =====

/**
 * Restore all running timers from the datastore on startup
 */
const restoreTimers = async () => {
  try {
    const result = await api.datastore.queryItems({ type: 'timer' });
    if (!result.success) return;

    let restoredCount = 0;
    for (const item of result.data) {
      let meta;
      try {
        meta = typeof item.metadata === 'string' ? JSON.parse(item.metadata) : item.metadata;
      } catch {
        continue;
      }

      if (!meta || (meta.status !== 'running' && meta.status !== 'paused')) continue;

      // For running countdown/alarm timers, check if they should have completed while offline
      if (meta.status === 'running') {
        const now = Date.now();
        if (meta.timerType === 'countdown') {
          const elapsed = now - meta.startedAt;
          if (elapsed >= meta.duration) {
            // Completed while extension was unloaded
            meta.status = 'completed';
            meta.stoppedAt = meta.startedAt + meta.duration;
            await updateTimerMetadata(item.id, meta);
            continue;
          }
        } else if (meta.timerType === 'alarm') {
          if (now >= meta.targetTime) {
            meta.status = 'completed';
            meta.stoppedAt = meta.targetTime;
            await updateTimerMetadata(item.id, meta);
            continue;
          }
        }
      }

      activeTimers.set(item.id, {
        id: item.id,
        title: item.title,
        metadata: meta
      });
      restoredCount++;
    }

    if (restoredCount > 0) {
      startTickLoop();
      debug && console.log(`[ext:timers] Restored ${restoredCount} active timer(s)`);
    }
  } catch (err) {
    console.error('[ext:timers] Failed to restore timers:', err);
  }
};

// ===== Window Management =====

let isOpeningTimers = false;
const openTimersWindow = async () => {
  if (isOpeningTimers) return;
  isOpeningTimers = true;
  try {
    const params = {
      role: 'workspace',
      key: address,
      height: 600,
      width: 700,
      trackingSource: 'cmd',
      trackingSourceId: 'timers'
    };

    await api.window.open(address, params);
  } catch (error) {
    console.error('[ext:timers] Failed to open timers window:', error);
  } finally {
    isOpeningTimers = false;
  }
};

// ===== Command Handlers =====

/**
 * Handle the "timers" command — open timers UI
 */
const handleTimers = async () => {
  openTimersWindow();
};

/**
 * Handle the "timer countdown <duration>" command
 */
const handleCountdown = async (args) => {
  const parts = (args || '').trim().split(/\s+/);
  // Check for optional name after duration using "as" or final quoted string
  let durationStr = '';
  let name = '';

  // Find where the duration ends and name begins
  // Simple heuristic: first part that looks like a duration gets consumed
  for (let i = 0; i < parts.length; i++) {
    if (!durationStr && parseDuration(parts[i]) !== null) {
      durationStr = parts[i];
    } else if (durationStr) {
      name = parts.slice(i).join(' ');
      break;
    } else {
      // Could be a duration part, try accumulating
      durationStr = parts.slice(0, i + 1).join('');
      if (parseDuration(durationStr) === null) {
        // Not a duration, might be name
        name = parts.slice(i).join(' ');
        durationStr = parts.slice(0, i).join('');
        break;
      }
    }
  }

  if (!durationStr) durationStr = args;

  const duration = parseDuration(durationStr);
  if (!duration) {
    return { output: `Invalid duration: "${args}". Try: 30m, 1h, 5m30s, 90s`, mimeType: 'text/plain' };
  }

  const title = name || `Countdown ${formatDuration(duration)}`;
  const timer = await createTimerItem({
    timerType: 'countdown',
    duration,
    title
  });

  if (!timer) {
    return { output: 'Failed to create timer', mimeType: 'text/plain' };
  }

  startTickLoop();
  return { output: `Started countdown: ${formatDuration(duration)}`, mimeType: 'text/plain' };
};

/**
 * Handle the "timer alarm <time>" command
 */
const handleAlarm = async (args) => {
  const parts = (args || '').trim().split(/\s+/);
  const timeStr = parts[0];
  const name = parts.slice(1).join(' ');

  const targetTime = parseTime(timeStr);
  if (!targetTime) {
    return { output: `Invalid time: "${timeStr}". Try: 6pm, 14:30, 6:30pm`, mimeType: 'text/plain' };
  }

  const targetDate = new Date(targetTime);
  const timeDisplay = targetDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const title = name || `Alarm ${timeDisplay}`;

  const timer = await createTimerItem({
    timerType: 'alarm',
    targetTime,
    title
  });

  if (!timer) {
    return { output: 'Failed to create alarm', mimeType: 'text/plain' };
  }

  startTickLoop();
  return { output: `Alarm set for ${timeDisplay}`, mimeType: 'text/plain' };
};

/**
 * Handle the "timer stopwatch [name]" command
 */
const handleStopwatch = async (args) => {
  const name = (args || '').trim();
  const title = name || 'Stopwatch';

  const timer = await createTimerItem({
    timerType: 'stopwatch',
    title
  });

  if (!timer) {
    return { output: 'Failed to create stopwatch', mimeType: 'text/plain' };
  }

  startTickLoop();
  return { output: `Stopwatch started: ${title}`, mimeType: 'text/plain' };
};

/**
 * Handle the "timer interval <duration>" command
 */
const handleInterval = async (args) => {
  const parts = (args || '').trim().split(/\s+/);
  let durationStr = parts[0];
  const name = parts.slice(1).join(' ');

  const duration = parseDuration(durationStr);
  if (!duration) {
    return { output: `Invalid duration: "${durationStr}". Try: 30m, 1h, 5m30s`, mimeType: 'text/plain' };
  }

  const title = name || `Interval ${formatDuration(duration)}`;
  const timer = await createTimerItem({
    timerType: 'interval',
    duration,
    title
  });

  if (!timer) {
    return { output: 'Failed to create interval timer', mimeType: 'text/plain' };
  }

  startTickLoop();
  return { output: `Interval timer started: every ${formatDuration(duration)}`, mimeType: 'text/plain' };
};

// ===== Timer Control (via pubsub for UI) =====

const setupPubsubHandlers = () => {
  // Pause a timer
  api.pubsub.subscribe('timer:pause', async (msg) => {
    const timer = activeTimers.get(msg.id);
    if (!timer || timer.metadata.status !== 'running') return;

    const now = Date.now();
    timer.metadata.status = 'paused';
    timer.metadata.pausedAt = now;

    // For stopwatch, accumulate elapsed
    if (timer.metadata.timerType === 'stopwatch') {
      timer.metadata.elapsed += (now - timer.metadata.startedAt);
    }

    await updateTimerMetadata(timer.id, timer.metadata);
    api.pubsub.publish('timer:state-changed', { id: timer.id, status: 'paused' }, api.scopes.GLOBAL);
    debug && console.log('[ext:timers] Paused timer:', timer.id);
  }, api.scopes.GLOBAL);

  // Resume a timer
  api.pubsub.subscribe('timer:resume', async (msg) => {
    const timer = activeTimers.get(msg.id);
    if (!timer || timer.metadata.status !== 'paused') return;

    const now = Date.now();
    timer.metadata.status = 'running';

    if (timer.metadata.timerType === 'stopwatch') {
      // Reset startedAt for new running period
      timer.metadata.startedAt = now;
    } else if (timer.metadata.timerType === 'countdown') {
      // Adjust startedAt to account for paused time
      const pausedDuration = now - timer.metadata.pausedAt;
      timer.metadata.startedAt += pausedDuration;
    } else if (timer.metadata.timerType === 'alarm') {
      // Adjust targetTime by paused duration
      const pausedDuration = now - timer.metadata.pausedAt;
      timer.metadata.targetTime += pausedDuration;
    } else if (timer.metadata.timerType === 'interval') {
      const pausedDuration = now - timer.metadata.pausedAt;
      timer.metadata.startedAt += pausedDuration;
    }

    timer.metadata.pausedAt = null;
    await updateTimerMetadata(timer.id, timer.metadata);
    startTickLoop();
    api.pubsub.publish('timer:state-changed', { id: timer.id, status: 'running' }, api.scopes.GLOBAL);
    debug && console.log('[ext:timers] Resumed timer:', timer.id);
  }, api.scopes.GLOBAL);

  // Stop a timer
  api.pubsub.subscribe('timer:stop', async (msg) => {
    const timer = activeTimers.get(msg.id);
    if (!timer) return;

    timer.metadata.status = 'stopped';
    timer.metadata.stoppedAt = Date.now();

    if (timer.metadata.timerType === 'stopwatch' && timer.metadata.status !== 'paused') {
      timer.metadata.elapsed += (Date.now() - timer.metadata.startedAt);
    }

    await updateTimerMetadata(timer.id, timer.metadata);
    activeTimers.delete(timer.id);
    stopTickLoopIfEmpty();
    api.pubsub.publish('timer:state-changed', { id: timer.id, status: 'stopped' }, api.scopes.GLOBAL);
    debug && console.log('[ext:timers] Stopped timer:', timer.id);
  }, api.scopes.GLOBAL);

  // Delete a timer
  api.pubsub.subscribe('timer:delete', async (msg) => {
    activeTimers.delete(msg.id);
    stopTickLoopIfEmpty();
    try {
      await api.datastore.deleteItem(msg.id);
    } catch (err) {
      console.error('[ext:timers] Failed to delete timer:', err);
    }
    api.pubsub.publish('timer:state-changed', { id: msg.id, status: 'deleted' }, api.scopes.GLOBAL);
    debug && console.log('[ext:timers] Deleted timer:', msg.id);
  }, api.scopes.GLOBAL);

  // Request current timer state (UI requests on load)
  api.pubsub.subscribe('timer:request-state', async () => {
    const timers = [];
    try {
      const result = await api.datastore.queryItems({ type: 'timer' });
      if (result.success) {
        for (const item of result.data) {
          let meta;
          try {
            meta = typeof item.metadata === 'string' ? JSON.parse(item.metadata) : item.metadata;
          } catch {
            continue;
          }
          timers.push({
            id: item.id,
            title: item.title,
            metadata: meta
          });
        }
      }
    } catch (err) {
      console.error('[ext:timers] Failed to query timers:', err);
    }
    api.pubsub.publish('timer:state-response', { timers }, api.scopes.GLOBAL);
  }, api.scopes.GLOBAL);
};

// ===== Registration =====

const init = async () => {
  debug && console.log('[ext:timers] init');

  // Register command handlers
  api.commands.register({
    name: 'timers',
    description: 'View all timers',
    execute: async () => { handleTimers(); }
  });

  // Register subcommands via pubsub (for cmd panel with params)
  api.pubsub.subscribe('cmd:execute:timer countdown', async (msg) => {
    const result = await handleCountdown(msg.search?.trim());
    if (msg.expectResult && msg.resultTopic) {
      api.pubsub.publish(msg.resultTopic, result || { success: true }, api.scopes.GLOBAL);
    }
  }, api.scopes.GLOBAL);
  api.pubsub.publish('cmd:register', {
    name: 'timer countdown',
    description: 'Start a countdown timer (e.g., 30m, 1h, 5m30s)',
    source: 'timers',
    scope: 'global',
    accepts: [],
    produces: [],
    params: [{ name: 'duration', type: 'string', required: true, description: 'Duration (e.g., 30m, 1h, 5m30s, 90s)' }]
  }, api.scopes.GLOBAL);

  api.pubsub.subscribe('cmd:execute:timer alarm', async (msg) => {
    const result = await handleAlarm(msg.search?.trim());
    if (msg.expectResult && msg.resultTopic) {
      api.pubsub.publish(msg.resultTopic, result || { success: true }, api.scopes.GLOBAL);
    }
  }, api.scopes.GLOBAL);
  api.pubsub.publish('cmd:register', {
    name: 'timer alarm',
    description: 'Set an alarm for a specific time (e.g., 6pm, 14:30)',
    source: 'timers',
    scope: 'global',
    accepts: [],
    produces: [],
    params: [{ name: 'time', type: 'string', required: true, description: 'Time (e.g., 6pm, 14:30, 6:30pm)' }]
  }, api.scopes.GLOBAL);

  api.pubsub.subscribe('cmd:execute:timer stopwatch', async (msg) => {
    const result = await handleStopwatch(msg.search?.trim());
    if (msg.expectResult && msg.resultTopic) {
      api.pubsub.publish(msg.resultTopic, result || { success: true }, api.scopes.GLOBAL);
    }
  }, api.scopes.GLOBAL);
  api.pubsub.publish('cmd:register', {
    name: 'timer stopwatch',
    description: 'Start a stopwatch that counts up',
    source: 'timers',
    scope: 'global',
    accepts: [],
    produces: [],
    params: [{ name: 'name', type: 'string', required: false, description: 'Optional name for the stopwatch' }]
  }, api.scopes.GLOBAL);

  api.pubsub.subscribe('cmd:execute:timer interval', async (msg) => {
    const result = await handleInterval(msg.search?.trim());
    if (msg.expectResult && msg.resultTopic) {
      api.pubsub.publish(msg.resultTopic, result || { success: true }, api.scopes.GLOBAL);
    }
  }, api.scopes.GLOBAL);
  api.pubsub.publish('cmd:register', {
    name: 'timer interval',
    description: 'Start a repeating interval timer',
    source: 'timers',
    scope: 'global',
    accepts: [],
    produces: [],
    params: [{ name: 'duration', type: 'string', required: true, description: 'Interval duration (e.g., 25m, 1h)' }]
  }, api.scopes.GLOBAL);

  // Set up pubsub handlers for timer control
  setupPubsubHandlers();

  // Restore running timers from datastore
  await restoreTimers();
};

const uninit = () => {
  debug && console.log('[ext:timers] uninit');
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
  // Unregister standalone commands
  for (const name of ['timer countdown', 'timer alarm', 'timer stopwatch', 'timer interval']) {
    api.pubsub.publish('cmd:unregister', { name }, api.scopes.GLOBAL);
  }
};

export default {
  defaults,
  id,
  init,
  uninit,
  labels,
  schemas,
  storageKeys
};
