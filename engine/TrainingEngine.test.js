/**
 * engine/TrainingEngine.test.js
 * Run with: node --test engine/TrainingEngine.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import EventBus from '../core/EventBus.js';
import BALANCE from '../data/balance.js';
import Fighter from '../models/Fighter.js';
import PlayerState from '../state/PlayerState.js';
import WorldState from '../state/WorldState.js';
import { processWeeklyTraining, TRAINING_EVENTS } from './TrainingEngine.js';

function makeFighter(name, overrides = {}) {
  return new Fighter({
    identity: { name, age: 27, origin: 'Inconnu', ...overrides.identity },
    attributes: {
      skills: { boxe: 40, jambes: 40, sol: 40, soumission: 40, cardio: 40, intelligence: 40 },
      forme: 80,
      ...overrides.attributes,
    },
  });
}

test('a fighter with a focus and NORMAL intensity gains skill on that focus and publishes training:progression', () => {
  const player = new PlayerState({ gymName: 'Solo Gym' });
  const world = new WorldState();
  const fighter = makeFighter('Learner');
  fighter.setTrainingPlan({ focus: 'boxe', intensity: 'NORMAL' });
  player.addFighter(fighter);

  const events = [];
  const unsub = EventBus.subscribe(TRAINING_EVENTS.PROGRESSION, (payload) => events.push(payload));

  const report = processWeeklyTraining(player, world);
  unsub();

  assert.equal(report.trained.length, 1);
  assert.equal(report.trained[0].focus, 'boxe');
  assert.ok(report.trained[0].gain > 0, 'gain should be positive for a well-rested fighter');
  assert.equal(fighter.attributes.skills.boxe, 40 + report.trained[0].gain);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], report.trained[0]);
});

test('coach specialization, gym level, equipment and country bonus all increase weekly gain', () => {
  const worldBaseline = new WorldState();
  const baselinePlayer = new PlayerState({ gymName: 'Baseline', equipLevel: 0 });
  const baselineFighter = makeFighter('Baseline Fighter');
  baselineFighter.setTrainingPlan({ focus: 'boxe', intensity: 'NORMAL' });
  baselinePlayer.addFighter(baselineFighter);
  const baselineReport = processWeeklyTraining(baselinePlayer, worldBaseline);

  const worldBoosted = new WorldState();
  const boostedPlayer = new PlayerState({ gymName: 'Boosted', equipLevel: 5 });
  const boostedFighter = makeFighter('Boosted Fighter', { identity: { origin: 'Etats-Unis' } });
  boostedFighter.setTrainingPlan({ focus: 'boxe', intensity: 'NORMAL' });
  boostedPlayer.addFighter(boostedFighter);
  boostedPlayer.addCoach({ name: 'Boxing Coach', skill: 90, specialty: 'boxe' });
  boostedPlayer.addEquipmentItem({ id: 'WEIGHT_ROOM' });
  boostedPlayer.addEquipmentItem({ id: 'OCTAGON_PRO' });
  const boostedReport = processWeeklyTraining(boostedPlayer, worldBoosted);

  assert.ok(
    boostedReport.trained[0].gain > baselineReport.trained[0].gain,
    `boosted gain (${boostedReport.trained[0].gain}) should exceed baseline gain (${baselineReport.trained[0].gain})`
  );
});

test('a specialist coach outperforms a same-skill generalist coach on the matching focus', () => {
  const worldSpecialist = new WorldState();
  const specialistPlayer = new PlayerState({ gymName: 'Specialist' });
  const specialistFighter = makeFighter('Specialist Trainee');
  specialistFighter.setTrainingPlan({ focus: 'sol', intensity: 'NORMAL' });
  specialistPlayer.addFighter(specialistFighter);
  specialistPlayer.addCoach({ name: 'Ground Coach', skill: 80, specialty: 'sol' });
  const specialistReport = processWeeklyTraining(specialistPlayer, worldSpecialist);

  const worldGeneralist = new WorldState();
  const generalistPlayer = new PlayerState({ gymName: 'Generalist' });
  const generalistFighter = makeFighter('Generalist Trainee');
  generalistFighter.setTrainingPlan({ focus: 'sol', intensity: 'NORMAL' });
  generalistPlayer.addFighter(generalistFighter);
  generalistPlayer.addCoach({ name: 'Striking Coach', skill: 80, specialty: 'boxe' });
  const generalistReport = processWeeklyTraining(generalistPlayer, worldGeneralist);

  assert.ok(specialistReport.trained[0].gain > generalistReport.trained[0].gain);
});

test('training hard while form is below the overtraining threshold can cause an injury', () => {
  const player = new PlayerState({ gymName: 'Overtrained Gym' });
  const world = new WorldState();
  const fighter = makeFighter('Exhausted', { attributes: { forme: 20 } });
  fighter.setTrainingPlan({ focus: 'boxe', intensity: 'HARD' });
  player.addFighter(fighter);

  const moraleBefore = fighter.attributes.moral;
  const injuryEvents = [];
  const unsub = EventBus.subscribe(TRAINING_EVENTS.OVERTRAINED_INJURY, (payload) => injuryEvents.push(payload));

  const alwaysTriggers = () => 0.001; // beats every OVERTRAINING chance roll
  const report = processWeeklyTraining(player, world, { rng: alwaysTriggers });
  unsub();

  assert.equal(report.injuries.length, 1);
  assert.equal(injuryEvents.length, 1);
  assert.ok(fighter.medical.injuredUntil > 0, 'fighter should now be marked injured');
  assert.ok(fighter.attributes.moral < moraleBefore, 'an overtraining injury should hurt morale');
});

test('resting never risks an overtraining injury, even at very low form', () => {
  const player = new PlayerState({ gymName: 'Resting Gym' });
  const world = new WorldState();
  const fighter = makeFighter('Resting', { attributes: { forme: 5 } });
  fighter.setTrainingPlan({ focus: 'boxe', intensity: 'REST' });
  player.addFighter(fighter);

  const alwaysTriggers = () => 0.001;
  const report = processWeeklyTraining(player, world, { rng: alwaysTriggers });

  assert.equal(report.injuries.length, 0);
  assert.equal(report.trained.length, 0, 'a resting fighter should not gain skill this week');
  assert.ok(fighter.attributes.forme > 5, 'resting should recover form');
});

test('fighters at or past the decline age lose untrained physical skills each week, but not their focus', () => {
  const player = new PlayerState({ gymName: 'Veteran Gym' });
  const world = new WorldState();
  const fighter = makeFighter('Veteran', { identity: { age: 40 } });
  fighter.setTrainingPlan({ focus: 'boxe', intensity: 'NORMAL' });
  player.addFighter(fighter);

  const declineEvents = [];
  const unsub = EventBus.subscribe(TRAINING_EVENTS.DECLINE, (payload) => declineEvents.push(payload));
  processWeeklyTraining(player, world);
  unsub();

  assert.equal(declineEvents.length, 1);
  assert.ok(fighter.attributes.skills.boxe > 40, 'the focused skill should still grow despite the fighter\'s age');
  assert.ok(fighter.attributes.skills.jambes < 40, 'an unfocused physical skill should decline past the decline age');
  assert.ok(fighter.attributes.skills.intelligence < 40, 'intelligence should decline once past the immunity age (38)');
});

test('intelligence is exempt from decline between the decline age and the mental immunity age', () => {
  const player = new PlayerState({ gymName: 'Young Veteran Gym' });
  const world = new WorldState();
  const fighter = makeFighter('Young Veteran', { identity: { age: 36 } });
  fighter.setTrainingPlan({ focus: 'boxe', intensity: 'NORMAL' });
  player.addFighter(fighter);

  assert.ok(fighter.identity.age >= BALANCE.AGE.DECLINE_START_AGE);
  assert.ok(fighter.identity.age < BALANCE.AGE.MENTAL_ATTRIBUTE_DECLINE_IMMUNITY_AGE);

  processWeeklyTraining(player, world);

  assert.equal(fighter.attributes.skills.intelligence, 40, 'intelligence should not decline below the immunity age');
  assert.ok(fighter.attributes.skills.jambes < 40, 'other physical skills should still decline');
});
