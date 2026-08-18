/**
 * engine/AcademyEngine.test.js
 * Run with: node --test engine/AcademyEngine.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import BALANCE from '../data/balance.js';
import Fighter from '../models/Fighter.js';
import { PlayerState } from '../state/PlayerState.js';
import { generateAcademyPool, isAcademyDraftAvailable } from './AcademyEngine.js';

function sequenceRng(values) {
  const queue = [...values];
  return () => (queue.length > 0 ? queue.shift() : 0.5);
}

test('generateAcademyPool returns POOL_SIZE_MIN..POOL_SIZE_MAX real Fighter instances', () => {
  const playerState = new PlayerState();
  for (let seed = 0; seed < 30; seed += 1) {
    let state = seed + 1;
    const rng = () => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state / 0x7fffffff;
    };
    const pool = generateAcademyPool({ playerState, rng });
    assert.ok(pool.length >= BALANCE.ACADEMY_DRAFT.POOL_SIZE_MIN);
    assert.ok(pool.length <= BALANCE.ACADEMY_DRAFT.POOL_SIZE_MAX);
    for (const candidate of pool) {
      assert.ok(candidate.fighter instanceof Fighter);
      assert.ok(Object.keys(BALANCE.ACADEMY_DRAFT.POTENTIAL_TIERS).includes(candidate.potentialKey));
      assert.equal(typeof candidate.potentialLabel, 'string');
      assert.ok(candidate.fighter.identity.age >= BALANCE.ACADEMY_DRAFT.MIN_AGE);
      assert.ok(candidate.fighter.identity.age <= BALANCE.ACADEMY_DRAFT.MAX_AGE);
    }
  }
});

test('V4.5: every academy candidate carries a non-zero weeklySalary priced off BALANCE.RECRUITMENT_MARKET\'s own rating-based curve, even though promoting one is free', () => {
  const playerState = new PlayerState();
  const salaryCfg = BALANCE.RECRUITMENT_MARKET;
  const pool = generateAcademyPool({ playerState, rng: Math.random });

  for (const candidate of pool) {
    assert.equal(typeof candidate.weeklySalary, 'number');
    assert.ok(candidate.weeklySalary > 0, 'a promoted prospect must draw a real wage, not 0$/week');
    const notionalCost = Math.max(
      salaryCfg.MIN_COST,
      salaryCfg.COST_BASE * salaryCfg.COST_GROWTH_PER_RATING_POINT ** candidate.fighter.getOverallRating()
    );
    assert.equal(candidate.weeklySalary, Math.round(notionalCost * salaryCfg.SALARY_RATIO_OF_COST));
  }
});

test('generateAcademyPool produces Fighter-ready personalities (archetype + traits) via generatePersonality', () => {
  const playerState = new PlayerState();
  const pool = generateAcademyPool({ playerState, rng: Math.random });
  for (const { fighter } of pool) {
    assert.ok(Object.keys(BALANCE.PERSONALITY.ARCHETYPES).includes(fighter.psychology.personality.archetype));
  }
});

test('a higher-Reputation, higher-facility-level gym produces a higher average skill mean than a fresh gym', () => {
  const freshGym = new PlayerState({ reputation: 0, equipLevel: 0 });
  const prestigiousGym = new PlayerState({ reputation: 90, equipLevel: 5 });

  function averageSkillMean(playerState) {
    let total = 0;
    let count = 0;
    for (let seed = 0; seed < 40; seed += 1) {
      let state = seed + 100;
      const rng = () => {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        return state / 0x7fffffff;
      };
      const pool = generateAcademyPool({ playerState, rng });
      for (const { fighter } of pool) {
        for (const value of Object.values(fighter.attributes.skills)) {
          total += value;
          count += 1;
        }
      }
    }
    return total / count;
  }

  assert.ok(averageSkillMean(prestigiousGym) > averageSkillMean(freshGym));
});

test('rollPotentialTier (via generateAcademyPool) picks ELITE only on a high roll, and PROMETTEUR on a low roll', () => {
  const playerState = new PlayerState();

  // Roll sequence consumed by generateAcademyPool: [poolSize roll, then per-candidate: potential roll, then 6 skill rolls, age roll, style roll, name rolls..., personality rolls...].
  // Force poolSize to its minimum (roll 0 -> POOL_SIZE_MIN) and the first candidate's potential roll to 0 (PROMETTEUR).
  const lowRng = sequenceRng([0, 0]);
  const lowPool = generateAcademyPool({ playerState, rng: lowRng });
  assert.equal(lowPool[0].potentialKey, 'PROMETTEUR');

  const highRng = sequenceRng([0, 0.99]);
  const highPool = generateAcademyPool({ playerState, rng: highRng });
  assert.equal(highPool[0].potentialKey, 'ELITE');
});

test('isAcademyDraftAvailable is true until recordAcademyDraftOffer is called for that year, then false for the same year and true again next year', () => {
  const playerState = new PlayerState();
  assert.equal(isAcademyDraftAvailable(playerState, 1), true);

  playerState.recordAcademyDraftOffer(1);
  assert.equal(isAcademyDraftAvailable(playerState, 1), false);
  assert.equal(isAcademyDraftAvailable(playerState, 2), true);

  playerState.recordAcademyDraftOffer(2);
  assert.equal(isAcademyDraftAvailable(playerState, 2), false);
});

test('lastAcademyDraftYear round-trips through PlayerState#toJSON/fromJSON', () => {
  const playerState = new PlayerState();
  playerState.recordAcademyDraftOffer(3);

  const restored = PlayerState.fromJSON(playerState.toJSON());
  assert.equal(restored.lastAcademyDraftYear, 3);
  assert.equal(isAcademyDraftAvailable(restored, 3), false);
});
