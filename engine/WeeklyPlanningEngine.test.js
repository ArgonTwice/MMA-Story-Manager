/**
 * engine/WeeklyPlanningEngine.test.js
 * Run with: node --test engine/WeeklyPlanningEngine.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import BALANCE from '../data/balance.js';
import Fighter from '../models/Fighter.js';
import PlayerState from '../state/PlayerState.js';
import WorldState from '../state/WorldState.js';
import { processWeeklyPlan, WEEKLY_PLANNING_EVENTS } from './WeeklyPlanningEngine.js';
import EventBus from '../core/EventBus.js';

function makeFighter(overrides = {}) {
  return new Fighter({
    identity: { name: 'Tester', age: 27 },
    attributes: {
      skills: { boxe: 40, jambes: 60, sol: 40, soumission: 40, cardio: 40, intelligence: 40 },
      ...overrides.attributes,
    },
    ...overrides,
  });
}

/** A constant RNG never rolls under any probability check (Sparring's injuryChance stays a non-event). */
function neverRng() {
  return 0.999999;
}

test('an empty weekly plan (all null slots) is a complete no-op: no skill/fatigue/money change', () => {
  const player = new PlayerState({ gymName: 'Idle Gym' });
  const world = new WorldState();
  const fighter = makeFighter();
  player.addFighter(fighter);

  const before = { boxe: fighter.attributes.skills.boxe, fatigue: fighter.attributes.fatigue, money: player.money };
  const report = processWeeklyPlan(player, world, { rng: neverRng });

  assert.equal(report.activityLog.length, 0);
  assert.equal(fighter.attributes.skills.boxe, before.boxe);
  assert.equal(fighter.attributes.fatigue, before.fatigue);
  assert.equal(player.money, before.money);
  assert.equal(fighter.preparation.weeklyCharge, 0);
});

test('TECHNIQUE trains the fighter\'s current weakest skill by exactly ACTIVITIES.TECHNIQUE.skillGain, and costs Fatigue', () => {
  const player = new PlayerState({ gymName: 'Grinder Gym' });
  const world = new WorldState();
  const fighter = makeFighter(); // boxe=40 is tied-lowest with sol/soumission/cardio/intelligence; jambes=60 is highest
  fighter.setWeeklyPlanSlot(0, 'TECHNIQUE');
  player.addFighter(fighter);

  const activity = BALANCE.WEEKLY_PLANNING.ACTIVITIES.TECHNIQUE;
  const before = fighter.attributes.skills.boxe;
  const report = processWeeklyPlan(player, world, { rng: neverRng });

  assert.equal(report.activityLog.length, 1);
  assert.equal(report.activityLog[0].skillKey, 'boxe', 'weakest skill by SKILL_KEYS order among the tied-lowest');
  assert.ok(Math.abs(fighter.attributes.skills.boxe - before - activity.skillGain) < 1e-9);
  assert.ok(fighter.attributes.fatigue > 0, 'TECHNIQUE has a positive fatigueCost');
  assert.equal(fighter.preparation.weeklyCharge, activity.charge);
});

test('VIDEO_PREP sets preparation.tacticalBonusPending without touching skills', () => {
  const player = new PlayerState({ gymName: 'Film Study Gym' });
  const world = new WorldState();
  const fighter = makeFighter();
  fighter.setWeeklyPlanSlot(0, 'VIDEO_PREP');
  player.addFighter(fighter);

  const skillsBefore = { ...fighter.attributes.skills };
  processWeeklyPlan(player, world, { rng: neverRng });

  assert.equal(fighter.preparation.tacticalBonusPending, true);
  assert.deepEqual(fighter.attributes.skills, skillsBefore);
});

test('MEDIA_SPONSORS grants gym reputation/hype/money and a personality-scaled morale delta', () => {
  const player = new PlayerState({ gymName: 'Spotlight Gym', reputation: 20, hype: 10, money: 25000 });
  const world = new WorldState();
  const fighter = makeFighter();
  fighter.setWeeklyPlanSlot(0, 'MEDIA_SPONSORS');
  player.addFighter(fighter);

  const activity = BALANCE.WEEKLY_PLANNING.ACTIVITIES.MEDIA_SPONSORS;
  const moralBefore = fighter.attributes.moral;
  const report = processWeeklyPlan(player, world, { rng: neverRng });

  assert.equal(player.reputation, 20 + activity.reputationGain);
  assert.equal(player.hype, 10 + activity.hypeGain);
  assert.equal(player.money, 25000 + activity.moneyGain);
  assert.notEqual(fighter.attributes.moral, moralBefore);
  assert.ok(report.mediaEvents.length === 1);
});

test('PHYSIO_REST reduces Fatigue by ACTIVITIES.PHYSIO_REST.fatigueDelta, unscaled by personality (recovery, not wear)', () => {
  const player = new PlayerState({ gymName: 'Recovery Gym' });
  const world = new WorldState();
  const fighter = makeFighter({ attributes: { fatigue: 50 } });
  fighter.setWeeklyPlanSlot(0, 'PHYSIO_REST');
  player.addFighter(fighter);

  processWeeklyPlan(player, world, { rng: neverRng });

  const activity = BALANCE.WEEKLY_PLANNING.ACTIVITIES.PHYSIO_REST;
  assert.equal(fighter.attributes.fatigue, 50 + activity.fatigueDelta);
});

test('SPARRING can roll a micro-injury and applies it via Fighter#applyInjury, publishing SPARRING_INJURY', () => {
  const player = new PlayerState({ gymName: 'Hard Camp' });
  const world = new WorldState();
  const fighter = makeFighter();
  fighter.setWeeklyPlanSlot(0, 'SPARRING');
  player.addFighter(fighter);

  const events = [];
  const unsub = EventBus.subscribe(WEEKLY_PLANNING_EVENTS.SPARRING_INJURY, (payload) => events.push(payload));

  // A constant rng below SPARRING.injuryChance always triggers the roll, and
  // severity/bodyPart selection then consumes the same source deterministically.
  const report = processWeeklyPlan(player, world, { rng: () => 0 });
  unsub();

  assert.equal(report.injuries.length, 1);
  assert.equal(events.length, 1);
  assert.equal(fighter.medical.injuriesHistory.length, 1);
  assert.notEqual(fighter.medical.injuredUntil, null);
});

test('3 slots in the same week all resolve independently, and weeklyCharge sums every slot\'s charge', () => {
  const player = new PlayerState({ gymName: 'Full Week Gym' });
  const world = new WorldState();
  const fighter = makeFighter();
  fighter.setWeeklyPlanSlot(0, 'TECHNIQUE');
  fighter.setWeeklyPlanSlot(1, 'VIDEO_PREP');
  fighter.setWeeklyPlanSlot(2, 'PHYSIO_REST');
  player.addFighter(fighter);

  const a = BALANCE.WEEKLY_PLANNING.ACTIVITIES;
  const report = processWeeklyPlan(player, world, { rng: neverRng });

  assert.equal(report.activityLog.length, 3);
  assert.equal(fighter.preparation.weeklyCharge, a.TECHNIQUE.charge + a.VIDEO_PREP.charge + a.PHYSIO_REST.charge);
  assert.equal(fighter.preparation.tacticalBonusPending, true);
});
