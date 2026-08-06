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

test('a new fighter starts at PHYSICAL_FATIGUE/MENTAL_FATIGUE.STARTING_VALUE and an empty weekly plan', () => {
  const fighter = makeFighter();
  assert.equal(fighter.attributes.physicalFatigue, BALANCE.PHYSICAL_FATIGUE.STARTING_VALUE);
  assert.equal(fighter.attributes.mentalFatigue, BALANCE.MENTAL_FATIGUE.STARTING_VALUE);
  assert.deepEqual(fighter.weeklyPlan.slots, new Array(BALANCE.WEEKLY_PLANNING.SLOTS_PER_WEEK).fill(null));
  assert.equal(fighter.preparation.tacticalBonusPending, false);
  assert.equal(fighter.preparation.weeklyCharge, 0);
});

test('adjustPhysicalFatigue/adjustMentalFatigue each clamp to their own [MIN, MAX], independently', () => {
  const fighter = makeFighter();
  fighter.adjustPhysicalFatigue(-999);
  assert.equal(fighter.attributes.physicalFatigue, BALANCE.PHYSICAL_FATIGUE.MIN);
  fighter.adjustPhysicalFatigue(999);
  assert.equal(fighter.attributes.physicalFatigue, BALANCE.PHYSICAL_FATIGUE.MAX);

  fighter.adjustMentalFatigue(-999);
  assert.equal(fighter.attributes.mentalFatigue, BALANCE.MENTAL_FATIGUE.MIN);
  fighter.adjustMentalFatigue(999);
  assert.equal(fighter.attributes.mentalFatigue, BALANCE.MENTAL_FATIGUE.MAX);
});

test('getReadiness matches the documented v2 formula: 100 - (0.6*PhysicalFatigue + 0.4*MentalFatigue) + MoralModifier + TacticalBonus - InjuryRisk, clamped', () => {
  const r = BALANCE.READINESS;
  const fighter = makeFighter({ attributes: { forme: 80, moral: 65, physicalFatigue: 40, mentalFatigue: 20 } });
  fighter.preparation.weeklyCharge = 2;

  const blendedFatigue = r.PHYSICAL_FATIGUE_WEIGHT * 40 + r.MENTAL_FATIGUE_WEIGHT * 20;
  const expectedUnclamped =
    100 - blendedFatigue + (65 - BALANCE.MORALE.NEUTRAL_VALUE) * r.MORAL_MODIFIER_SCALE + 0 - 2 * r.INJURY_RISK_PER_CHARGE_POINT;
  assert.ok(Math.abs(fighter.getReadiness() - Math.min(r.MAX, Math.max(r.MIN, expectedUnclamped))) < 1e-9);

  fighter.preparation.tacticalBonusPending = true;
  assert.ok(Math.abs(fighter.getReadiness() - Math.min(r.MAX, Math.max(r.MIN, expectedUnclamped + r.TACTICAL_BONUS_POINTS))) < 1e-9);
});

