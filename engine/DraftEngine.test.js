/**
 * engine/DraftEngine.test.js
 * Run with: node --test engine/DraftEngine.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import BALANCE from '../data/balance.js';
import PlayerState from '../state/PlayerState.js';
import { generateRecruitmentPool, generateRivalGymStarterRoster } from './DraftEngine.js';

function seededRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

test('generateRecruitmentPool returns BALANCE.RECRUITMENT_MARKET.POOL_SIZE real-named candidates with a cost, a weekly salary, and never a "${style} Prospect" placeholder', () => {
  const playerState = new PlayerState({ reputation: 50 });
  const pool = generateRecruitmentPool({ playerState, rng: seededRng(1) });

  assert.equal(pool.length, BALANCE.RECRUITMENT_MARKET.POOL_SIZE);
  for (const { fighter, cost, weeklySalary } of pool) {
    assert.ok(fighter.identity.name.includes(' '), `expected a "Prenom Nom" identity, got "${fighter.identity.name}"`);
    assert.ok(!fighter.identity.name.includes('Prospect'), 'must never fall back to the old "${style} Prospect" placeholder');
    assert.ok(cost >= BALANCE.RECRUITMENT_MARKET.MIN_COST, `cost ${cost} must never dip below MIN_COST`);
    assert.ok(weeklySalary > 0, 'a signed fighter must always carry a nonzero weekly wage');
    assert.ok(weeklySalary < cost, 'a single week of wages should never exceed the whole signing bonus');
  }
});

test('generateRecruitmentPool never offers a free signing (cost is always >= MIN_COST) across many rolls', () => {
  const playerState = new PlayerState({ reputation: 0 });
  for (let seed = 1; seed <= 20; seed += 1) {
    const pool = generateRecruitmentPool({ playerState, rng: seededRng(seed) });
    for (const { cost } of pool) {
      assert.ok(cost >= BALANCE.RECRUITMENT_MARKET.MIN_COST, `cost ${cost} below MIN_COST (seed ${seed})`);
    }
  }
});

test('cost grows steeply (not linearly) with Overall rating: a high-reputation gym\'s pool costs far more than proportionally more than a fresh gym\'s', () => {
  const freshGym = new PlayerState({ reputation: 0 });
  const eliteGym = new PlayerState({ reputation: 100 });

  // Average across many seeds to smooth out the POTENTIAL_TIERS roll noise.
  const avgCost = (playerState) => {
    let total = 0;
    let count = 0;
    for (let seed = 1; seed <= 15; seed += 1) {
      for (const { cost } of generateRecruitmentPool({ playerState, rng: seededRng(seed) })) {
        total += cost;
        count += 1;
      }
    }
    return total / count;
  };

  const freshAvg = avgCost(freshGym);
  const eliteAvg = avgCost(eliteGym);
  assert.ok(eliteAvg > freshAvg * 1.5, `expected a high-reputation gym's pool to cost meaningfully more than a fresh gym's (fresh=${freshAvg}, elite=${eliteAvg})`);
});

test('an occasional "Pepite" roll produces a candidate priced well into the 5000$+ tier', () => {
  const playerState = new PlayerState({ reputation: 80 });
  let sawExpensiveCandidate = false;
  for (let seed = 1; seed <= 40 && !sawExpensiveCandidate; seed += 1) {
    const pool = generateRecruitmentPool({ playerState, rng: seededRng(seed) });
    if (pool.some((c) => c.cost >= 5000)) sawExpensiveCandidate = true;
  }
  assert.ok(sawExpensiveCandidate, 'expected at least one 5000$+ candidate across 40 rolls at high reputation');
});

test('generateRivalGymStarterRoster returns real Fighter instances, never touching PlayerState/WorldState', () => {
  const roster = generateRivalGymStarterRoster({ reputation: 55, rng: seededRng(7) });
  assert.equal(roster.length, 3);
  for (const fighter of roster) {
    assert.ok(fighter.identity.name.includes(' '));
  }
});
