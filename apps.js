/**
 * =============================================================
 * AURAFOCUS — app.js
 * =============================================================
 */

'use strict';

/* =============================================================
   CONSTANTS & CONFIGURATION
   ============================================================= */

const CONFIG = {
  // Default timer durations in seconds
  durations: {
    work:  25 * 60,
    short:  5 * 60,
    long:  15 * 60,
  },
  // How many work sessions before a long break
  sessionsBeforeLong: 4,
  // Daily and weekly goals
  dailyGoal: 4,
  weeklyGoal: 20,
  hoursGoal: 10,
  // localStorage key
  storageKey: 'aurafocus_v2',
  // SVG ring circumference (2π × r = 2π × 106 ≈ 666.15)
  ringCircumference: 2 * Math.PI * 106,
};

/* =============================================================
   APPLICATION STATE
   Single source of truth — all state lives here
   ============================================================= */

let STATE = {
  // User
  userName: '',
  memberSince: null,

  // Timer
  mode: 'work',             // 'work' | 'short' | 'long'
  timeLeft: CONFIG.durations.work,
  totalTime: CONFIG.durations.work,
  isRunning: false,
  sessionsDone: 0,          // total all-time
  currentSessionPos: 0,     // position within 4-session cycle (0–3)

  // Selected quick-time (minutes) for work mode
  selectedMinutes: 25,

  // Stats (weekly, reset each Monday)
  weeklySessionCount: 0,
  weeklyFocusSeconds: 0,
  weeklyDayData: [0, 0, 0, 0, 0, 0, 0], // Mon–Sun (minutes)
  streak: 0,
  lastSessionDate: null,
  weekStartDate: null,       // ISO date string of most recent Monday

  // Today
  todaySessions: 0,
  todayFocusSeconds: 0,

  // Audio
  activeSound: 'rain',
  volume: 60,
  soundEnabled: false,

  // UI
  currentView: 'home',
};

/* =============================================================
   INTERVAL REFERENCES
   Kept module-level so they can be cleared reliably
   ============================================================= */
let timerInterval  = null;   // setInterval for countdown
let audioCtx       = null;   // Web Audio API context
let audioNodes     = {};     // active audio source nodes
let volumeFadeRAF  = null;   // requestAnimationFrame for volume fade

/* =============================================================
   initApp()
   Entry point — called on DOMContentLoaded
   ============================================================= */
function initApp() {
  loadState();
  checkWeeklyReset();

  // Determine whether to show login or app
  if (STATE.userName) {
    showApp();
  } else {
    // Listen for Enter key on login input
    const input = document.getElementById('login-name-input');
    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submitLogin();
      });
    }
  }

  // Keyboard shortcuts (non-blocking — uses keydown)
  document.addEventListener('keydown', handleKeyDown);

  // Init audio context lazily on first user gesture
  // (browsers block audio without user interaction)
  document.addEventListener('click', initAudioContext, { once: true });
}

/* =============================================================
   LOGIN
   ============================================================= */

/**
 * submitLogin()
 * Reads name input, saves user, reveals app shell.
 */
function submitLogin() {
  const input = document.getElementById('login-name-input');
  const name = (input?.value || '').trim();
  if (!name) {
    // Shake the input — CSS-only micro-interaction
    input?.classList.add('shake');
    setTimeout(() => input?.classList.remove('shake'), 400);
    return;
  }

  STATE.userName    = name;
  STATE.memberSince = new Date().toISOString();
  saveState();
  showApp();
}

/**
 * showApp()
 * Hides login overlay, reveals app shell, populates user info.
 */
function showApp() {
  const overlay  = document.getElementById('login-overlay');
  const appShell = document.getElementById('app-shell');

  if (overlay)  overlay.style.display = 'none';
  if (appShell) appShell.classList.remove('hidden');

  populateUserInfo();
  updateStats();
  renderWeekBars();
  renderSessionDots();
  updateTimerDisplay();
  updateHeroStats();
}

/**
 * populateUserInfo()
 * Fills in name, avatar initial, member-since date.
 */
function populateUserInfo() {
  const initial = STATE.userName.charAt(0).toUpperCase();
  const since   = STATE.memberSince
    ? new Date(STATE.memberSince).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    : 'Today';

  setTextById('header-avatar',    initial);
  setTextById('header-username',  STATE.userName);
  setTextById('profile-avatar',   initial);
  setTextById('profile-name',     STATE.userName);
  setTextById('profile-since',    `Member since ${since}`);

  // Session badge
  const total = STATE.weeklySessionCount;
  setTextById('profile-badge-text', `${total} session${total !== 1 ? 's' : ''} this week`);
}

