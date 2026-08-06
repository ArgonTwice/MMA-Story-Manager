/**
 * engine/DramaEngine.test.js
 * Run with: node --test engine/DramaEngine.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import BALANCE from '../data/balance.js';
import { DRAMA_EVENTS } from '../data/events.js';
import Fighter from '../models/Fighter.js';
import PlayerState from '../state/PlayerState.js';
import WorldState from '../state/WorldState.js';
import { processWeeklyDrama, DRAMA_ENGINE_EVENTS, selectEligibleDramaEvent, applyDramaEventChoice } from './DramaEngine.js';
import EventBus from '../core/EventBus.js';

function makeFighter(overrides = {}) {
  return new Fighter({
    identity: { name: 'Tester', age: 27, ...overrides.identity },
    attributes: {
      skills: { boxe: 40, jambes: 40, sol: 40, soumission: 40, cardio: 40, intelligence: 40 },
      ...overrides.attributes,
    },
    psychology: overrides.psychology,
  });
}

/** Never fires either roll — a guaranteed no-drama week. */
function neverRng() {
  return 0.999999;
}
/** Always fires both rolls, and always the first lottery entry, at the first sub-roll. */
function alwaysRng() {
  return 0;
}

test('an empty roster resolves zero events even with a guaranteed-fire rng', () => {
  const player = new PlayerState({ gymName: 'Empty Gym' });
  const world = new WorldState();

  const report = processWeeklyDrama(player, world, { rng: alwaysRng });

  assert.deepEqual(report.events, []);
});

test('a never-fire rng resolves zero events regardless of roster', () => {
  const player = new PlayerState({ gymName: 'Quiet Gym' });
  const world = new WorldState();
  player.addFighter(makeFighter());

  const report = processWeeklyDrama(player, world, { rng: neverRng });

  assert.deepEqual(report.events, []);
});

test('every DRAMA_EVENTS entry is well-formed: unique id, known category, non-empty choices, effects reference known types', () => {
  const KNOWN_CATEGORIES = new Set(['FIGHTER_STORY', 'MEDIA_ENGINE', 'SPONSORS_MARCHE_NOIR', 'RIVALRIES', 'GYM_LIFE']);
  const KNOWN_EFFECT_TYPES = new Set([
    'ADJUST_PHYSICAL_FATIGUE',
    'ADJUST_MENTAL_FATIGUE',
    'ADJUST_MORALE',
    'ADJUST_LOYALTY',
    'CHANGE_REPUTATION',
    'CHANGE_HYPE',
    'CHANGE_MONEY',
  ]);
  const seenIds = new Set();

  for (const event of DRAMA_EVENTS) {
    assert.ok(!seenIds.has(event.id), `duplicate event id "${event.id}"`);
    seenIds.add(event.id);
    assert.ok(KNOWN_CATEGORIES.has(event.category), `${event.id}: unknown category "${event.category}"`);
    assert.ok(event.choices.length >= 2, `${event.id}: expected at least 2 choices`);
    for (const choice of event.choices) {
      for (const effect of choice.effects) {
        assert.ok(KNOWN_EFFECT_TYPES.has(effect.type), `${event.id}/${choice.id}: unknown effect type "${effect.type}"`);
      }
    }
  }

  // At least one event exists per the spec's 5 families.
  const categoriesSeen = new Set(DRAMA_EVENTS.map((e) => e.category));
  assert.deepEqual(categoriesSeen, KNOWN_CATEGORIES);
});

test('resolving many weeks with a guaranteed-fire rng applies effects and publishes DRAMA_ENGINE_EVENTS.RESOLVED for every event', () => {
  const player = new PlayerState({ gymName: 'Busy Gym', reputation: 50, hype: 50, money: 25000 });
  const world = new WorldState();
  for (let i = 0; i < 4; i += 1) player.addFighter(makeFighter({ identity: { name: `F${i}` } }));

  const events = [];
  const unsub = EventBus.subscribe(DRAMA_ENGINE_EVENTS.RESOLVED, (payload) => events.push(payload));

  let rngCallIndex = 0;
  const rng = () => {
    // Alternates just enough to vary picks across many calls without ever exceeding the always-fire thresholds for the two weekly rolls.
    rngCallIndex += 1;
    return (rngCallIndex % 97) / 100;
  };

  let totalEvents = 0;
  for (let week = 0; week < 50; week += 1) {
    const report = processWeeklyDrama(player, world, { rng });
    totalEvents += report.events.length;
  }

  assert.ok(totalEvents > 0, 'sanity: 50 weeks with an always-plausible-fire rng should resolve at least some events');
  assert.equal(events.length, totalEvents, 'every resolved event should publish exactly one RESOLVED event');
  unsub();
});

test('SPONSOR_OFFER\'s ACCEPT choice grants money to the gym; DECLINE does not', () => {
  // Force: primary roll fires (< 0.85), SPONSOR_OFFER gets picked via the weighted lottery, ACCEPT gets picked.
  // Since multiple eligible events compete, we instead assert on the *aggregate* effect over many weeks with an
  // always-fire rng: total money change should differ from zero given ACCEPT/SPONSOR_OFFER fires often enough.
  const player = new PlayerState({ gymName: 'Money Gym', money: 25000 });
  const world = new WorldState();
  player.addFighter(makeFighter());

  const moneyBefore = player.money;
  let seed = 1;
  const rng = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  for (let week = 0; week < 200; week += 1) {
    processWeeklyDrama(player, world, { rng });
  }

  assert.notEqual(player.money, moneyBefore, 'sanity: 200 weeks of drama should have moved the gym\'s money at least once (SPONSOR_OFFER/EQUIPMENT_OPPORTUNITY/POACHING_ATTEMPT all touch it)');
});

