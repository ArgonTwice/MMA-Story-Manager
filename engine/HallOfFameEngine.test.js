/**
 * engine/HallOfFameEngine.test.js
 * Run with: node --test engine/HallOfFameEngine.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import EventBus from '../core/EventBus.js';
import BALANCE from '../data/balance.js';
import Fighter from '../models/Fighter.js';
import PlayerState from '../state/PlayerState.js';
import WorldState from '../state/WorldState.js';
import { COMBAT_EVENTS } from './CombatEngine.js';
import {
  getBadgeDefinition,
  getAllBadgeDefinitions,
  evaluateBadgeUnlocks,
  generateGoldenBookEntry,
  HallOfFameEngine,
} from './HallOfFameEngine.js';

function makeFighter(overrides = {}) {
  return new Fighter({
    identity: { name: 'HOF Fighter', age: 27, style: 'Freestyle', weightClass: 'Lightweight', ...overrides.identity },
    attributes: overrides.attributes,
    career: overrides.career,
  });
}

test('the catalog has exactly 20 badges, and getBadgeDefinition/getAllBadgeDefinitions read it consistently', () => {
  const all = getAllBadgeDefinitions();
  assert.equal(all.length, 20);
  for (const badge of all) {
    assert.equal(getBadgeDefinition(badge.id), badge);
    assert.ok(badge.label && badge.description && badge.icon);
  }
});

test('a fresh gym unlocks nothing — evaluateBadgeUnlocks returns empty', () => {
  const playerState = new PlayerState({ money: 25000 });
  const worldState = new WorldState();
  assert.deepEqual(evaluateBadgeUnlocks(playerState, worldState), []);
  assert.deepEqual(playerState.unlockedBadges, []);
});

test('PREMIERE_SIGNATURE unlocks as soon as the roster has a fighter', () => {
  const playerState = new PlayerState({ money: 25000 });
  const worldState = new WorldState();
  playerState.addFighter(makeFighter());

  const unlocked = evaluateBadgeUnlocks(playerState, worldState);
  assert.ok(unlocked.some((b) => b.id === 'PREMIERE_SIGNATURE'));
  assert.ok(playerState.unlockedBadges.includes('PREMIERE_SIGNATURE'));
});

test('MILLIONNAIRE unlocks once money reaches 1,000,000$, and stays unlocked even if money later drops', () => {
  const playerState = new PlayerState({ money: 1_000_000 });
  const worldState = new WorldState();

  evaluateBadgeUnlocks(playerState, worldState);
  assert.ok(playerState.unlockedBadges.includes('MILLIONNAIRE'));

  playerState.money = 100;
  evaluateBadgeUnlocks(playerState, worldState);
  assert.ok(playerState.unlockedBadges.includes('MILLIONNAIRE'), 'badge should remain unlocked permanently');
});

test('ICONE_MEDIATIQUE unlocks once a roster fighter\'s OWN Hype reaches FIGHTER_HYPE.MAX (V4.4: redirected off the retired gym-wide Hype stat)', () => {
  const playerState = new PlayerState({ money: 25000 });
  const worldState = new WorldState();
  const fighter = makeFighter();
  playerState.addFighter(fighter);

  evaluateBadgeUnlocks(playerState, worldState);
  assert.ok(!playerState.unlockedBadges.includes('ICONE_MEDIATIQUE'), 'not yet at max individual Hype');

  fighter.adjustHype(BALANCE.FIGHTER_HYPE.MAX);
  evaluateBadgeUnlocks(playerState, worldState);
  assert.ok(playerState.unlockedBadges.includes('ICONE_MEDIATIQUE'));
});

test('a badge is never unlocked twice — a second evaluateBadgeUnlocks call on an already-qualifying state returns nothing new', () => {
  const playerState = new PlayerState({ money: 25000 });
  const worldState = new WorldState();
  playerState.addFighter(makeFighter());

  const first = evaluateBadgeUnlocks(playerState, worldState);
  assert.ok(first.length > 0);
  const second = evaluateBadgeUnlocks(playerState, worldState);
  assert.deepEqual(second, []);
});

test('CHAMPION_DU_MONDE unlocks from a roster fighter holding a title, or from a Hall of Fame legend who held one', () => {
  const cfg1 = new PlayerState({ money: 25000 });
  const world1 = new WorldState();
  cfg1.addFighter(makeFighter({ career: { titles: ['WFC Lightweight'] } }));
  assert.ok(evaluateBadgeUnlocks(cfg1, world1).some((b) => b.id === 'CHAMPION_DU_MONDE'));

  const cfg2 = new PlayerState({ money: 25000 });
  const world2 = new WorldState();
  world2.addHallOfFameEntry({ fighterId: 'x', name: 'Legend', titles: ['WFC Welterweight'] });
  assert.ok(evaluateBadgeUnlocks(cfg2, world2).some((b) => b.id === 'CHAMPION_DU_MONDE'));
});

test('INVAINCU requires both 10+ wins AND 0 losses on the same fighter', () => {
  const playerState = new PlayerState({ money: 25000 });
  const worldState = new WorldState();
  playerState.addFighter(makeFighter({ career: { wins: 10, losses: 1 } }));
  assert.ok(!evaluateBadgeUnlocks(playerState, worldState).some((b) => b.id === 'INVAINCU'));

  playerState.roster[0].career.losses = 0;
  assert.ok(evaluateBadgeUnlocks(playerState, worldState).some((b) => b.id === 'INVAINCU'));
});

test('generateGoldenBookEntry produces a deterministic, non-empty recap referencing the gym name and year', () => {
  const playerState = new PlayerState({ gymName: 'Iron Fist Gym', money: 25000 });
  const worldState = new WorldState();
  const analysis = { year: 3, rivalryOfTheYear: null, upsetOfTheYear: null, finisherKing: null, coachOfTheYear: null, gymOfTheYear: null };

  const entry = generateGoldenBookEntry(playerState, worldState, analysis, { wins: 5, losses: 2, draws: 0 });
  assert.equal(entry.year, 3);
  assert.ok(entry.text.includes('Iron Fist Gym'));
  assert.ok(entry.text.includes('3'));

  const entryAgain = generateGoldenBookEntry(playerState, worldState, analysis, { wins: 5, losses: 2, draws: 0 });
  assert.equal(entry.text, entryAgain.text);
});

test('generateGoldenBookEntry mentions the season\'s trophy highlights when present', () => {
  const playerState = new PlayerState({ gymName: 'Trophy Gym', money: 25000 });
  const worldState = new WorldState();
  const analysis = {
    year: 1,
    rivalryOfTheYear: null,
    upsetOfTheYear: null,
    finisherKing: null,
    coachOfTheYear: null,
    gymOfTheYear: { label: 'Gym de l\'Annee' },
  };

  const entry = generateGoldenBookEntry(playerState, worldState, analysis);
  assert.ok(entry.text.toLowerCase().includes('gym de l\'annee'));
});

test('HallOfFameEngine reactively unlocks UPSET_DU_SIECLE on a big-underdog win by the player\'s own fighter, and not otherwise', () => {
  const playerState = new PlayerState({ money: 25000 });
  const underdog = makeFighter({ identity: { name: 'Underdog' } });
  playerState.addFighter(underdog);

  const engine = new HallOfFameEngine().attach(playerState);

  // Below the threshold — should NOT unlock.
  EventBus.publish(COMBAT_EVENTS.FINISHED, {
    winner: 'A',
    fighters: { A: underdog.identity.id, B: 'opponent-1' },
    preFightRatings: { A: 40, B: 40 + BALANCE.HALL_OF_FAME_BADGES.UPSET_RATING_GAP_THRESHOLD - 1 },
  });
  assert.ok(!playerState.unlockedBadges.includes('UPSET_DU_SIECLE'));

  // At/above the threshold — should unlock.
  EventBus.publish(COMBAT_EVENTS.FINISHED, {
    winner: 'A',
    fighters: { A: underdog.identity.id, B: 'opponent-2' },
    preFightRatings: { A: 20, B: 20 + BALANCE.HALL_OF_FAME_BADGES.UPSET_RATING_GAP_THRESHOLD },
  });
  assert.ok(playerState.unlockedBadges.includes('UPSET_DU_SIECLE'));

  engine.detach();
});

test('HallOfFameEngine ignores fights where the player\'s fighter loses or isn\'t involved', () => {
  const playerState = new PlayerState({ money: 25000 });
  const fighter = makeFighter();
  playerState.addFighter(fighter);

  const engine = new HallOfFameEngine().attach(playerState);

  EventBus.publish(COMBAT_EVENTS.FINISHED, {
    winner: 'B',
    fighters: { A: fighter.identity.id, B: 'opponent-1' },
    preFightRatings: { A: 10, B: 90 },
  });
  assert.ok(!playerState.unlockedBadges.includes('UPSET_DU_SIECLE'));

  EventBus.publish(COMBAT_EVENTS.FINISHED, {
    winner: 'A',
    fighters: { A: 'stranger-1', B: 'stranger-2' },
    preFightRatings: { A: 10, B: 90 },
  });
  assert.ok(!playerState.unlockedBadges.includes('UPSET_DU_SIECLE'));

  engine.detach();
});