/* =============================================================
   handleViewSwitch()
   SPA view switching — no page reload, smooth animation
   ============================================================= */

/**
 * handleViewSwitch(viewName)
 * @param {string} viewName - 'home' | 'pomodoro' | 'analytics'
 */
function handleViewSwitch(viewName) {
  if (STATE.currentView === viewName) return;

  // Deactivate all views
  document.querySelectorAll('.view').forEach(v => {
    v.classList.remove('active');
  });

  // Deactivate nav buttons
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === viewName);
  });

  // Activate new view
  const target = document.getElementById(`view-${viewName}`);
  if (target) {
    // Force reflow to restart animation
    target.classList.remove('active');
    void target.offsetWidth;
    target.classList.add('active');
  }

  STATE.currentView = viewName;

  // Refresh analytics when switching to it
  if (viewName === 'analytics') {
    updateStats();
    renderWeekBars();
  }

  // Update hero stats when switching to home
  if (viewName === 'home') {
    updateHeroStats();
  }

  // Close mobile menu if open
  closeMobileMenu();
}

/**
 * toggleMobileMenu()
 * Mobile hamburger menu toggle.
 */
function toggleMobileMenu() {
  const nav = document.querySelector('.header-nav');
  if (nav) nav.classList.toggle('open');
}

function closeMobileMenu() {
  const nav = document.querySelector('.header-nav');
  if (nav) nav.classList.remove('open');
}

/* =============================================================
   TIMER SYSTEM
   ============================================================= */

/**
 * updateTimer()
 * Core tick — called every 1000ms.
 * Updates timeLeft, triggers session end when 0.
 */
function updateTimer() {
  if (!STATE.isRunning) return;

  STATE.timeLeft--;

  // Efficient DOM update — only update display, not full re-render
  updateTimerDisplay();
  updateRingProgress();

  if (STATE.timeLeft <= 0) {
    handleSessionComplete();
  }

  // Persist state every 10 seconds (not every tick — perf optimization)
  if (STATE.timeLeft % 10 === 0) {
    saveState();
  }
}

/**
 * toggleTimer()
 * Start or pause the timer.
 */
function toggleTimer() {
  if (STATE.isRunning) {
    pauseTimer();
  } else {
    startTimer();
  }
}

/**
 * startTimer()
 * Begins countdown. Uses setInterval (1s precision).
 */
function startTimer() {
  if (timerInterval) return;

  STATE.isRunning = true;
  timerInterval = setInterval(updateTimer, 1000);

  // Update play button to show pause icon
  setPlayPauseIcon('pause');

  // Mark ring wrap as running (triggers CSS pulse animation)
  document.getElementById('timer-ring-wrap')?.classList.add('running');

  // Start sound if enabled
  if (STATE.soundEnabled) {
    playSound(STATE.activeSound);
  }

  saveState();
}

/**
 * pauseTimer()
 * Pauses countdown without resetting.
 */
function pauseTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
  STATE.isRunning = false;

  setPlayPauseIcon('play');
  document.getElementById('timer-ring-wrap')?.classList.remove('running');

  // Fade out sound
  if (STATE.soundEnabled) {
    fadeOutSound();
  }

  saveState();
}

/**
 * resetTimer()
 * Stops timer and resets to full duration for current mode.
 */
function resetTimer() {
  pauseTimer();

  STATE.timeLeft  = STATE.totalTime;

  updateTimerDisplay();
  updateRingProgress();
  saveState();
}

/**
 * skipSession()
 * Advances to next session without recording completion.
 */
function skipSession() {
  pauseTimer();
  advanceToNextMode();
}

/**
 * handleSessionComplete()
 * Called when timer reaches 0. Records session, advances mode.
 */
function handleSessionComplete() {
  pauseTimer();

  const wasWork = STATE.mode === 'work';

  if (wasWork) {
    recordFocusSession();
  }

  // Brief pause, then advance
  setTimeout(() => {
    advanceToNextMode();
  }, 800);
}

/**
 * recordFocusSession()
 * Logs completed work session into stats.
 */
