/**
 * state/GameState.test.js
 * Run with: node --test state/GameState.test.js
 *
 * Focuses on the real Save/Load pipeline (GameState -> SaveManager, not a
 * direct WorldState.toJSON()/fromJSON() call) preserving the Pyramide
 * Emergente's data: the relationship graph (with history), WorldMemory's
 * records/titleHolders, and a fighter's Personality/Legacy fields.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import Fighter from '../models/Fighter.js';
import { GameState } from './GameState.js';

test('save()/load() round-trips the relationship graph, its history, and world records through SaveManager', () => {
  const gameState = new GameState();
  gameState.newGame({ gymName: 'Persistence Gym' });

  gameState.worldState.upsertRelationship('f1', 'f2', { relation: -40, tension: 55 }, { type: 'COMBAT', description: 'A vs B' });
  gameState.worldState.trySetRecord('fastestKO', 42, { betterIf: 'LOWER', detail: 'blitz KO' });
  gameState.worldState.setTitleHolder('WFC:Lightweight', { fighterId: 'f1', fighterName: 'Fighter One', sinceDay: 1 });

  gameState.save('pyramid-slot');

  const reloaded = new GameState();
  reloaded.load('pyramid-slot');

  const relationship = reloaded.worldState.getRelationship('f1', 'f2');
  assert.equal(relationship.gauges.relation, -40 /* STARTING_RELATION(0) + delta(-40) */);
  assert.equal(relationship.history.length, 1);
  assert.equal(relationship.history[0].description, 'A vs B');

  assert.equal(reloaded.worldState.getRecord('fastestKO').value, 42);
  assert.deepEqual(reloaded.worldState.getTitleHolder('WFC:Lightweight'), {
    fighterId: 'f1',
    fighterName: 'Fighter One',
    sinceDay: 1,
  });
});

test("save()/load() round-trips a fighter's Personality (archetype + traits) and Legacy stays computable after reload", () => {
  const gameState = new GameState();
  gameState.newGame({ gymName: 'Legacy Gym' });

  const fighter = new Fighter({
    identity: { name: 'Legend In The Making' },
    psychology: { personality: { archetype: 'Predateur', traits: ['Intense', 'Provocateur'] } },
    career: { wins: 32, titles: ['WFC Lightweight', 'WFC Welterweight'] },
  });
  gameState.playerState.addFighter(fighter);
  const legacyBefore = fighter.getLegacyStage();

  gameState.save('legacy-slot');

  const reloaded = new GameState();
  reloaded.load('legacy-slot');
  const reloadedFighter = reloaded.playerState.roster[0];

  assert.equal(reloadedFighter.psychology.personality.archetype, 'Predateur');
  assert.deepEqual(reloadedFighter.psychology.personality.traits, ['Intense', 'Provocateur']);
  assert.equal(reloadedFighter.getLegacyStage(), legacyBefore);
  assert.equal(legacyBefore, 'LEGENDE');
});
