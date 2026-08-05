/**
 * engine/FighterGenerator.test.js
 * Run with: node --test engine/FighterGenerator.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import BALANCE from '../data/balance.js';
import Fighter from '../models/Fighter.js';
import { generatePersonality } from './FighterGenerator.js';

test('generatePersonality always returns a valid archetype and 1..MAX_TRAITS unique, valid traits', () => {
  const archetypeKeys = new Set(Object.keys(BALANCE.PERSONALITY.ARCHETYPES));
  const traitKeys = new Set(Object.keys(BALANCE.PERSONALITY.TRAITS));
  const cfg = BALANCE.PERSONALITY.GENERATION;

  for (let i = 0; i < 200; i += 1) {
    const personality = generatePersonality();
    assert.ok(archetypeKeys.has(personality.archetype), `"${personality.archetype}" should be a valid archetype`);
    assert.ok(personality.traits.length >= cfg.MIN_TRAITS && personality.traits.length <= cfg.MAX_TRAITS);
    assert.equal(new Set(personality.traits).size, personality.traits.length, 'traits should never repeat');
    for (const trait of personality.traits) {
      assert.ok(traitKeys.has(trait), `"${trait}" should be a valid trait`);
    }
  }
});

test('generatePersonality is deterministic given a fixed rng, and produces a Fighter-ready shape', () => {
  const queue = [0, 0, 0]; // archetype pick, trait-count pick, trait pick
  const rng = () => queue.shift() ?? 0.9;

  const personality = generatePersonality(rng);
  const archetypeKeys = Object.keys(BALANCE.PERSONALITY.ARCHETYPES);
  const traitKeys = Object.keys(BALANCE.PERSONALITY.TRAITS);

  assert.equal(personality.archetype, archetypeKeys[0]);
  assert.deepEqual(personality.traits, [traitKeys[0]]);

  // Must be directly usable as Fighter construction input, with no further massaging.
  const fighter = new Fighter({ identity: { name: 'Generated' }, psychology: { personality } });
  assert.equal(fighter.psychology.personality.archetype, personality.archetype);
  assert.deepEqual(fighter.psychology.personality.traits, personality.traits);
});

test('different rng streams produce varied personalities (not every generated fighter collapses to the same default)', () => {
  const seen = new Set();
  for (let seed = 0; seed < 20; seed += 1) {
    let state = seed + 1;
    const rng = () => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state / 0x7fffffff;
    };
    const personality = generatePersonality(rng);
    seen.add(`${personality.archetype}:${personality.traits.join(',')}`);
  }
  assert.ok(seen.size > 1, 'generated personalities should vary across different rng streams');
});