function recordFocusSession() {
  const minutesFocused = Math.floor(STATE.totalTime / 60);
  const secondsFocused = STATE.totalTime;

  // Session counts
  STATE.sessionsDone++;
  STATE.weeklySessionCount++;
  STATE.todaySessions++;

  // Time tracking
  STATE.weeklyFocusSeconds += secondsFocused;
  STATE.todayFocusSeconds  += secondsFocused;

  // Daily chart bar (today = current day of week, Mon=0)
  const dayIdx = getTodayIndex();
  STATE.weeklyDayData[dayIdx] = (STATE.weeklyDayData[dayIdx] || 0) + minutesFocused;

  // Streak logic
  updateStreak();

  // Update UI
  setTextById('today-sessions', STATE.todaySessions);
  setTextById('today-time', formatMinutes(Math.floor(STATE.todayFocusSeconds / 60)));

  updateHeroStats();
  saveState();
}

/**
 * advanceToNextMode()
 * Determines and sets the next timer mode (work/short/long).
 */
function advanceToNextMode() {
  if (STATE.mode === 'work') {
    STATE.currentSessionPos++;

    if (STATE.currentSessionPos >= CONFIG.sessionsBeforeLong) {
      STATE.currentSessionPos = 0;
      setTimerMode('long');
    } else {
      setTimerMode('short');
    }
  } else {
    // After any break, go back to work
    setTimerMode('work');
  }
}

/**
 * setMode(mode, btn)
 * Public — called by UI tabs.
 * @param {string} mode
 * @param {HTMLElement} btn
 */
function setMode(mode, btn) {
  pauseTimer();
  setTimerMode(mode);

  // Update tab active state
  document.querySelectorAll('.mode-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.mode === mode);
    t.setAttribute('aria-selected', t.dataset.mode === mode ? 'true' : 'false');
  });
}

/**
 * setTimerMode(mode)
 * Internal — sets mode, updates duration, resets timer display.
 * @param {string} mode - 'work' | 'short' | 'long'
 */
function setTimerMode(mode) {
  STATE.mode = mode;

  // For work mode, use selected quick-time; breaks use config
  if (mode === 'work') {
    STATE.totalTime = STATE.selectedMinutes * 60;
  } else {
    STATE.totalTime = CONFIG.durations[mode];
  }

  STATE.timeLeft = STATE.totalTime;

  // Update ring color for break modes
  const ring = document.getElementById('ring-progress');
  if (ring) {
    ring.className = 'ring-progress';
    if (mode === 'short') ring.classList.add('break-short');
    if (mode === 'long')  ring.classList.add('break-long');
  }

  // Update mode label under timer
  const labels = { work: 'Focus', short: 'Short Break', long: 'Long Break' };
  setTextById('timer-mode-label', labels[mode] || '');
  setTextById('today-mode-val', labels[mode] || '');

  // Update session dots
  renderSessionDots();

  updateTimerDisplay();
  updateRingProgress();

  // Sync active mode tab
  document.querySelectorAll('.mode-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.mode === mode);
  });
}

/**
 * setQuickTime(minutes, btn)
 * Sets work duration from quick-select buttons.
 * @param {number} minutes
 * @param {HTMLElement} btn
 */
function setQuickTime(minutes, btn) {
  STATE.selectedMinutes = minutes;

  // Clear active state from all quick buttons
  document.querySelectorAll('.qt-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');

  // Clear custom input
  const customInput = document.getElementById('custom-min-input');
  if (customInput) customInput.value = '';

  // Apply only if we're in work mode
  if (STATE.mode === 'work') {
    pauseTimer();
    STATE.totalTime = minutes * 60;
    STATE.timeLeft  = STATE.totalTime;
    updateTimerDisplay();
    updateRingProgress();
  }

  saveState();
}

/**
 * setCustomTime(value)
 * Sets custom work duration from the text input.
 * @param {string} value
 */
function setCustomTime(value) {
  const mins = parseInt(value, 10);
  if (!mins || mins < 1 || mins > 120) return;

  STATE.selectedMinutes = mins;

  // Deactivate quick buttons
  document.querySelectorAll('.qt-btn').forEach(b => b.classList.remove('active'));

  if (STATE.mode === 'work') {
    pauseTimer();
    STATE.totalTime = mins * 60;
    STATE.timeLeft  = STATE.totalTime;
    updateTimerDisplay();
    updateRingProgress();
  }

  saveState();
}

/**
 * updateTimerDisplay()
 * Formats and sets the MM:SS timer readout.
 * Uses textContent (not innerHTML) — efficient DOM update.
 */
