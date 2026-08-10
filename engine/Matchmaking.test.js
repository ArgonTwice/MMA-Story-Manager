/**
 * engine/Matchmaking.test.js
 * Run with: node --test engine/Matchmaking.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import Fighter from '../models/Fighter.js';
import PlayerState from '../state/PlayerState.js';
import { assertNoIntraGymMatch, isGenderMatch, assertGenderMatch } from './Matchmaking.js';

function makeFighter(name, gender = 'M') {
  return new Fighter({ identity: { name, age: 25, style: 'Freestyle', weightClass: 'Lightweight', gender } });
}

test('assertNoIntraGymMatch throws when both fighters belong to the player\'s own roster', () => {
  const playerState = new PlayerState({ money: 25000 });
  const fighterA = makeFighter('Alpha');
  const fighterB = makeFighter('Beta');
  playerState.addFighter(fighterA);
  playerState.addFighter(fighterB);

  assert.throws(() => assertNoIntraGymMatch(fighterA, fighterB, playerState), /meme gym/);
});

test('assertNoIntraGymMatch does not throw when the opponent is not on the player\'s roster (a rival gym fighter)', () => {
  const playerState = new PlayerState({ money: 25000 });
  const fighterA = makeFighter('Alpha');
  const rivalFighter = makeFighter('Rival');
  playerState.addFighter(fighterA);

  assert.doesNotThrow(() => assertNoIntraGymMatch(fighterA, rivalFighter, playerState));
});

test('assertNoIntraGymMatch does not throw for two fighters neither of which is on the player\'s roster', () => {
  const playerState = new PlayerState({ money: 25000 });
  const rivalA = makeFighter('RivalA');
  const rivalB = makeFighter('RivalB');

  assert.doesNotThrow(() => assertNoIntraGymMatch(rivalA, rivalB, playerState));
});

// ---- V3.5: gender matching -----------------------------------------------------

test('isGenderMatch is true for same-gender fighters and false for opposite genders by default', () => {
  const m1 = makeFighter('M1', 'M');
  const m2 = makeFighter('M2', 'M');
  const f1 = makeFighter('F1', 'F');

  assert.equal(isGenderMatch(m1, m2), true);
  assert.equal(isGenderMatch(m1, f1), false);
});

test('isGenderMatch allows opposite genders once allowMixedGender is true', () => {
  const m1 = makeFighter('M1', 'M');
  const f1 = makeFighter('F1', 'F');
  assert.equal(isGenderMatch(m1, f1, { allowMixedGender: true }), true);
});

test('assertGenderMatch throws on a cross-gender pairing, and stays silent once matched or Mode Mixte is allowed', () => {
  const m1 = makeFighter('M1', 'M');
  const m2 = makeFighter('M2', 'M');
  const f1 = makeFighter('F1', 'F');

  assert.throws(() => assertGenderMatch(m1, f1), /genre/);
  assert.doesNotThrow(() => assertGenderMatch(m1, m2));
  assert.doesNotThrow(() => assertGenderMatch(m1, f1, { allowMixedGender: true }));
});
