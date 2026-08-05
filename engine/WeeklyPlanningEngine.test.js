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

  const before = {
    boxe: fighter.attributes.skills.boxe,
    physicalFatigue: fighter.attributes.physicalFatigue,
    mentalFatigue: fighter.attributes.mentalFatigue,
    money: player.money,
  };
  const report = processWeeklyPlan(player, world, { rng: neverRng });

  assert.equal(report.activityLog.length, 0);
  assert.equal(fighter.attributes.skills.boxe, before.boxe);
  assert.equal(fighter.attributes.physicalFatigue, before.physicalFatigue);
  assert.equal(fighter.attributes.mentalFatigue, before.mentalFatigue);
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
  assert.ok(fighter.attributes.physicalFatigue > 0, 'TECHNIQUE has a positive physicalFatigueCost');
  assert.equal(fighter.attributes.mentalFatigue, 0, 'TECHNIQUE costs no Mental Fatigue');
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

test('PHYSIO_REST reduces both Fatigue gauges by ACTIVITIES.PHYSIO_REST.*Delta, unscaled by personality (recovery, not wear)', () => {
  const player = new PlayerState({ gymName: 'Recovery Gym' });
  const world = new WorldState();
  const fighter = makeFighter({ attributes: { physicalFatigue: 50, mentalFatigue: 50 } });
  fighter.setWeeklyPlanSlot(0, 'PHYSIO_REST');
  player.addFighter(fighter);

  processWeeklyPlan(player, world, { rng: neverRng });

  const activity = BALANCE.WEEKLY_PLANNING.ACTIVITIES.PHYSIO_REST;
  assert.equal(fighter.attributes.physicalFatigue, 50 + activity.physicalFatigueDelta);
  assert.equal(fighter.attributes.mentalFatigue, 50 + activity.mentalFatigueDelta);
});

test('SPARRING never rolls for injury below causalInjuryFatigueThreshold Physical Fatigue, even with a guaranteed-roll rng', () => {
  const player = new PlayerState({ gymName: 'Fresh Camp' });
  const world = new WorldState();
  const fighter = makeFighter({ attributes: { physicalFatigue: 10 } }); // well under causalInjuryFatigueThreshold
  fighter.setWeeklyPlanSlot(0, 'SPARRING');
  player.addFighter(fighter);

  const report = processWeeklyPlan(player, world, { rng: () => 0 });

  assert.equal(report.injuries.length, 0, 'the injury is causal — no threshold crossed, no roll attempted at all');
});

test('SPARRING can roll a causal micro-injury once Physical Fatigue is at/over causalInjuryFatigueThreshold, applying it via Fighter#applyInjury and publishing SPARRING_INJURY', () => {
  const player = new PlayerState({ gymName: 'Hard Camp' });
  const world = new WorldState();
  const threshold = BALANCE.WEEKLY_PLANNING.ACTIVITIES.SPARRING.causalInjuryFatigueThreshold;
  const fighter = makeFighter({ attributes: { physicalFatigue: threshold } });
  fighter.setWeeklyPlanSlot(0, 'SPARRING');
  player.addFighter(fighter);

  const events = [];
  const unsub = EventBus.subscribe(WEEKLY_PLANNING_EVENTS.SPARRING_INJURY, (payload) => events.push(payload));

  // A constant rng below SPARRING.injuryChance always triggers the roll once
  // the causal threshold is met, and severity/bodyPart selection then
  // consumes the same source deterministically.
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

test('Moral drifts one MORALE.WEEKLY_DRIFT_TOWARD_NEUTRAL step toward NEUTRAL_VALUE every week, from either side, never overshooting', () => {
  const player = new PlayerState({ gymName: 'Mood Swing Gym' });
  const world = new WorldState();
  const happy = makeFighter({ identity: { name: 'Happy' }, attributes: { moral: BALANCE.MORALE.NEUTRAL_VALUE + 1 } });
  const sad = makeFighter({ identity: { name: 'Sad' }, attributes: { moral: BALANCE.MORALE.NEUTRAL_VALUE - 100 } });
  player.addFighter(happy);
  player.addFighter(sad);

  processWeeklyPlan(player, world, { rng: neverRng });

  // happy started only 1 point above neutral: drift never overshoots past it.
  assert.equal(happy.attributes.moral, BALANCE.MORALE.NEUTRAL_VALUE);
  // sad started far below (clamped to MORALE.MIN=0): one full drift step up, no more.
  assert.equal(sad.attributes.moral, BALANCE.MORALE.MIN + BALANCE.MORALE.WEEKLY_DRIFT_TOWARD_NEUTRAL);
});