function updateTimerDisplay() {
  const m = Math.floor(STATE.timeLeft / 60);
  const s = STATE.timeLeft % 60;
  const formatted = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;

  const el = document.getElementById('timer-display');
  if (el && el.textContent !== formatted) {
    el.textContent = formatted;
  }

  // Update page title for tab awareness
  document.title = STATE.isRunning ? `${formatted} — AuraFocus` : 'AuraFocus — Deep Work, Redefined.';
}

/**
 * updateRingProgress()
 * Calculates SVG stroke-dashoffset for the progress ring.
 * GPU-accelerated: only changes stroke-dashoffset (composited).
 */
function updateRingProgress() {
  const ring = document.getElementById('ring-progress');
  if (!ring) return;

  const progress = STATE.totalTime > 0
    ? (STATE.totalTime - STATE.timeLeft) / STATE.totalTime
    : 0;

  const offset = CONFIG.ringCircumference * (1 - progress);
  ring.style.strokeDashoffset = offset;
}

/**
 * renderSessionDots()
 * Renders 4 session position dots.
 */
function renderSessionDots() {
  const container = document.getElementById('session-dots');
  if (!container) return;

  let html = '';
  for (let i = 0; i < CONFIG.sessionsBeforeLong; i++) {
    let cls = 'session-dot';
    if (i < STATE.currentSessionPos) cls += ' done';
    else if (i === STATE.currentSessionPos && STATE.mode === 'work') cls += ' current';
    html += `<div class="${cls}" aria-hidden="true"></div>`;
  }
  container.innerHTML = html;

  // Update text label
  const pos = Math.min(STATE.currentSessionPos + 1, CONFIG.sessionsBeforeLong);
  setTextById('session-label', `Session ${pos} of ${CONFIG.sessionsBeforeLong}`);
}

/**
 * setPlayPauseIcon(state)
 * Swaps between play and pause SVG icons.
 * @param {'play'|'pause'} state
 */
function setPlayPauseIcon(state) {
  const btn       = document.getElementById('play-btn');
  const iconPlay  = btn?.querySelector('.icon-play');
  const iconPause = btn?.querySelector('.icon-pause');
  if (!btn) return;

  if (state === 'pause') {
    if (iconPlay)  iconPlay.style.display  = 'none';
    if (iconPause) iconPause.style.display = '';
    btn.classList.add('running');
    btn.setAttribute('aria-label', 'Pause');
  } else {
    if (iconPlay)  iconPlay.style.display  = '';
    if (iconPause) iconPause.style.display = 'none';
    btn.classList.remove('running');
    btn.setAttribute('aria-label', 'Start');
  }
}

/* =============================================================
   KEYBOARD SHORTCUTS
   ============================================================= */

/**
 * handleKeyDown(e)
 * Global keyboard handler — non-blocking event delegation.
 */
function handleKeyDown(e) {
  // Skip if typing in an input
  const tag = e.target.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea') return;

  switch (e.key.toLowerCase()) {
    case ' ':
      e.preventDefault();
      toggleTimer();
      break;
    case 'r':
      resetTimer();
      break;
    case 's':
      skipSession();
      break;
  }
}

/* =============================================================
   AUDIO SYSTEM
   =============================================================
   Implementation: Web Audio API with OscillatorNode for
   demo-quality ambient sounds. In production, swap the
   generateXxxSound() functions with <audio> src attributes.
   ============================================================= */

/**
 * initAudioContext()
 * Creates AudioContext on first user gesture (browser policy).
 * Called once via click listener in initApp().
 */
function initAudioContext() {
  if (audioCtx) return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  } catch (err) {
    console.warn('AudioContext not available:', err);
  }
}

/**
 * toggleMasterSound()
 * Enables or disables the sound system.
 */
function toggleMasterSound() {
  STATE.soundEnabled = !STATE.soundEnabled;

  const btn       = document.getElementById('sound-toggle-btn');
  const iconOn    = btn?.querySelector('.icon-vol-on');
  const iconOff   = btn?.querySelector('.icon-vol-off');

  if (STATE.soundEnabled) {
    if (iconOn)  iconOn.style.display  = '';
    if (iconOff) iconOff.style.display = 'none';
    if (STATE.isRunning) playSound(STATE.activeSound);
  } else {
    if (iconOn)  iconOn.style.display  = 'none';
    if (iconOff) iconOff.style.display = '';
    stopAllSounds();
  }

  saveState();
}

