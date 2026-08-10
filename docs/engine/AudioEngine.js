/**
 * engine/AudioEngine.js
 * ---------------------------------------------------------------------------
 * A lightweight SFX layer built entirely on the Web Audio API — no
 * preloaded audio assets, every sound is synthesized on the fly from short
 * oscillator/noise bursts. Keeps the game's asset footprint at zero while
 * still giving each key moment (click, purchase, strike, round bell,
 * victory) a distinct cue.
 *
 * Browser-safe by construction: every export is a no-op (never throws) in
 * any environment without a Web Audio API — Node's test runner included —
 * so this module can be imported and exercised anywhere the rest of the
 * codebase already is, mirroring core/SaveManager.js's own storage-adapter
 * fallback pattern for localStorage.
 *
 * AudioContext lifecycle: browsers refuse to start (or auto-suspend) an
 * AudioContext before a genuine user gesture. This module never creates one
 * at import time — the context is created lazily, on the first actual
 * play*() call, and every call opportunistically resumes it if suspended.
 * In practice that means the very first click anywhere in the app (which
 * is what triggers the FIRST sound via the UI's own click handler — see
 * web/app.js's el() helper) is what unlocks audio, satisfying the "activer
 * au premier clic utilisateur" requirement structurally rather than via a
 * separate unlock step the UI has to remember to call.
 * ---------------------------------------------------------------------------
 */

const STORAGE_KEY = 'mma_gym_manager.audio_muted';
const JUL_MODE_STORAGE_KEY = 'mma_gym_manager.audio_jul_mode';

/** ~95 BPM sixteenth-note step, 8 steps per looping bar — see AudioEngine#_scheduleJulBar. */
const JUL_STEP_SECONDS = 0.16;
const JUL_STEPS_PER_BAR = 8;

function createStorageAdapter() {
  try {
    if (typeof localStorage !== 'undefined') {
      return {
        getItem: (key) => localStorage.getItem(key),
        setItem: (key, value) => localStorage.setItem(key, value),
      };
    }
  } catch {
    // Privacy modes / sandboxed environments can throw just accessing localStorage.
  }
  const memory = new Map();
  return {
    getItem: (key) => (memory.has(key) ? memory.get(key) : null),
    setItem: (key, value) => memory.set(key, value),
  };
}

function getAudioContextClass() {
  if (typeof window === 'undefined') return null;
  return window.AudioContext ?? window.webkitAudioContext ?? null;
}

class AudioEngine {
  constructor({ storage = createStorageAdapter() } = {}) {
    this._storage = storage;
    this._ctx = null;
    this._muted = this._storage.getItem(STORAGE_KEY) === '1';
    this._julModeEnabled = this._storage.getItem(JUL_MODE_STORAGE_KEY) === '1';
    this._julTimerId = null;
  }

  /** @returns {boolean} True if sound is currently muted. */
  isMuted() {
    return this._muted;
  }

  /**
   * @param {boolean} muted
   */
  setMuted(muted) {
    this._muted = Boolean(muted);
    this._storage.setItem(STORAGE_KEY, this._muted ? '1' : '0');
    if (this._muted) this._stopJulLoop();
    else if (this._julModeEnabled) this._startJulLoop();
  }

  /** @returns {boolean} The new muted state. */
  toggleMuted() {
    this.setMuted(!this._muted);
    return this._muted;
  }

  // ---- "Musique Style Jul" ambiance loop ---------------------------------------

  /** @returns {boolean} True if the synthesized Marseille-rap-inspired ambiance loop is enabled. */
  isJulModeEnabled() {
    return this._julModeEnabled;
  }

  /**
   * Toggles the looping trap-hi-hat/808-bass ambiance (BALANCE-free — this
   * is presentation, not gameplay). Persists like the mute preference.
   * Starts/stops the actual loop immediately (unless currently muted, in
   * which case it stays silent until unmuted — see setMuted()).
   * @param {boolean} enabled
   */
  setJulModeEnabled(enabled) {
    this._julModeEnabled = Boolean(enabled);
    this._storage.setItem(JUL_MODE_STORAGE_KEY, this._julModeEnabled ? '1' : '0');
    if (this._julModeEnabled && !this._muted) this._startJulLoop();
    else this._stopJulLoop();
  }

  /** @returns {boolean} The new JUL-mode state. */
  toggleJulMode() {
    this.setJulModeEnabled(!this._julModeEnabled);
    return this._julModeEnabled;
  }

  // ---- named cues -------------------------------------------------------------

  /** Button/interface click — a short, quiet, high blip. */
  playClick() {
    this._withContext((ctx, t0) => {
      this._tone(ctx, { frequency: 900, start: t0, duration: 0.035, type: 'square', peakGain: 0.05 });
    });
  }

  /** Purchase / recruitment / purse received — a bright two-note "cha-ching". */
  playCash() {
    this._withContext((ctx, t0) => {
      this._tone(ctx, { frequency: 660, start: t0, duration: 0.09, type: 'triangle', peakGain: 0.12 });
      this._tone(ctx, { frequency: 990, start: t0 + 0.07, duration: 0.14, type: 'triangle', peakGain: 0.12 });
    });
  }

