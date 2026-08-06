/**
 * engine/Matchmaking.test.js
 * Run with: node --test engine/Matchmaking.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import Fighter from '../models/Fighter.js';
import PlayerState from '../state/PlayerState.js';
import { assertNoIntraGymMatch } from './Matchmaking.js';

function makeFighter(name) {
  return new Fighter({ identity: { name, age: 25, style: 'Freestyle', weightClass: 'Lightweight' } });
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
