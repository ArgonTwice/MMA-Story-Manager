/**
 * data/leagues.test.js
 * Run with: node --test data/leagues.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import BALANCE from './balance.js';
import { LEAGUES, LEAGUE_IDS, resolveLeagueForReputation } from './leagues.js';

test('exactly 4 leagues are defined, each with a valid BASE_FIGHT_PURSE tier and a distinct prestige tier', () => {
  assert.equal(LEAGUE_IDS.length, 4);
  const seenTiers = new Set();
  for (const league of Object.values(LEAGUES)) {
    assert.ok(league.purseTier in BALANCE.ECONOMY.BASE_FIGHT_PURSE, `${league.id}: unknown purseTier "${league.purseTier}"`);
    assert.ok(!seenTiers.has(league.tier), `duplicate tier ${league.tier}`);
    seenTiers.add(league.tier);
  }
});

test('resolveLeagueForReputation returns the highest-tier league the reputation qualifies for', () => {
  assert.equal(resolveLeagueForReputation(0).id, 'UNDERGROUND_CIRCUIT');
  assert.equal(resolveLeagueForReputation(24).id, 'UNDERGROUND_CIRCUIT');
  assert.equal(resolveLeagueForReputation(25).id, 'RISING_WARRIORS');
  assert.equal(resolveLeagueForReputation(54).id, 'RISING_WARRIORS');
  assert.equal(resolveLeagueForReputation(55).id, 'IRON_CAGE');
  assert.equal(resolveLeagueForReputation(79).id, 'IRON_CAGE');
  assert.equal(resolveLeagueForReputation(80).id, 'ELITE_CHAMPIONSHIP');
  assert.equal(resolveLeagueForReputation(100).id, 'ELITE_CHAMPIONSHIP');
});

test('resolveLeagueForReputation never returns null/undefined, even for an out-of-range negative reputation', () => {
  const league = resolveLeagueForReputation(-50);
  assert.equal(league.id, 'UNDERGROUND_CIRCUIT');
});
