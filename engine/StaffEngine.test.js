/**
 * engine/StaffEngine.test.js
 * Run with: node --test engine/StaffEngine.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import BALANCE from '../data/balance.js';
import Fighter from '../models/Fighter.js';
import PlayerState from '../state/PlayerState.js';
import {
  generateHiringPool,
  hireStaff,
  getHeadCoachMomentumBonus,
  getHeadCoachWeeklyMoraleBonus,
  getScoutingCompetence,
  getStrikingGrapplingMultipliers,
  getPhysioInjuryRiskMultiplier,
  getPhysioStaminaRegenMultiplier,
  applyWeeklyStaffEffects,
  rollStaffConflict,
} from './StaffEngine.js';

function seededRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

test('generateHiringPool returns BALANCE.STAFF.HIRING_POOL_SIZE real-named candidates covering all 3 roles, each with a nonzero salary', () => {
  const pool = generateHiringPool({ reputation: 100, rng: seededRng(1) });
  assert.equal(pool.length, BALANCE.STAFF.HIRING_POOL_SIZE);

  const roles = new Set(pool.map((c) => c.role));
  assert.ok(roles.has('HEAD_COACH'));
  assert.ok(roles.has('STRIKING_GRAPPLING_COACH'));
  assert.ok(roles.has('PHYSIO'));

  const topTier = BALANCE.STAFF.REPUTATION_SKILL_TIERS[BALANCE.STAFF.REPUTATION_SKILL_TIERS.length - 1];
  for (const candidate of pool) {
    assert.ok(candidate.name.includes(' '));
    assert.ok(candidate.salary > 0);
    assert.ok(candidate.skill >= topTier.minSkill && candidate.skill <= topTier.maxSkill);
  }
});

test('generateHiringPool gates the rolled skill range by the gym\'s own Reputation (V3.5)', () => {
  const cfg = BALANCE.STAFF.REPUTATION_SKILL_TIERS;
  const lowTier = cfg[0];
  const highTier = cfg[cfg.length - 1];

  for (let seed = 0; seed < 30; seed += 1) {
    const lowPool = generateHiringPool({ reputation: 0, rng: seededRng(seed) });
    for (const candidate of lowPool) {
      assert.ok(candidate.skill >= lowTier.minSkill && candidate.skill <= lowTier.maxSkill, `low-reputation candidate skill ${candidate.skill} should stay within [${lowTier.minSkill}, ${lowTier.maxSkill}]`);
    }
  }

  let sawHighTierSkill = false;
  for (let seed = 0; seed < 30; seed += 1) {
    const highPool = generateHiringPool({ reputation: 100, rng: seededRng(seed) });
    if (highPool.some((c) => c.skill > lowTier.maxSkill)) sawHighTierSkill = true;
  }
  assert.ok(sawHighTierSkill, 'a max-reputation gym should be able to roll candidates above the lowest tier\'s cap');
});

test('generateHiringPool defaults to the lowest skill tier when reputation is omitted', () => {
  const lowTier = BALANCE.STAFF.REPUTATION_SKILL_TIERS[0];
  const pool = generateHiringPool({ rng: seededRng(1) });
  for (const candidate of pool) {
    assert.ok(candidate.skill >= lowTier.minSkill && candidate.skill <= lowTier.maxSkill);
  }
});

test('a fresh gym with no staff hired has every mechanical bonus at its neutral value', () => {
  const playerState = new PlayerState({ money: 25000 });
  assert.equal(getHeadCoachMomentumBonus(playerState), 0);
  assert.equal(getHeadCoachWeeklyMoraleBonus(playerState), 0);
  assert.equal(getScoutingCompetence(playerState), BALANCE.SCOUTING_FOG.NO_COACH_COMPETENCE);
  assert.deepEqual(getStrikingGrapplingMultipliers(playerState), { STRIKING: 1, CLINCH: 1, GROUND: 1 });
  assert.equal(getPhysioInjuryRiskMultiplier(playerState), 1);
  assert.equal(getPhysioStaminaRegenMultiplier(playerState), 1);
});

test('hireStaff stores the candidate on playerState.coaches, and above-baseline skill produces real, correctly-signed bonuses', () => {
  const playerState = new PlayerState({ money: 25000 });
  const headCoach = hireStaff(playerState, {
    name: 'Coach Above', role: 'HEAD_COACH', specialty: null, skill: 80, salary: 800, relationship: 60,
  });
  assert.equal(playerState.coaches.length, 1);
  assert.equal(playerState.coaches[0].id, headCoach.id);

  assert.ok(getHeadCoachMomentumBonus(playerState) > 0);
  assert.ok(getHeadCoachWeeklyMoraleBonus(playerState) > 0);
  assert.equal(getScoutingCompetence(playerState), 80);
});

test('a Striking specialty coach boosts STRIKING/CLINCH and maluses GROUND; a Grappling specialty does the opposite', () => {
  const strikingGym = new PlayerState({ money: 25000 });
  hireStaff(strikingGym, { name: 'Striker', role: 'STRIKING_GRAPPLING_COACH', specialty: 'STRIKING', skill: 80, salary: 800, relationship: 60 });
  const strikingBonuses = getStrikingGrapplingMultipliers(strikingGym);
  assert.ok(strikingBonuses.STRIKING > 1);
  assert.ok(strikingBonuses.CLINCH > 1);
  assert.ok(strikingBonuses.GROUND < 1);

  const grapplingGym = new PlayerState({ money: 25000 });
  hireStaff(grapplingGym, { name: 'Grappler', role: 'STRIKING_GRAPPLING_COACH', specialty: 'GRAPPLING', skill: 80, salary: 800, relationship: 60 });
  const grapplingBonuses = getStrikingGrapplingMultipliers(grapplingGym);
  assert.ok(grapplingBonuses.GROUND > 1);
  assert.ok(grapplingBonuses.STRIKING < 1);
});

test('a skilled Physio reduces injury risk and boosts stamina regen; both stay neutral (1) for a baseline-skill Physio', () => {
  const skilledGym = new PlayerState({ money: 25000 });
  hireStaff(skilledGym, { name: 'Doc Skilled', role: 'PHYSIO', specialty: null, skill: 90, salary: 900, relationship: 60 });
  assert.ok(getPhysioInjuryRiskMultiplier(skilledGym) < 1);
  assert.ok(getPhysioStaminaRegenMultiplier(skilledGym) > 1);

  const baselineGym = new PlayerState({ money: 25000 });
  hireStaff(baselineGym, { name: 'Doc Baseline', role: 'PHYSIO', specialty: null, skill: BALANCE.STAFF.ROLES.PHYSIO.baselineSkill, salary: 500, relationship: 60 });
  assert.equal(getPhysioInjuryRiskMultiplier(baselineGym), 1);
  assert.equal(getPhysioStaminaRegenMultiplier(baselineGym), 1);
});

test('applyWeeklyStaffEffects raises every roster fighter\'s morale when a good Head Coach is on staff, and no-ops with none hired', () => {
  const playerState = new PlayerState({ money: 25000 });
  const fighterA = new Fighter({ identity: { name: 'A' } });
  const fighterB = new Fighter({ identity: { name: 'B' } });
  playerState.addFighter(fighterA);
  playerState.addFighter(fighterB);

  const noCoachDelta = applyWeeklyStaffEffects(playerState);
  assert.equal(noCoachDelta, 0);
  assert.equal(fighterA.attributes.moral, 50);

  hireStaff(playerState, { name: 'Great Coach', role: 'HEAD_COACH', specialty: null, skill: 90, salary: 900, relationship: 60 });
  const withCoachDelta = applyWeeklyStaffEffects(playerState);
  assert.ok(withCoachDelta > 0);
  assert.ok(fighterA.attributes.moral > 50);
  assert.ok(fighterB.attributes.moral > 50);
});

test('rollStaffConflict never triggers for a Legacy coach (no role), and can trigger for a role-bearing coach with low relationship', () => {
  const playerState = new PlayerState({ money: 25000 });
  playerState.addCoach({ name: 'Legacy Coach', skill: 70, isLegacyCoach: true }); // no `role` — pre-existing system, must be untouched.
  hireStaff(playerState, { name: 'Tense Coach', role: 'HEAD_COACH', specialty: null, skill: 50, salary: 500, relationship: 10 });

  // rng always "triggers" (returns 0) — only the role-bearing, low-relationship coach should ever produce a conflict.
  const conflicts = rollStaffConflict(playerState, () => 0);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].coachName, 'Tense Coach');

  // rng never triggers (returns 1) — no conflicts at all.
  const noConflicts = rollStaffConflict(playerState, () => 1);
  assert.equal(noConflicts.length, 0);
});