/**
 * selectSound(soundName, btn)
 * Switches active sound, plays it if timer is running.
 * @param {string} soundName - 'rain' | 'focus' | 'lofi'
 * @param {HTMLElement} btn
 */
function selectSound(soundName, btn) {
  STATE.activeSound = soundName;

  // Update active UI state
  document.querySelectorAll('.sound-row').forEach(b => {
    b.classList.toggle('active', b.dataset.sound === soundName);
  });

  // If sound is on and timer running, switch sound
  if (STATE.soundEnabled && STATE.isRunning) {
    stopAllSounds();
    playSound(soundName);
  }

  saveState();
}

/**
 * setVolume(value)
 * Updates master gain node and persists setting.
 * @param {string|number} value - 0 to 100
 */
function setVolume(value) {
  const vol = parseInt(value, 10);
  STATE.volume = vol;

  setTextById('volume-display', vol);

  // Apply to Web Audio gain node if active
  if (audioNodes.gainNode && audioCtx) {
    audioNodes.gainNode.gain.setTargetAtTime(
      vol / 100,
      audioCtx.currentTime,
      0.05  // time constant for smooth ramp
    );
  }

  saveState();
}

/**
 * manageAudio(action)
 * Main audio controller. Handles play/stop/fade.
 * @param {'play'|'stop'|'fadeIn'|'fadeOut'} action
 */
function manageAudio(action) {
  if (!audioCtx) return;

  switch (action) {
    case 'play':
      playSound(STATE.activeSound);
      break;
    case 'stop':
      stopAllSounds();
      break;
    case 'fadeIn':
      fadeInSound();
      break;
    case 'fadeOut':
      fadeOutSound();
      break;
  }
}

/**
 * playSound(type)
 * Creates Web Audio API graph for a specific sound type.
 * Uses oscillator + filter + gain nodes — no external files needed.
 * @param {string} type - 'rain' | 'focus' | 'lofi'
 */
function playSound(type) {
  if (!audioCtx) return;

  stopAllSounds();

  // Resume context if suspended (Chrome autoplay policy)
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }

  const gainNode = audioCtx.createGain();
  gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
  gainNode.gain.linearRampToValueAtTime(
    STATE.volume / 100,
    audioCtx.currentTime + 0.8  // smooth 800ms fade in
  );
  gainNode.connect(audioCtx.destination);

  audioNodes.gainNode = gainNode;

  // Build sound graph based on type
  switch (type) {
    case 'rain':
      buildRainSound(gainNode);
      break;
    case 'focus':
      buildFocusSound(gainNode);
      break;
    case 'lofi':
      buildLofiSound(gainNode);
      break;
  }
}

/**
 * buildRainSound(output)
 * White noise filtered to sound like steady rain.
 * @param {AudioNode} output
 */
function buildRainSound(output) {
  // White noise buffer
  const bufferSize = audioCtx.sampleRate * 2;
  const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = (Math.random() * 2 - 1) * 0.7;
  }

  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;

  // Low-pass filter: removes harsh highs → rain-like texture
  const filter = audioCtx.createBiquadFilter();
  filter.type      = 'lowpass';
  filter.frequency.value = 900;
  filter.Q.value   = 0.3;

  source.connect(filter);
  filter.connect(output);
  source.start(0);

  audioNodes.source = source;
  audioNodes.filter = filter;
}

/**
 * buildFocusSound(output)
 * 40Hz binaural-style beat layered with pink-ish noise.
 * @param {AudioNode} output
 */
function buildFocusSound(output) {
  // Base drone — low sine for depth
  const drone = audioCtx.createOscillator();
  drone.type = 'sine';
  drone.frequency.value = 40;

  // Second oscillator slightly detuned → beating effect
  const drone2 = audioCtx.createOscillator();
  drone2.type = 'sine';
  drone2.frequency.value = 80;

  const droneGain = audioCtx.createGain();
  droneGain.gain.value = 0.18;

  // Noise floor for texture
  const bufferSize = audioCtx.sampleRate;
  const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = (Math.random() * 2 - 1) * 0.12;
  }
  const noise = audioCtx.createBufferSource();
  noise.buffer = buffer;
  noise.loop = true;

  const noiseFilter = audioCtx.createBiquadFilter();
  noiseFilter.type = 'bandpass';
  noiseFilter.frequency.value = 500;
  noiseFilter.Q.value = 0.8;

  drone.connect(droneGain);
  drone2.connect(droneGain);
  droneGain.connect(output);

  noise.connect(noiseFilter);
  noiseFilter.connect(output);

  drone.start(0);
  drone2.start(0);
  noise.start(0);

  audioNodes.source  = noise;
  audioNodes.drone   = drone;
  audioNodes.drone2  = drone2;
}