test('getReadiness is clamped to [READINESS.MIN, READINESS.MAX] at the extremes of both Fatigue gauges', () => {
  const r = BALANCE.READINESS;
  const exhausted = makeFighter({ attributes: { physicalFatigue: 100, mentalFatigue: 100, moral: 0 } });
  exhausted.preparation.weeklyCharge = 20;
  assert.equal(exhausted.getReadiness(), r.MIN);

  const pristine = makeFighter({ attributes: { physicalFatigue: 0, mentalFatigue: 0, moral: 100 } });
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

test('toJSON/fromJSON round-trips both Fatigue gauges, weeklyPlan and preparation', () => {
  const fighter = makeFighter({ attributes: { physicalFatigue: 37, mentalFatigue: 22 } });
  fighter.setWeeklyPlanSlot(0, 'SPARRING');
  fighter.setWeeklyPlanSlot(1, 'PHYSIO_REST');
  fighter.preparation.tacticalBonusPending = true;
  fighter.preparation.weeklyCharge = 4;

  const rebuilt = Fighter.fromJSON(fighter.toJSON());

  assert.equal(rebuilt.attributes.physicalFatigue, 37);
  assert.equal(rebuilt.attributes.mentalFatigue, 22);
  assert.deepEqual(rebuilt.weeklyPlan.slots, ['SPARRING', 'PHYSIO_REST', null]);
  assert.equal(rebuilt.preparation.tacticalBonusPending, true);
  assert.equal(rebuilt.preparation.weeklyCharge, 4);
});

// ---- Phase 4.2 ("Memoire du Monde, Legacy Engine & Attachement au Roster") -

test('recordFightResult classifies a KO win into both finishes and koWins, and starts a win streak', () => {
  const fighter = makeFighter();
  fighter.recordFightResult({ outcome: 'win', byFinish: true, finishMethod: 'KO' });

  assert.equal(fighter.career.wins, 1);
  assert.equal(fighter.career.finishes, 1);
  assert.equal(fighter.career.koWins, 1);
  assert.equal(fighter.career.tkoWins, 0);
  assert.equal(fighter.career.submissionWins, 0);
  assert.equal(fighter.career.decisionWins, 0);
  assert.equal(fighter.career.currentWinStreak, 1);
  assert.equal(fighter.career.longestWinStreak, 1);
});

test('TKO and DOCTOR_STOPPAGE both classify into tkoWins; SUBMISSION into submissionWins', () => {
  const tkoFighter = makeFighter();
  tkoFighter.recordFightResult({ outcome: 'win', byFinish: true, finishMethod: 'TKO' });
  assert.equal(tkoFighter.career.tkoWins, 1);

  const doctorStoppageFighter = makeFighter();
  doctorStoppageFighter.recordFightResult({ outcome: 'win', byFinish: true, finishMethod: 'DOCTOR_STOPPAGE' });
  assert.equal(doctorStoppageFighter.career.tkoWins, 1);

  const subFighter = makeFighter();
  subFighter.recordFightResult({ outcome: 'win', byFinish: true, finishMethod: 'SUBMISSION' });
  assert.equal(subFighter.career.submissionWins, 1);
});

test('a decision win (byFinish=false) increments decisionWins, not finishes', () => {
  const fighter = makeFighter();
  fighter.recordFightResult({ outcome: 'win', byFinish: false });

  assert.equal(fighter.career.wins, 1);
  assert.equal(fighter.career.finishes, 0);
  assert.equal(fighter.career.decisionWins, 1);
});

test('currentWinStreak resets to 0 on a loss or a draw, but longestWinStreak remembers the peak', () => {
  const fighter = makeFighter();
  for (let i = 0; i < 4; i += 1) fighter.recordFightResult({ outcome: 'win', byFinish: false });
  assert.equal(fighter.career.currentWinStreak, 4);
  assert.equal(fighter.career.longestWinStreak, 4);

  fighter.recordFightResult({ outcome: 'loss' });
  assert.equal(fighter.career.currentWinStreak, 0);
  assert.equal(fighter.career.longestWinStreak, 4, 'the peak should not be forgotten after the streak ends');

  fighter.recordFightResult({ outcome: 'win', byFinish: false });
  fighter.recordFightResult({ outcome: 'draw' });
  assert.equal(fighter.career.currentWinStreak, 0);
  assert.equal(fighter.career.longestWinStreak, 4);
});

test('a comeback win increments comebackWins; a normal win does not', () => {
  const fighter = makeFighter();
  fighter.recordFightResult({ outcome: 'win', byFinish: false, comeback: true });
  fighter.recordFightResult({ outcome: 'win', byFinish: false, comeback: false });

  assert.equal(fighter.career.comebackWins, 1);
});

test('evaluateNickname adopts "The Hammer" once koWins reaches 5, and never regresses it afterward', () => {
  const fighter = makeFighter();
  for (let i = 0; i < 4; i += 1) fighter.recordFightResult({ outcome: 'win', byFinish: true, finishMethod: 'KO' });
  assert.equal(fighter.identity.nickname, null, 'sanity: 4 KOs should not be enough yet');

  fighter.recordFightResult({ outcome: 'win', byFinish: true, finishMethod: 'KO' });
  assert.equal(fighter.identity.nickname, 'The Hammer');

  fighter.recordFightResult({ outcome: 'loss' });
  assert.equal(fighter.identity.nickname, 'The Hammer', 'a nickname, once earned, must not be un-earned by a loss');
});

test('evaluateNickname prefers the higher-priority PHOENIX rule over an already-earned lower-priority THE_HAMMER', () => {
  const fighter = makeFighter();
  for (let i = 0; i < 5; i += 1) fighter.recordFightResult({ outcome: 'win', byFinish: true, finishMethod: 'KO' });
  assert.equal(fighter.identity.nickname, 'The Hammer');

  fighter.recordFightResult({ outcome: 'win', byFinish: false, comeback: true });
  fighter.recordFightResult({ outcome: 'win', byFinish: false, comeback: true });
  assert.equal(fighter.identity.nickname, 'Phoenix', 'PHOENIX (priority 30) should outrank THE_HAMMER (priority 20) once both match');
});

test('evaluateNickname adopts "The Technician" once decisionWins reaches 10', () => {
  // A loss part-way through breaks the win streak so this test isolates
  // decisionWins from UNSTOPPABLE (priority 25, longestWinStreak >= 10) —
  // 10 decision wins in an UNBROKEN row would legitimately earn both at
  // once, and the higher-priority one would win.
  const fighter = makeFighter();
  for (let i = 0; i < 5; i += 1) fighter.recordFightResult({ outcome: 'win', byFinish: false });
  fighter.recordFightResult({ outcome: 'loss' });
  for (let i = 0; i < 4; i += 1) fighter.recordFightResult({ outcome: 'win', byFinish: false });
  assert.equal(fighter.identity.nickname, null, 'sanity: 9 decision wins (streak broken once) should not be enough yet');

  fighter.recordFightResult({ outcome: 'win', byFinish: false });
  assert.equal(fighter.identity.nickname, 'The Technician');
});

// ---- Phase 4.4 ("Playtests, Polish, Long-Term Economics & Release Candidate") --

test('evaluateNickname adopts "Unstoppable" once longestWinStreak reaches 10, outranking "The Technician" earned the same fight', () => {
  const fighter = makeFighter();
  for (let i = 0; i < 9; i += 1) fighter.recordFightResult({ outcome: 'win', byFinish: false });
  assert.equal(fighter.identity.nickname, null, 'sanity: a 9-fight streak should not be enough yet');

  fighter.recordFightResult({ outcome: 'win', byFinish: false });
  assert.equal(
    fighter.identity.nickname,
    'Unstoppable',
    'UNSTOPPABLE (priority 25) should outrank THE_TECHNICIAN (priority 10), both earned on this exact win'
  );
});

test('evaluateNickname adopts "The Silencer" once submissionWins reaches 5', () => {
  const fighter = makeFighter();
  for (let i = 0; i < 4; i += 1) fighter.recordFightResult({ outcome: 'win', byFinish: true, finishMethod: 'SUBMISSION' });
  assert.equal(fighter.identity.nickname, null);

  fighter.recordFightResult({ outcome: 'win', byFinish: true, finishMethod: 'SUBMISSION' });
  assert.equal(fighter.identity.nickname, 'The Silencer');
});

test('evaluateNickname adopts "The Finisher" once tkoWins reaches 5, and DOCTOR_STOPPAGE wins count toward it too', () => {
  const fighter = makeFighter();
  for (let i = 0; i < 4; i += 1) fighter.recordFightResult({ outcome: 'win', byFinish: true, finishMethod: 'TKO' });
  assert.equal(fighter.identity.nickname, null);

  fighter.recordFightResult({ outcome: 'win', byFinish: true, finishMethod: 'DOCTOR_STOPPAGE' });
  assert.equal(fighter.identity.nickname, 'The Finisher');
});

test('evaluateNickname adopts "The Ironman" for a well-rounded record that stays under every OTHER rule\'s own bar', () => {
  // 4 KO + 4 TKO + 4 SUBMISSION + 3 decisions = 15 wins, each bucket
  // strictly below its own rule's minValue (5/5/5/10) — and a loss after
  // every win keeps longestWinStreak at 1, well under UNSTOPPABLE's 10.
  const fighter = makeFighter();
  const methods = [
    ...Array(4).fill('KO'),
    ...Array(4).fill('TKO'),
    ...Array(4).fill('SUBMISSION'),
  ];
  for (const method of methods) {
    fighter.recordFightResult({ outcome: 'win', byFinish: true, finishMethod: method });
    fighter.recordFightResult({ outcome: 'loss' });
  }
  for (let i = 0; i < 3; i += 1) {
    fighter.recordFightResult({ outcome: 'win', byFinish: false });
    fighter.recordFightResult({ outcome: 'loss' });
  }

  assert.equal(fighter.career.wins, 15);
  assert.equal(fighter.career.koWins, 4);
  assert.equal(fighter.career.tkoWins, 4);
  assert.equal(fighter.career.submissionWins, 4);
  assert.equal(fighter.career.decisionWins, 3);
  assert.equal(fighter.identity.nickname, 'The Ironman');
});

test('toJSON/fromJSON round-trips the Phase 4.2 identity/career fields', () => {
  const fighter = makeFighter();
  for (let i = 0; i < 5; i += 1) fighter.recordFightResult({ outcome: 'win', byFinish: true, finishMethod: 'KO' });

  const rebuilt = Fighter.fromJSON(fighter.toJSON());

  assert.equal(rebuilt.identity.nickname, 'The Hammer');
  assert.equal(rebuilt.career.koWins, 5);
  assert.equal(rebuilt.career.longestWinStreak, 5);
  assert.equal(rebuilt.career.currentWinStreak, 5);
});