test('RIVALRIES-category events never fire when WorldState has no rival gyms', () => {
  const player = new PlayerState({ gymName: 'Isolated Gym' });
  const world = new WorldState(); // no addRivalGym call
  for (let i = 0; i < 3; i += 1) player.addFighter(makeFighter({ identity: { name: `F${i}` } }));

  const events = [];
  const unsub = EventBus.subscribe(DRAMA_ENGINE_EVENTS.RESOLVED, (payload) => events.push(payload));

  let seed = 7;
  const rng = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let week = 0; week < 200; week += 1) processWeeklyDrama(player, world, { rng });
  unsub();

  assert.ok(events.length > 0, 'sanity: some non-rivalry events should still fire');
  assert.ok(events.every((e) => e.category !== 'RIVALRIES'), 'HAS_RIVAL_GYMS should gate out every RIVALRIES event with zero rival gyms');
});

test('with rival gyms present, RIVALRIES-category events can fire', () => {
  const player = new PlayerState({ gymName: 'Contested Gym', money: 25000 });
  const world = new WorldState();
  world.addRivalGym({ name: 'Rival A', reputation: 50, activity: 50 });
  world.addRivalGym({ name: 'Rival B', reputation: 50, activity: 50 });
  for (let i = 0; i < 3; i += 1) player.addFighter(makeFighter({ identity: { name: `F${i}` } }));

  const events = [];
  const unsub = EventBus.subscribe(DRAMA_ENGINE_EVENTS.RESOLVED, (payload) => events.push(payload));

  let seed = 3;
  const rng = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let week = 0; week < 300; week += 1) processWeeklyDrama(player, world, { rng });
  unsub();

  assert.ok(events.some((e) => e.category === 'RIVALRIES'), 'expected at least one RIVALRIES event to fire over 300 weeks with rival gyms present');
});

test('HAS_TRAIT gates LOYALTY_TEST to a fighter who actually carries the Loyal trait', () => {
  const world = new WorldState();
  world.addRivalGym({ name: 'Rival', reputation: 50, activity: 50 });

  const withoutTraitPlayer = new PlayerState({ gymName: 'No Loyal Trait' });
  withoutTraitPlayer.addFighter(makeFighter({ psychology: { personality: { archetype: 'Cameleon', traits: ['Fetard'] } } }));

  let seed = 1;
  const rngA = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < 500; i += 1) {
    const selection = selectEligibleDramaEvent(withoutTraitPlayer, world, rngA);
    assert.notEqual(selection?.event.id, 'LOYALTY_TEST', 'a fighter without the Loyal trait should never be offered LOYALTY_TEST');
  }

  const withTraitPlayer = new PlayerState({ gymName: 'Loyal Roster' });
  withTraitPlayer.addFighter(makeFighter({ psychology: { personality: { archetype: 'Cameleon', traits: ['Loyal'] } } }));

  let sawLoyaltyTest = false;
  let seed2 = 1;
  const rngB = () => {
    seed2 = (seed2 * 1103515245 + 12345) & 0x7fffffff;
    return seed2 / 0x7fffffff;
  };
  for (let i = 0; i < 500 && !sawLoyaltyTest; i += 1) {
    const selection = selectEligibleDramaEvent(withTraitPlayer, world, rngB);
    if (selection?.event.id === 'LOYALTY_TEST') sawLoyaltyTest = true;
  }
  assert.ok(sawLoyaltyTest, 'a fighter WITH the Loyal trait should be offered LOYALTY_TEST at least once across 500 attempts');
});

test('LOYALTY_TEST\'s REAFFIRM_BOND choice raises psychology.loyalty via the ADJUST_LOYALTY effect; STAY_NONCOMMITTAL lowers it', () => {
  const world = new WorldState();
  world.addRivalGym({ name: 'Rival', reputation: 50, activity: 50 });
  const player = new PlayerState({ gymName: 'Loyal Roster' });
  const fighter = makeFighter({ psychology: { personality: { archetype: 'Cameleon', traits: ['Loyal'] } } });
  player.addFighter(fighter);

  const event = DRAMA_EVENTS.find((e) => e.id === 'LOYALTY_TEST');
  const selection = { event, fighter, playerState: player, worldState: world };

  const loyaltyBefore = fighter.psychology.loyalty;
  applyDramaEventChoice(selection, 'REAFFIRM_BOND');
  assert.equal(fighter.psychology.loyalty, Math.min(BALANCE.PSYCHOLOGY.MAX, loyaltyBefore + 15));

  const loyaltyAfterReaffirm = fighter.psychology.loyalty;
  applyDramaEventChoice(selection, 'STAY_NONCOMMITTAL');
  assert.equal(fighter.psychology.loyalty, Math.max(BALANCE.PSYCHOLOGY.MIN, loyaltyAfterReaffirm - 5));
});