/**
 * buildLofiSound(output)
 * Warm, slightly detuned oscillators to simulate lo-fi chord texture.
 * @param {AudioNode} output
 */
function buildLofiSound(output) {
  // C major chord — soft and warm
  const frequencies = [261.6, 329.6, 392.0, 523.3];
  audioNodes.oscillators = [];

  frequencies.forEach((freq, i) => {
    const osc = audioCtx.createOscillator();
    osc.type = 'triangle'; // triangle = soft, warm

    // Slight random detune for vintage feel
    const detune = (Math.random() - 0.5) * 12;
    osc.frequency.value   = freq;
    osc.detune.value      = detune;

    const oscGain = audioCtx.createGain();
    oscGain.gain.value = 0.08 + Math.random() * 0.04;

    osc.connect(oscGain);
    oscGain.connect(output);
    osc.start(0);

    audioNodes.oscillators.push(osc);
  });

  // Warm noise bed
  const bufferSize = audioCtx.sampleRate * 2;
  const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = (Math.random() * 2 - 1) * 0.06;
  }
  const vinyl = audioCtx.createBufferSource();
  vinyl.buffer = buffer;
  vinyl.loop   = true;

  const vinylFilter = audioCtx.createBiquadFilter();
  vinylFilter.type = 'highpass';
  vinylFilter.frequency.value = 8000;

  vinyl.connect(vinylFilter);
  vinylFilter.connect(output);
  vinyl.start(0);
  audioNodes.vinyl = vinyl;
}

/**
 * stopAllSounds()
 * Disconnects and stops all active audio nodes.
 */
function stopAllSounds() {
  const stop = (node) => {
    try { node?.stop?.(); node?.disconnect?.(); } catch (_) {}
  };

  stop(audioNodes.source);
  stop(audioNodes.drone);
  stop(audioNodes.drone2);
  stop(audioNodes.vinyl);
  audioNodes.oscillators?.forEach(stop);
  audioNodes.gainNode?.disconnect?.();
  audioNodes = {};
}

/**
 * fadeOutSound()
 * Smoothly ramps gain to 0 then stops nodes.
 * Uses exponentialRampToValueAtTime for natural fade.
 */
function fadeOutSound() {
  if (!audioNodes.gainNode || !audioCtx) return;

  audioNodes.gainNode.gain.setTargetAtTime(0, audioCtx.currentTime, 0.4);
  setTimeout(stopAllSounds, 1200); // stop after 1.2s fade
}

/**
 * fadeInSound()
 * Ramps gain from 0 to current volume.
 */
function fadeInSound() {
  if (!audioNodes.gainNode || !audioCtx) return;
  audioNodes.gainNode.gain.setTargetAtTime(
    STATE.volume / 100,
    audioCtx.currentTime,
    0.5
  );
}

/* =============================================================
   ANALYTICS / STATS
   ============================================================= */

/**
 * updateStats()
 * Refreshes all stat displays from STATE.
 * Called on view switch to analytics and after sessions.
 */
function updateStats() {
  const totalMins  = Math.floor(STATE.weeklyFocusSeconds / 60);
  const hours      = Math.floor(totalMins / 60);
  const mins       = totalMins % 60;
  const sessions   = STATE.weeklySessionCount;
  const avg        = sessions > 0
    ? Math.floor(STATE.weeklyFocusSeconds / sessions / 60)
    : 0;

  // Stats grid
  setTextById('an-hours',    `${hours}h ${mins}m`);
  setTextById('an-sessions', sessions);
  setTextById('an-streak',   STATE.streak);
  setTextById('an-avg',      `${avg}m`);

  // Profile badge
  setTextById('profile-badge-text', `${sessions} session${sessions !== 1 ? 's' : ''} this week`);

  // Progress bars
  const dailyPct  = Math.min(100, Math.round((STATE.todaySessions / CONFIG.dailyGoal) * 100));
  const weeklyPct = Math.min(100, Math.round((sessions / CONFIG.weeklyGoal) * 100));
  const hoursPct  = Math.min(100, Math.round((totalMins / 60 / CONFIG.hoursGoal) * 100));

  setProgressBar('pg-daily-bar',  dailyPct);
  setProgressBar('pg-weekly-bar', weeklyPct);
  setProgressBar('pg-hours-bar',  hoursPct);

  setTextById('pg-daily-val',  `${STATE.todaySessions} / ${CONFIG.dailyGoal} sessions`);
  setTextById('pg-weekly-val', `${sessions} / ${CONFIG.weeklyGoal} sessions`);
  setTextById('pg-hours-val',  `${hours} / ${CONFIG.hoursGoal} hours`);

  // Re-populate user info
  populateUserInfo();
}

