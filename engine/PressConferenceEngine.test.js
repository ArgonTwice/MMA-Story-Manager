/**
 * engine/PressConferenceEngine.test.js
 * Run with: node --test engine/PressConferenceEngine.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import BALANCE from '../data/balance.js';
import Fighter from '../models/Fighter.js';
import WorldState from '../state/WorldState.js';
import { isMainEventEligible, getStances, applyPressConferenceChoice } from './PressConferenceEngine.js';

function makeFighter(overrides = {}) {
  return new Fighter({
    identity: { name: 'PC Fighter', age: 27, style: 'Freestyle', weightClass: 'Lightweight', ...overrides.identity },
    career: overrides.career,
  });
}

test('getStances returns exactly the 3 spec\'d stances', () => {
  const stances = getStances();
  assert.equal(stances.length, 3);
  assert.deepEqual(
    stances.map((s) => s.id).sort(),
    ['PROVOCATEUR', 'RESPECTUEUX', 'TACTIQUE'].sort()
  );
});

test('isMainEventEligible is false for two titleless fighters against a low-reputation opponent gym', () => {
  const fighterA = makeFighter();
  const fighterB = makeFighter({ identity: { name: 'Opponent' } });
  assert.equal(isMainEventEligible({ fighterA, fighterB, opponentGymReputation: 10 }), false);
});

test('isMainEventEligible is true once either fighter already holds a title, regardless of gym reputation', () => {
  const fighterA = makeFighter({ career: { titles: ['WFC Lightweight'] } });
  const fighterB = makeFighter({ identity: { name: 'Opponent' } });
  assert.equal(isMainEventEligible({ fighterA, fighterB, opponentGymReputation: 0 }), true);
});

test('isMainEventEligible is true once the opponent gym reputation reaches the configured tier threshold', () => {
  const fighterA = makeFighter();
  const fighterB = makeFighter({ identity: { name: 'Opponent' } });
  const threshold = BALANCE.GYM.PROMOTION_TIER_REPUTATION_REQUIREMENT[BALANCE.PRESS_CONFERENCE.MAIN_EVENT_REPUTATION_TIER];

  assert.equal(isMainEventEligible({ fighterA, fighterB, opponentGymReputation: threshold - 1 }), false);
  assert.equal(isMainEventEligible({ fighterA, fighterB, opponentGymReputation: threshold }), true);
});

test('RESPECTUEUX applies no effects and a neutral purse multiplier', () => {
  const fighterA = makeFighter();
  const fighterB = makeFighter({ identity: { name: 'Opponent' } });
  const moraleBefore = fighterA.attributes.moral;

  const result = applyPressConferenceChoice('RESPECTUEUX', { fighterA, fighterB });
  assert.equal(result.purseMultiplier, 1);
  assert.equal(fighterA.attributes.moral, moraleBefore);
  assert.equal(fighterA.preparation.tacticalBonusPending, false);
});

test('PROVOCATEUR raises morale, grants a +20% purse multiplier, and raises the WorldState tension gauge between the two fighters', () => {
  const fighterA = makeFighter();
  const fighterB = makeFighter({ identity: { name: 'Opponent' } });
  const worldState = new WorldState();
  const moraleBefore = fighterA.attributes.moral;

  const result = applyPressConferenceChoice('PROVOCATEUR', { fighterA, fighterB, worldState });
  assert.equal(result.purseMultiplier, 1.2);
  assert.ok(fighterA.attributes.moral > moraleBefore);

  const relationship = worldState.getRelationship(fighterA.identity.id, fighterB.identity.id);
  assert.ok(relationship, 'a relationship record should have been created');
  assert.ok(relationship.gauges.tension > BALANCE.RELATIONSHIP.STARTING_TENSION);
});

test('PROVOCATEUR silently skips the tension effect when no worldState is provided', () => {
  const fighterA = makeFighter();
  const fighterB = makeFighter({ identity: { name: 'Opponent' } });
  assert.doesNotThrow(() => applyPressConferenceChoice('PROVOCATEUR', { fighterA, fighterB }));
});

test('TACTIQUE grants a pending tactical-prep bonus and no purse/morale change', () => {
  const fighterA = makeFighter();
  const fighterB = makeFighter({ identity: { name: 'Opponent' } });
  const moraleBefore = fighterA.attributes.moral;

  const result = applyPressConferenceChoice('TACTIQUE', { fighterA, fighterB });
  assert.equal(result.purseMultiplier, 1);
  assert.equal(fighterA.attributes.moral, moraleBefore);
  assert.equal(fighterA.preparation.tacticalBonusPending, true);
});

test('applyPressConferenceChoice rejects an unknown stance id', () => {
  const fighterA = makeFighter();
  const fighterB = makeFighter({ identity: { name: 'Opponent' } });
  assert.throws(() => applyPressConferenceChoice('NOT_A_STANCE', { fighterA, fighterB }), TypeError);
});
