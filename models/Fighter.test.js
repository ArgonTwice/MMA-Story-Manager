/**
 * models/Fighter.test.js
 * Run with: node --test models/Fighter.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import BALANCE from '../data/balance.js';
import Fighter from './Fighter.js';

function makeFighter(overrides = {}) {
  return new Fighter({
    identity: { name: 'Tester', age: 27 },
    ...overrides,
  });
}

test('a new fighter starts at Fatigue.STARTING_VALUE and an empty weekly plan', () => {
  const fighter = makeFighter();
  assert.equal(fighter.attributes.fatigue, BALANCE.FATIGUE.STARTING_VALUE);
  assert.deepEqual(fighter.weeklyPlan.slots, new Array(BALANCE.WEEKLY_PLANNING.SLOTS_PER_WEEK).fill(null));
  assert.equal(fighter.preparation.tacticalBonusPending, false);
  assert.equal(fighter.preparation.weeklyCharge, 0);
});

test('adjustFatigue clamps to [FATIGUE.MIN, FATIGUE.MAX]', () => {
  const fighter = makeFighter();
  fighter.adjustFatigue(-999);
  assert.equal(fighter.attributes.fatigue, BALANCE.FATIGUE.MIN);
  fighter.adjustFatigue(999);
  assert.equal(fighter.attributes.fatigue, BALANCE.FATIGUE.MAX);
});

test('getReadiness matches the documented formula: 100 - Fatigue + MoralModifier + TacticalBonus - InjuryRisk, clamped', () => {
  const r = BALANCE.READINESS;
  const fighter = makeFighter({ attributes: { forme: 80, moral: 65, fatigue: 40 } });
  fighter.preparation.weeklyCharge = 2;

  const expectedUnclamped =
    100 - 40 + (65 - BALANCE.MORALE.NEUTRAL_VALUE) * r.MORAL_MODIFIER_SCALE + 0 - 2 * r.INJURY_RISK_PER_CHARGE_POINT;
  assert.ok(Math.abs(fighter.getReadiness() - Math.min(r.MAX, Math.max(r.MIN, expectedUnclamped))) < 1e-9);

  fighter.preparation.tacticalBonusPending = true;
  assert.ok(Math.abs(fighter.getReadiness() - Math.min(r.MAX, Math.max(r.MIN, expectedUnclamped + r.TACTICAL_BONUS_POINTS))) < 1e-9);
});

test('getReadiness is clamped to [READINESS.MIN, READINESS.MAX] at the extremes', () => {
  const r = BALANCE.READINESS;
  const exhausted = makeFighter({ attributes: { fatigue: 100, moral: 0 } });
  exhausted.preparation.weeklyCharge = 20;
  assert.equal(exhausted.getReadiness(), r.MIN);

  const pristine = makeFighter({ attributes: { fatigue: 0, moral: 100 } });
  pristine.preparation.tacticalBonusPending = true;
  assert.equal(pristine.getReadiness(), r.MAX);
});

test('clearTacticalPrep clears a pending bonus and reports whether one was pending', () => {
  const fighter = makeFighter();
  assert.equal(fighter.clearTacticalPrep(), false, 'nothing pending yet');

  fighter.preparation.tacticalBonusPending = true;
  assert.equal(fighter.clearTacticalPrep(), true, 'a bonus was pending and just got cleared');
  assert.equal(fighter.preparation.tacticalBonusPending, false);
  assert.equal(fighter.clearTacticalPrep(), false, 'already cleared, nothing pending anymore');
});

test('setWeeklyPlanSlot validates the index and the activity key, and null clears a slot', () => {
  const fighter = makeFighter();

  fighter.setWeeklyPlanSlot(0, 'TECHNIQUE');
  assert.equal(fighter.weeklyPlan.slots[0], 'TECHNIQUE');

  fighter.setWeeklyPlanSlot(0, null);
  assert.equal(fighter.weeklyPlan.slots[0], null);

  assert.throws(() => fighter.setWeeklyPlanSlot(-1, 'TECHNIQUE'), TypeError);
  assert.throws(() => fighter.setWeeklyPlanSlot(BALANCE.WEEKLY_PLANNING.SLOTS_PER_WEEK, 'TECHNIQUE'), TypeError);
  assert.throws(() => fighter.setWeeklyPlanSlot(0, 'NOT_A_REAL_ACTIVITY'), TypeError);
});

test('toJSON/fromJSON round-trips fatigue, weeklyPlan and preparation', () => {
  const fighter = makeFighter({ attributes: { fatigue: 37 } });
  fighter.setWeeklyPlanSlot(0, 'SPARRING');
  fighter.setWeeklyPlanSlot(1, 'PHYSIO_REST');
  fighter.preparation.tacticalBonusPending = true;
  fighter.preparation.weeklyCharge = 4;

  const rebuilt = Fighter.fromJSON(fighter.toJSON());

  assert.equal(rebuilt.attributes.fatigue, 37);
  assert.deepEqual(rebuilt.weeklyPlan.slots, ['SPARRING', 'PHYSIO_REST', null]);
  assert.equal(rebuilt.preparation.tacticalBonusPending, true);
  assert.equal(rebuilt.preparation.weeklyCharge, 4);
});