/**
 * updateHeroStats()
 * Updates the three quick-stat numbers on the hero section.
 */
function updateHeroStats() {
  const totalMins = Math.floor(STATE.weeklyFocusSeconds / 60);
  const hours     = totalMins >= 60
    ? `${(totalMins / 60).toFixed(1)}h`
    : `${totalMins}m`;

  setTextById('hs-sessions', STATE.weeklySessionCount);
  setTextById('hs-hours',    hours);
  setTextById('hs-streak',   STATE.streak);
}

/**
 * renderWeekBars()
 * Builds the 7-bar weekly focus chart using CSS height %.
 * Max bar = tallest day = 100%.
 */
function renderWeekBars() {
  const barsContainer   = document.getElementById('week-bars');
  const labelsContainer = document.getElementById('week-labels');
  if (!barsContainer || !labelsContainer) return;

  const days    = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const todayIdx = getTodayIndex();
  const data    = STATE.weeklyDayData;
  const maxVal  = Math.max(...data, 1); // avoid div-by-zero

  let barsHTML  = '';
  let labelsHTML = '';

  days.forEach((day, i) => {
    const pct      = Math.round((data[i] / maxVal) * 100);
    const isToday  = i === todayIdx;
    const hasData  = data[i] > 0;

    const barClass = `week-bar${hasData ? ' has-data' : ''}${isToday ? ' today' : ''}`;

    barsHTML += `
      <div class="week-bar-wrap" title="${day}: ${data[i] || 0}m focused">
        <div class="${barClass}" style="height:${Math.max(pct, 3)}%" role="img"
          aria-label="${day}: ${data[i] || 0} minutes focused">
        </div>
      </div>`;

    labelsHTML += `
      <div class="week-label${isToday ? ' today' : ''}">${day}</div>`;
  });

  barsContainer.innerHTML   = barsHTML;
  labelsContainer.innerHTML = labelsHTML;
}

/**
 * confirmResetStats()
 * Confirms then wipes weekly stats.
 */
function confirmResetStats() {
  if (!confirm('Reset all weekly stats? This cannot be undone.')) return;

  STATE.weeklySessionCount  = 0;
  STATE.weeklyFocusSeconds  = 0;
  STATE.weeklyDayData       = [0, 0, 0, 0, 0, 0, 0];
  STATE.todaySessions       = 0;
  STATE.todayFocusSeconds   = 0;

  updateStats();
  renderWeekBars();
  saveState();
}

/* =============================================================
   STREAK & DATE LOGIC
   ============================================================= */

/**
 * updateStreak()
 * Increments or resets streak based on session date.
 */
function updateStreak() {
  const today = getTodayString();

  if (STATE.lastSessionDate === today) {
    // Already logged a session today — no change
    return;
  }

  const yesterday = getYesterdayString();

  if (STATE.lastSessionDate === yesterday || !STATE.lastSessionDate) {
    STATE.streak++;
  } else {
    // Gap in days — reset streak
    STATE.streak = 1;
  }

  STATE.lastSessionDate = today;
}

/**
 * checkWeeklyReset()
 * Auto-resets weekly stats every Monday.
 * Compares stored week start to current Monday.
 */
function checkWeeklyReset() {
  const currentMonday = getMostRecentMonday();

  if (STATE.weekStartDate !== currentMonday) {
    // It's a new week — reset weekly stats
    STATE.weeklySessionCount = 0;
    STATE.weeklyFocusSeconds = 0;
    STATE.weeklyDayData      = [0, 0, 0, 0, 0, 0, 0];
    STATE.weekStartDate      = currentMonday;
    saveState();
  }
}

/**
 * getMostRecentMonday()
 * Returns ISO date string (YYYY-MM-DD) of the most recent Monday.
 */
function getMostRecentMonday() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 1=Mon...
  const diff = (day === 0) ? 6 : day - 1;
  const monday = new Date(now);
  monday.setDate(now.getDate() - diff);
  return monday.toISOString().split('T')[0];
}

