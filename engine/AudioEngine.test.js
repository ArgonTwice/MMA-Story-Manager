/**
 * engine/AudioEngine.test.js
 * Run with: node --test engine/AudioEngine.test.js
 *
 * Node has no Web Audio API, so these tests verify the two things that are
 * actually testable headlessly: (1) mute-state persistence/toggle logic,
 * and (2) that every play*() cue is a safe no-op with no AudioContext
 * available — never throws, regardless of mute state.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { AudioEngine } from './AudioEngine.js';
import audioEngine from './AudioEngine.js';

function makeMemoryStorage() {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, value),
    _store: store,
  };
}

test('a fresh AudioEngine (no prior stored preference) starts unmuted', () => {
  const engine = new AudioEngine({ storage: makeMemoryStorage() });
  assert.equal(engine.isMuted(), false);
});

test('setMuted persists the preference through the injected storage adapter', () => {
  const storage = makeMemoryStorage();
  const engine = new AudioEngine({ storage });

  engine.setMuted(true);
  assert.equal(engine.isMuted(), true);
  assert.equal(storage.getItem('mma_gym_manager.audio_muted'), '1');

  engine.setMuted(false);
  assert.equal(engine.isMuted(), false);
  assert.equal(storage.getItem('mma_gym_manager.audio_muted'), '0');
});

test('toggleMuted flips and returns the new state', () => {
  const engine = new AudioEngine({ storage: makeMemoryStorage() });
  assert.equal(engine.toggleMuted(), true);
  assert.equal(engine.isMuted(), true);
  assert.equal(engine.toggleMuted(), false);
  assert.equal(engine.isMuted(), false);
});

test('a new AudioEngine reads back a previously stored muted=true preference', () => {
  const storage = makeMemoryStorage();
  storage.setItem('mma_gym_manager.audio_muted', '1');
  const engine = new AudioEngine({ storage });
  assert.equal(engine.isMuted(), true);
});

test('every named cue is a safe no-op with no Web Audio API available (Node), muted or not', () => {
  const engine = new AudioEngine({ storage: makeMemoryStorage() });

  for (const muted of [false, true]) {
    engine.setMuted(muted);
    assert.doesNotThrow(() => engine.playClick());
    assert.doesNotThrow(() => engine.playCash());
    assert.doesNotThrow(() => engine.playHit());
    assert.doesNotThrow(() => engine.playGong());
    assert.doesNotThrow(() => engine.playVictory());
  }
});

test('the default export is a shared singleton instance of AudioEngine', () => {
  assert.ok(audioEngine instanceof AudioEngine);
  assert.equal(typeof audioEngine.playClick, 'function');
  assert.equal(typeof audioEngine.toggleMuted, 'function');
});

test('a synthetic AudioContext-like environment is actually driven by _withContext (no window -> _getContext returns null, verified indirectly via no-throw + no stored context leak)', () => {
  const engine = new AudioEngine({ storage: makeMemoryStorage() });
  // Calling twice must not create/reuse any context in a window-less environment.
  engine.playHit();
  engine.playHit();
  assert.equal(engine._ctx, null);
});

// ---- synthesis, exercised against a minimal mock Web Audio API ----------------

function makeMockAudioContext() {
  const calls = { oscillatorsStarted: 0, buffersStarted: 0, connected: 0 };
  const param = () => ({
    setValueAtTime: () => {},
    linearRampToValueAtTime: () => {},
    exponentialRampToValueAtTime: () => {},
  });
  const node = () => ({ connect: () => calls.connected++ });

  class MockContext {
    constructor() {
      this.state = 'suspended';
      this.currentTime = 0;
      this.sampleRate = 44100;
      this.destination = {};
    }
    resume() {
      this.state = 'running';
      return Promise.resolve();
    }
    createOscillator() {
      return { type: '', frequency: param(), ...node(), start: () => calls.oscillatorsStarted++, stop: () => {} };
    }
    createGain() {
      return { gain: param(), ...node() };
    }
    createBuffer(channels, length) {
      return { getChannelData: () => new Float32Array(length) };
    }
    createBufferSource() {
      return { buffer: null, ...node(), start: () => calls.buffersStarted++, stop: () => {} };
    }
    createBiquadFilter() {
      return { type: '', frequency: { value: 0 }, ...node() };
    }
  }

  return { MockContext, calls };
}

test('playClick/playCash/playGong/playVictory synthesize via oscillators against a mock AudioContext', () => {
  const { MockContext, calls } = makeMockAudioContext();
  const originalWindow = globalThis.window;
  globalThis.window = { AudioContext: MockContext };

  try {
    const engine = new AudioEngine({ storage: makeMemoryStorage() });
    engine.playClick();
    engine.playCash();
    engine.playGong();
    engine.playVictory();
    assert.ok(calls.oscillatorsStarted >= 1 + 2 + 2 + 4, 'expected at least one oscillator per tone across all 4 cues');
  } finally {
    globalThis.window = originalWindow;
  }
});

test('playHit synthesizes via a noise buffer source against a mock AudioContext', () => {
  const { MockContext, calls } = makeMockAudioContext();
  const originalWindow = globalThis.window;
  globalThis.window = { AudioContext: MockContext };

  try {
    const engine = new AudioEngine({ storage: makeMemoryStorage() });
    engine.playHit();
    assert.equal(calls.buffersStarted, 1);
  } finally {
    globalThis.window = originalWindow;
  }
});

test('a muted engine never touches the AudioContext at all', () => {
  const { MockContext, calls } = makeMockAudioContext();
  const originalWindow = globalThis.window;
  globalThis.window = { AudioContext: MockContext };

  try {
    const engine = new AudioEngine({ storage: makeMemoryStorage() });
    engine.setMuted(true);
    engine.playClick();
    engine.playHit();
    engine.playGong();
    assert.equal(calls.oscillatorsStarted, 0);
    assert.equal(calls.buffersStarted, 0);
  } finally {
    globalThis.window = originalWindow;
  }
});

// ---- "Musique Style Jul" ambiance loop ----------------------------------------

test('JUL mode is off by default, persists through setJulModeEnabled/toggleJulMode, and a fresh engine reads back a stored preference', () => {
  const storage = makeMemoryStorage();
  const engine = new AudioEngine({ storage });
  assert.equal(engine.isJulModeEnabled(), false);

  engine.setJulModeEnabled(true);
  assert.equal(engine.isJulModeEnabled(), true);
  assert.equal(storage.getItem('mma_gym_manager.audio_jul_mode'), '1');
  engine.setJulModeEnabled(false); // stop the loop before this test ends

  assert.equal(engine.toggleJulMode(), true);
  engine.setJulModeEnabled(false);

  const engine2 = new AudioEngine({ storage: (() => { const s = makeMemoryStorage(); s.setItem('mma_gym_manager.audio_jul_mode', '1'); return s; })() });
  assert.equal(engine2.isJulModeEnabled(), true);
});

test('enabling JUL mode with no Web Audio API available (Node) is a safe no-op — no dangling timer', () => {
  const engine = new AudioEngine({ storage: makeMemoryStorage() });
  assert.doesNotThrow(() => engine.setJulModeEnabled(true));
  assert.equal(engine._julTimerId, null, 'no context available means no loop should ever have been scheduled');
  engine.setJulModeEnabled(false);
});

test('enabling JUL mode against a mock AudioContext schedules Pattern A\'s kick/bass/hihat/snare synthesis, starting fresh each time', () => {
  const { MockContext, calls } = makeMockAudioContext();
  const originalWindow = globalThis.window;
  globalThis.window = { AudioContext: MockContext };

  try {
    const engine = new AudioEngine({ storage: makeMemoryStorage() });
    engine.setJulModeEnabled(true);
    assert.ok(engine._julTimerId !== null, 'a bar should be scheduled to loop');
    // Pattern A: kick x2 + bass x2 = 4 oscillator tones; hihat x8 + snare x2 = 10 noise bursts.
    assert.equal(calls.oscillatorsStarted, 4);
    assert.equal(calls.buffersStarted, 10);
    assert.equal(engine._julBarIndex, 1);
    engine.setJulModeEnabled(false); // stop the loop before this test ends
  } finally {
    globalThis.window = originalWindow;
  }
});

test('successive JUL bars alternate between Pattern A and Pattern B, each with its own kick/bass/hihat/snare shape', () => {
  const { MockContext, calls } = makeMockAudioContext();
  const originalWindow = globalThis.window;
  globalThis.window = { AudioContext: MockContext };

  try {
    const engine = new AudioEngine({ storage: makeMemoryStorage() });
    engine.setJulModeEnabled(true); // schedules bar 0 (Pattern A): +4 osc, +10 noise
    assert.equal(calls.oscillatorsStarted, 4);
    assert.equal(calls.buffersStarted, 10);

    engine._stopJulLoop(); // bypass the real setTimeout delay between bars
    engine._scheduleJulBar(); // bar 1 (Pattern B): kick x4 + bass x1 = 5 osc; snare x3 + hihat x9 = 12 noise
    assert.equal(calls.oscillatorsStarted, 4 + 5);
    assert.equal(calls.buffersStarted, 10 + 12);
    assert.equal(engine._julBarIndex, 2);

    engine._stopJulLoop(); // bypass again
    engine._scheduleJulBar(); // bar 2 cycles back to Pattern A
    assert.equal(calls.oscillatorsStarted, 4 + 5 + 4);
    assert.equal(calls.buffersStarted, 10 + 12 + 10);

    engine.setJulModeEnabled(false);
  } finally {
    globalThis.window = originalWindow;
  }
});

test('muting stops the JUL loop, and unmuting resumes it if still enabled', () => {
  const { MockContext } = makeMockAudioContext();
  const originalWindow = globalThis.window;
  globalThis.window = { AudioContext: MockContext };

  try {
    const engine = new AudioEngine({ storage: makeMemoryStorage() });
    engine.setJulModeEnabled(true);
    assert.ok(engine._julTimerId !== null);

    engine.setMuted(true);
    assert.equal(engine._julTimerId, null, 'muting should stop the loop');

    engine.setMuted(false);
    assert.ok(engine._julTimerId !== null, 'unmuting should resume the loop since JUL mode is still enabled');

    engine.setJulModeEnabled(false);
  } finally {
    globalThis.window = originalWindow;
  }
});

test('disabling JUL mode stops the loop', () => {
  const { MockContext } = makeMockAudioContext();
  const originalWindow = globalThis.window;
  globalThis.window = { AudioContext: MockContext };

  try {
    const engine = new AudioEngine({ storage: makeMemoryStorage() });
    engine.setJulModeEnabled(true);
    assert.ok(engine._julTimerId !== null);
    engine.setJulModeEnabled(false);
    assert.equal(engine._julTimerId, null);
  } finally {
    globalThis.window = originalWindow;
  }
});

// ---- custom local ambiance track ----------------------------------------------

function makeMockAudioElementClass(calls) {
  return class MockAudio {
    constructor(url) {
      this.src = url;
      this.loop = false;
      this.volume = 1;
      calls.constructed.push(url);
    }
    play() {
      calls.played += 1;
      return Promise.resolve();
    }
    pause() {
      calls.paused += 1;
    }
  };
}

function makeMockUrlApi() {
  let counter = 0;
  return {
    createObjectURL: (file) => `blob:mock-${counter++}:${file?.name ?? 'file'}`,
    revokeObjectURL: () => {},
  };
}

test('loadCustomTrack with no Web Audio/HTMLAudioElement available (Node) is a safe no-op', () => {
  const engine = new AudioEngine({ storage: makeMemoryStorage() });
  assert.equal(engine.loadCustomTrack({ name: 'track.mp3' }), false);
  assert.equal(engine.isCustomTrackEnabled(), false);
  assert.equal(engine.getCustomTrackName(), null);
});

test('loadCustomTrack against a mock HTMLAudioElement loads, names, and auto-plays a looping track', () => {
  const calls = { constructed: [], played: 0, paused: 0 };
  const originalWindow = globalThis.window;
  const originalUrl = globalThis.URL;
  globalThis.window = { Audio: makeMockAudioElementClass(calls) };
  globalThis.URL = { ...originalUrl, ...makeMockUrlApi() };

  try {
    const engine = new AudioEngine({ storage: makeMemoryStorage() });
    const file = { name: 'ma-piste.mp3' };
    const loaded = engine.loadCustomTrack(file);

    assert.equal(loaded, true);
    assert.equal(engine.isCustomTrackEnabled(), true);
    assert.equal(engine.getCustomTrackName(), 'ma-piste.mp3');
    assert.equal(engine._customTrackEl.loop, true);
    assert.equal(calls.played, 1, 'an unmuted engine should auto-play the freshly loaded track');
  } finally {
    globalThis.window = originalWindow;
    globalThis.URL = originalUrl;
  }
});

test('loading a custom track while JUL mode is running stops the synthesized loop — only one ambiance source at a time', () => {
  const { MockContext } = makeMockAudioContext();
  const audioCalls = { constructed: [], played: 0, paused: 0 };
  const originalWindow = globalThis.window;
  const originalUrl = globalThis.URL;
  globalThis.window = { AudioContext: MockContext, Audio: makeMockAudioElementClass(audioCalls) };
  globalThis.URL = { ...originalUrl, ...makeMockUrlApi() };

  try {
    const engine = new AudioEngine({ storage: makeMemoryStorage() });
    engine.setJulModeEnabled(true);
    assert.ok(engine._julTimerId !== null);

    engine.loadCustomTrack({ name: 'ambiance.mp3' });
    assert.equal(engine.isJulModeEnabled(), false, 'loading a custom track should turn JUL mode off');
    assert.equal(engine._julTimerId, null);
    assert.equal(engine.isCustomTrackEnabled(), true);

    engine.setJulModeEnabled(true);
    assert.equal(engine.isCustomTrackEnabled(), false, 're-enabling JUL mode should stop the custom track');
    assert.equal(audioCalls.paused, 1);

    engine.setJulModeEnabled(false);
  } finally {
    globalThis.window = originalWindow;
    globalThis.URL = originalUrl;
  }
});

test('muting pauses a playing custom track, unmuting resumes it if still enabled', () => {
  const calls = { constructed: [], played: 0, paused: 0 };
  const originalWindow = globalThis.window;
  const originalUrl = globalThis.URL;
  globalThis.window = { Audio: makeMockAudioElementClass(calls) };
  globalThis.URL = { ...originalUrl, ...makeMockUrlApi() };

  try {
    const engine = new AudioEngine({ storage: makeMemoryStorage() });
    engine.loadCustomTrack({ name: 'track.mp3' });
    assert.equal(calls.played, 1);

    engine.setMuted(true);
    assert.equal(calls.paused, 1);

    engine.setMuted(false);
    assert.equal(calls.played, 2, 'unmuting should resume the still-enabled custom track');
  } finally {
    globalThis.window = originalWindow;
    globalThis.URL = originalUrl;
  }
});

test('clearCustomTrack pauses playback, revokes the Blob URL, and resets all custom-track state', () => {
  const calls = { constructed: [], played: 0, paused: 0 };
  const originalWindow = globalThis.window;
  const originalUrl = globalThis.URL;
  let revoked = null;
  globalThis.window = { Audio: makeMockAudioElementClass(calls) };
  globalThis.URL = { ...originalUrl, createObjectURL: () => 'blob:mock', revokeObjectURL: (url) => { revoked = url; } };

  try {
    const engine = new AudioEngine({ storage: makeMemoryStorage() });
    engine.loadCustomTrack({ name: 'track.mp3' });
    engine.clearCustomTrack();

    assert.equal(engine.isCustomTrackEnabled(), false);
    assert.equal(engine.getCustomTrackName(), null);
    assert.equal(engine._customTrackEl, null);
    assert.equal(calls.paused, 1);
    assert.equal(revoked, 'blob:mock');
  } finally {
    globalThis.window = originalWindow;
    globalThis.URL = originalUrl;
  }
});

test('setCustomTrackEnabled is a no-op when no track is loaded', () => {
  const engine = new AudioEngine({ storage: makeMemoryStorage() });
  assert.doesNotThrow(() => engine.setCustomTrackEnabled(true));
  assert.equal(engine.isCustomTrackEnabled(), false);
});
