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
