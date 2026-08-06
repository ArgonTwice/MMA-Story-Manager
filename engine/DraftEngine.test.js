/**
 * engine/DraftEngine.test.js
 * Run with: node --test engine/DraftEngine.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import BALANCE from '../data/balance.js';
import PlayerState from '../state/PlayerState.js';
import { generateInitialDraftPool, generateRecruitmentPool } from './DraftEngine.js';

function seededRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

test('generateInitialDraftPool returns BALANCE.INITIAL_DRAFT.POOL_SIZE real-named candidates, each with a positive cost', () => {
  const pool = generateInitialDraftPool({ rng: seededRng(1) });

  assert.equal(pool.length, BALANCE.INITIAL_DRAFT.POOL_SIZE);
  for (const { fighter, cost } of pool) {
    assert.ok(fighter.identity.name.includes(' '), `expected a "Prenom Nom" identity, got "${fighter.identity.name}"`);
    assert.ok(!fighter.identity.name.includes('Prospect'), 'must never fall back to the old "${style} Prospect" placeholder');
    assert.ok(cost > 0);
    assert.ok(fighter.identity.age >= BALANCE.INITIAL_DRAFT.MIN_AGE && fighter.identity.age <= BALANCE.INITIAL_DRAFT.MAX_AGE);
  }
});

test('generateInitialDraftPool never touches PlayerState/WorldState — pure generation only', () => {
  const pool = generateInitialDraftPool({ rng: seededRng(2) });
  assert.equal(pool.length, BALANCE.INITIAL_DRAFT.POOL_SIZE);
  // Nothing to assert on state here by construction (the function signature
  // takes no playerState/worldState) — this test documents the contract.
});

test('generateRecruitmentPool scales candidate cost with the gym\'s own Reputation, same "State drives generation" precedent as AcademyEngine', () => {
  const lowRepState = new PlayerState({ reputation: 0 });
  const highRepState = new PlayerState({ reputation: 100 });

  const lowPool = generateRecruitmentPool({ playerState: lowRepState, rng: seededRng(3) });
  const highPool = generateRecruitmentPool({ playerState: highRepState, rng: seededRng(3) });

  const avgCost = (pool) => pool.reduce((sum, c) => sum + c.cost, 0) / pool.length;
  assert.ok(avgCost(highPool) > avgCost(lowPool), 'a higher-reputation gym should attract costlier (sharper) recruits on average');
});

test('generateRecruitmentPool returns BALANCE.RECRUITMENT_MARKET.POOL_SIZE candidates', () => {
  const playerState = new PlayerState({ reputation: 50 });
  const pool = generateRecruitmentPool({ playerState, rng: seededRng(4) });
  assert.equal(pool.length, BALANCE.RECRUITMENT_MARKET.POOL_SIZE);
});