/**
 * getTodayIndex()
 * Returns 0 (Mon) through 6 (Sun) for today.
 */
function getTodayIndex() {
  const day = new Date().getDay(); // 0=Sun
  return day === 0 ? 6 : day - 1;
}

/**
 * getTodayString()
 * @returns {string} YYYY-MM-DD
 */
function getTodayString() {
  return new Date().toISOString().split('T')[0];
}

/**
 * getYesterdayString()
 * @returns {string} YYYY-MM-DD of yesterday
 */
function getYesterdayString() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

/* =============================================================
   STATE PERSISTENCE (localStorage)
   ============================================================= */

/**
 * saveState()
 * Serializes STATE to localStorage.
 * Non-blocking: only called periodically, not on every tick.
 */
function saveState() {
  try {
    const toSave = {
      userName:            STATE.userName,
      memberSince:         STATE.memberSince,
      mode:                STATE.mode,
      selectedMinutes:     STATE.selectedMinutes,
      sessionsDone:        STATE.sessionsDone,
      currentSessionPos:   STATE.currentSessionPos,
      weeklySessionCount:  STATE.weeklySessionCount,
      weeklyFocusSeconds:  STATE.weeklyFocusSeconds,
      weeklyDayData:       STATE.weeklyDayData,
      streak:              STATE.streak,
      lastSessionDate:     STATE.lastSessionDate,
      weekStartDate:       STATE.weekStartDate,
      todaySessions:       STATE.todaySessions,
      todayFocusSeconds:   STATE.todayFocusSeconds,
      activeSound:         STATE.activeSound,
      volume:              STATE.volume,
      soundEnabled:        STATE.soundEnabled,
      // Save timeLeft so refresh restores progress
      timeLeft:            STATE.timeLeft,
      totalTime:           STATE.totalTime,
      // Note: isRunning is NOT saved — timer pauses on refresh
    };

    localStorage.setItem(CONFIG.storageKey, JSON.stringify(toSave));
  } catch (err) {
    // localStorage full or unavailable — fail silently
    console.warn('AuraFocus: Could not save state.', err);
  }
}

/**
 * loadState()
 * Reads STATE from localStorage, merges into STATE object.
 * Validates expected types before applying.
 */
function loadState() {
  try {
    const raw = localStorage.getItem(CONFIG.storageKey);
    if (!raw) return;

    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== 'object') return;

    // Merge saved keys into STATE (only known keys)
    const allowedKeys = Object.keys(STATE);
    allowedKeys.forEach(key => {
      if (key in saved && saved[key] !== undefined) {
        STATE[key] = saved[key];
      }
    });

    // Restore volume slider UI
    const volSlider = document.getElementById('volume-slider');
    if (volSlider) volSlider.value = STATE.volume;
    setTextById('volume-display', STATE.volume);

    // Restore active sound UI
    document.querySelectorAll('.sound-row').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.sound === STATE.activeSound);
    });

    // Restore sound toggle icon
    if (!STATE.soundEnabled) {
      const btn    = document.getElementById('sound-toggle-btn');
      const iconOn = btn?.querySelector('.icon-vol-on');
      const iconOff = btn?.querySelector('.icon-vol-off');
      if (iconOn)  iconOn.style.display  = 'none';
      if (iconOff) iconOff.style.display = '';
    }

  } catch (err) {
    console.warn('AuraFocus: Could not load state.', err);
  }
}

/* =============================================================
   UTILITY HELPERS
   ============================================================= */

/**
 * setTextById(id, text)
 * Safe, efficient text update. No-op if content unchanged.
 */
function setTextById(id, text) {
  const el = document.getElementById(id);
  if (el && el.textContent !== String(text)) {
    el.textContent = text;
  }
}

/**
 * setProgressBar(id, pct)
 * Sets CSS width on a progress fill element.
 * @param {string} id
 * @param {number} pct - 0 to 100
 */
function setProgressBar(id, pct) {
  const el = document.getElementById(id);
  if (el) el.style.width = `${pct}%`;
}

/**
 * formatMinutes(totalMinutes)
 * Returns "Xh Ym" or "Xm" string.
 * @param {number} totalMinutes
 * @returns {string}
 */
function formatMinutes(totalMinutes) {
  if (totalMinutes >= 60) {
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    return `${h}h ${m}m`;
  }
  return `${totalMinutes}m`;
}

/* =============================================================
   BOOT
   ============================================================= */
document.addEventListener('DOMContentLoaded', initApp);