  /** Combat impact (Live Text Feed beat) — a short filtered noise thud. */
  playHit() {
    this._withContext((ctx, t0) => {
      this._noiseBurst(ctx, { start: t0, duration: 0.09, peakGain: 0.18, filterFrequency: 900 });
    });
  }

  /** Round start/end bell — a long, low, resonant double tone. */
  playGong() {
    this._withContext((ctx, t0) => {
      this._tone(ctx, { frequency: 220, start: t0, duration: 1.1, type: 'sine', peakGain: 0.16 });
      this._tone(ctx, { frequency: 110, start: t0, duration: 1.3, type: 'sine', peakGain: 0.12 });
    });
  }

  /** Fight won — a short ascending major-arpeggio fanfare. */
  playVictory() {
    this._withContext((ctx, t0) => {
      const notes = [523.25, 659.25, 783.99, 1046.5]; // C5, E5, G5, C6
      notes.forEach((frequency, index) => {
        this._tone(ctx, { frequency, start: t0 + index * 0.11, duration: 0.22, type: 'triangle', peakGain: 0.14 });
      });
    });
  }

  // ---- internals ------------------------------------------------------------

  /** Lazily creates (never at import time) and returns the shared AudioContext, or null if unavailable. */
  _getContext() {
    if (this._ctx) return this._ctx;
    const AudioContextClass = getAudioContextClass();
    if (!AudioContextClass) return null;
    try {
      this._ctx = new AudioContextClass();
    } catch {
      this._ctx = null;
    }
    return this._ctx;
  }

  /** Starts (or restarts) the looping JUL-mode ambiance. No-ops silently with no Web Audio API available. */
  _startJulLoop() {
    this._stopJulLoop();
    if (!this._getContext()) return;
    this._scheduleJulBar();
  }

  /** Stops the looping JUL-mode ambiance, if running. Already-scheduled notes simply finish playing out. */
  _stopJulLoop() {
    if (this._julTimerId !== null) {
      clearTimeout(this._julTimerId);
      this._julTimerId = null;
    }
  }

  /**
   * Schedules one 8-step "Marseille rap style" bar (808-ish kick, a low
   * bass stab, trap-adjacent hi-hat ticks, a snare-like noise burst on the
   * backbeats) then re-arms itself for the next bar — a simple generic
   * synthesized trap/rap ambiance, never a reproduction of any real song.
   */
  _scheduleJulBar() {
    if (this._muted || !this._julModeEnabled) return;
    const ctx = this._getContext();
    if (!ctx) return;

    try {
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const barStart = ctx.currentTime + 0.05;

      for (let step = 0; step < JUL_STEPS_PER_BAR; step += 1) {
        const t = barStart + step * JUL_STEP_SECONDS;

        if (step === 0 || step === 4) {
          this._tone(ctx, { frequency: 60, start: t, duration: 0.22, type: 'sine', peakGain: 0.22 });
        }
        if (step === 0) {
          this._tone(ctx, { frequency: 45, start: t, duration: 0.5, type: 'triangle', peakGain: 0.12 });
        }
        if (step === 2 || step === 6) {
          this._noiseBurst(ctx, { start: t, duration: 0.12, peakGain: 0.14, filterFrequency: 1800 });
        }
        this._noiseBurst(ctx, { start: t, duration: 0.04, peakGain: 0.05, filterFrequency: 7000 });
      }
    } catch {
      // Synthesis is best-effort ambiance — a failure here should never surface to the player.
    }

    this._julTimerId = setTimeout(() => this._scheduleJulBar(), JUL_STEPS_PER_BAR * JUL_STEP_SECONDS * 1000);
  }

  /** Runs `fn(ctx, currentTime)` if sound is enabled and a context is available — every named cue routes through this single guarded entry point. Never throws. */
  _withContext(fn) {
    if (this._muted) return;
    const ctx = this._getContext();
    if (!ctx) return;
    try {
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      fn(ctx, ctx.currentTime);
    } catch {
      // Synthesis is best-effort ambiance — a failure here should never surface to the player.
    }
  }

  /** A single oscillator burst with a quick attack/decay gain envelope. */
  _tone(ctx, { frequency, start, duration, type, peakGain }) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, start);
    osc.connect(gain);
    gain.connect(ctx.destination);

    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(peakGain, start + Math.min(0.01, duration / 4));
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    osc.start(start);
    osc.stop(start + duration + 0.02);
  }

  /** A short burst of filtered white noise — the only way to get a percussive "impact" texture out of the Web Audio API without a preloaded sample. */
  _noiseBurst(ctx, { start, duration, peakGain, filterFrequency }) {
    const sampleCount = Math.ceil(ctx.sampleRate * duration);
    const buffer = ctx.createBuffer(1, sampleCount, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < sampleCount; i += 1) data[i] = Math.random() * 2 - 1;

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = filterFrequency;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(peakGain, start);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);

    source.start(start);
    source.stop(start + duration + 0.02);
  }
}

const instance = new AudioEngine();
export default instance;
export { AudioEngine };
