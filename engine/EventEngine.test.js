/**
 * engine/EventEngine.test.js
 * Run with: node --test engine/EventEngine.test.js
 *
 * Uses a small queued-RNG helper instead of createSeededRng so each test
 * targets an exact category/outcome by controlling precisely what every
 * successive rng() call returns, rather than hunting for a lucky seed.
 * BALANCE.NARRATIVE_EVENTS.CATEGORY_WEIGHTS partitions [0,1) as:
 *   [0, .2) SPONSOR_OFFER | [.2, .35) SPARRING_INJURY | [.35, .5) MEDIA_CLASH
 *   [.5, .55) DOPING_CONTROL | [.55, .85) MORALE_SWING | [.85, 1) ALUMNI_DONATION
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import EventBus from '../core/EventBus.js';
import BALANCE from '../data/balance.js';
import Fighter from '../models/Fighter.js';
import { GameState } from '../state/GameState.js';
import { evaluateWeeklyEvents, EVENT_ENGINE_EVENTS } from './EventEngine.js';

function makeQueueRng(sequence, fallback = 0.5) {
  const queue = [...sequence];
  return () => (queue.length > 0 ? queue.shift() : fallback);
}

function makeGameState({ withFighter = true } = {}) {
  const gameState = new GameState();
  gameState.newGame({ gymName: 'Narrative Gym' });
  if (withFighter) {
    gameState.playerState.addFighter(new Fighter({ identity: { name: 'Roster Fighter' } }));
  }
  return gameState;
}

test('no event fires when the weekly trigger roll misses', () => {
  const gameState = makeGameState();
  const result = evaluateWeeklyEvents(gameState, { rng: makeQueueRng([0.99]) });
  assert.deepEqual(result.triggered, []);
});

test('a triggered event is recorded in WorldState.globalEvents and published on event:triggered', () => {
  const gameState = makeGameState();
  const events = [];
  const unsub = EventBus.subscribe(EVENT_ENGINE_EVENTS.TRIGGERED, (payload) => events.push(payload));

  const result = evaluateWeeklyEvents(gameState, { rng: makeQueueRng([0.01, 0.01]) });
  unsub();

  assert.equal(result.triggered.length, 1);
  assert.equal(result.triggered[0].category, 'SPONSOR_OFFER');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], result.triggered[0]);

  const logged = gameState.worldState.globalEvents.some(
    (e) => e.type === 'NARRATIVE_EVENT' && e.narrativeEventId === result.triggered[0].id
  );
  assert.ok(logged);
});

test('SPONSOR_OFFER grants money and hype to the gym', () => {
  const gameState = makeGameState();
  const moneyBefore = gameState.playerState.money;
  const hypeBefore = gameState.playerState.hype;

  const result = evaluateWeeklyEvents(gameState, { rng: makeQueueRng([0.01, 0.01]) });

  assert.equal(result.triggered[0].category, 'SPONSOR_OFFER');
  assert.equal(gameState.playerState.money, moneyBefore + result.triggered[0].amount);
  assert.equal(gameState.playerState.hype, hypeBefore + BALANCE.NARRATIVE_EVENTS.SPONSOR_OFFER.HYPE_BONUS);
});

test('SPARRING_INJURY injures a roster fighter and hurts their morale', () => {
  const gameState = makeGameState();
  const fighter = gameState.playerState.roster[0];
  const moraleBefore = fighter.attributes.moral;

  const result = evaluateWeeklyEvents(gameState, { rng: makeQueueRng([0.01, 0.25]) });

  assert.equal(result.triggered[0].category, 'SPARRING_INJURY');
  assert.equal(result.triggered[0].fighterId, fighter.identity.id);
  assert.ok(fighter.medical.injuredUntil > 0);
  assert.ok(fighter.attributes.moral < moraleBefore);
});

test('SPARRING_INJURY silently produces no event when the roster is empty', () => {
  const gameState = makeGameState({ withFighter: false });
  const result = evaluateWeeklyEvents(gameState, { rng: makeQueueRng([0.01, 0.25]) });
  assert.deepEqual(result.triggered, []);
});

test('MEDIA_CLASH swings a fighter\'s morale and the gym\'s reputation', () => {
  const gameState = makeGameState();
  gameState.playerState.reputation = 50; // headroom so a negative reputationDelta isn't floor-clamped at 0 (V3.5 lowered STARTING_REPUTATION to 0).
  const fighter = gameState.playerState.roster[0];
  const moraleBefore = fighter.attributes.moral;
  const repBefore = gameState.playerState.reputation;

  const result = evaluateWeeklyEvents(gameState, { rng: makeQueueRng([0.01, 0.4]) });

  assert.equal(result.triggered[0].category, 'MEDIA_CLASH');
  assert.equal(fighter.attributes.moral, moraleBefore + result.triggered[0].moraleDelta);
  assert.equal(gameState.playerState.reputation, repBefore + result.triggered[0].reputationDelta);
});

test('DOPING_CONTROL: a passed test changes nothing beyond the headline', () => {
  const gameState = makeGameState();
  const fighter = gameState.playerState.roster[0];
  const moraleBefore = fighter.attributes.moral;
  const repBefore = gameState.playerState.reputation;

  // sequence: trigger, category=DOPING_CONTROL, fighter-pick (irrelevant with 1 fighter), fail-check (high = pass)
  const result = evaluateWeeklyEvents(gameState, { rng: makeQueueRng([0.01, 0.52, 0.5, 0.9]) });

  assert.equal(result.triggered[0].category, 'DOPING_CONTROL');
  assert.equal(result.triggered[0].failed, false);
  assert.equal(fighter.attributes.moral, moraleBefore);
  assert.equal(gameState.playerState.reputation, repBefore);
});

test('DOPING_CONTROL: a failed test is a scandal — reputation and morale both take a heavy hit', () => {
  const gameState = makeGameState();
  gameState.playerState.reputation = 50; // headroom so a negative reputationDelta isn't floor-clamped at 0 (V3.5 lowered STARTING_REPUTATION to 0).
  const fighter = gameState.playerState.roster[0];
  const moraleBefore = fighter.attributes.moral;
  const repBefore = gameState.playerState.reputation;

  // sequence: trigger, category=DOPING_CONTROL, fighter-pick, fail-check (low = fail)
  const result = evaluateWeeklyEvents(gameState, { rng: makeQueueRng([0.01, 0.52, 0.5, 0.001]) });

  assert.equal(result.triggered[0].category, 'DOPING_CONTROL');
  assert.equal(result.triggered[0].failed, true);
  assert.equal(fighter.attributes.moral, moraleBefore + BALANCE.NARRATIVE_EVENTS.DOPING_CONTROL.MORALE_PENALTY);
  assert.equal(
    gameState.playerState.reputation,
    repBefore + BALANCE.NARRATIVE_EVENTS.DOPING_CONTROL.REPUTATION_PENALTY
  );
});

test('MORALE_SWING adjusts a random fighter\'s morale', () => {
  const gameState = makeGameState();
  const fighter = gameState.playerState.roster[0];
  const moraleBefore = fighter.attributes.moral;

  const result = evaluateWeeklyEvents(gameState, { rng: makeQueueRng([0.01, 0.6]) });

  assert.equal(result.triggered[0].category, 'MORALE_SWING');
  assert.equal(fighter.attributes.moral, moraleBefore + result.triggered[0].delta);
});

test('ALUMNI_DONATION grants money and a small reputation bump', () => {
  const gameState = makeGameState();
  const moneyBefore = gameState.playerState.money;
  const repBefore = gameState.playerState.reputation;

  const result = evaluateWeeklyEvents(gameState, { rng: makeQueueRng([0.01, 0.9]) });

  assert.equal(result.triggered[0].category, 'ALUMNI_DONATION');
  assert.equal(gameState.playerState.money, moneyBefore + result.triggered[0].amount);
  assert.equal(gameState.playerState.reputation, repBefore + BALANCE.NARRATIVE_EVENTS.ALUMNI_DONATION.REPUTATION_BONUS);
});
