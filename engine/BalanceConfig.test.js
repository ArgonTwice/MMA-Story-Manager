/**
 * engine/BalanceConfig.test.js
 * Run with: node --test engine/BalanceConfig.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import BALANCE from '../data/balance.js';
import Fighter from '../models/Fighter.js';
import PlayerState from '../state/PlayerState.js';
import {
  EQUIPMENT_CATALOG,
  LEAGUE_PURSE_TABLE,
  SALARY_GRID,
  computeWinProbability,
  computeFightWinProbability,
  getAgeDeclineAnnualRate,
  getEquipmentPaybackWeeks,
  getLeagueEconomySnapshot,
} from './BalanceConfig.js';

function makeFighter(overrides = {}) {
  return new Fighter({
    identity: { name: 'BC Fighter', age: 27, style: 'Freestyle', weightClass: 'Lightweight', ...overrides.identity },
    attributes: overrides.attributes,
  });
}

test('EQUIPMENT_CATALOG/LEAGUE_PURSE_TABLE/SALARY_GRID are pure re-exports of the underlying BALANCE data', () => {
  assert.equal(EQUIPMENT_CATALOG, BALANCE.EQUIPMENT.DEFINITIONS);
  assert.equal(LEAGUE_PURSE_TABLE, BALANCE.LEAGUE_PYRAMID.TIERS);
  assert.equal(SALARY_GRID.FIGHTER, BALANCE.ECONOMY.SALARIES.FIGHTER_BASE_WEEKLY);
  assert.equal(SALARY_GRID.STAFF_SALARY_BASE_WEEKLY, BALANCE.STAFF.SALARY_BASE_WEEKLY);
});

test('computeWinProbability is exactly 0.5 for equal ratings, and favors the higher-rated fighter otherwise', () => {
  assert.equal(computeWinProbability(70, 70), 0.5);
  assert.ok(computeWinProbability(80, 60) > 0.5);
  assert.ok(computeWinProbability(60, 80) < 0.5);
});

test('computeWinProbability follows the spec formula verbatim (RATING_DIVISOR = 20)', () => {
  const expected = 1 / (1 + 10 ** ((60 - 80) / BALANCE.WIN_PROBABILITY.RATING_DIVISOR));
  assert.ok(Math.abs(computeWinProbability(80, 60) - expected) < 1e-9);
});

test('computeFightWinProbability reads both fighters\' live getOverallRating()', () => {
  const strong = makeFighter({ attributes: { skills: { boxe: 90, jambes: 90, sol: 90, soumission: 90, cardio: 90, intelligence: 90 } } });
  const weak = makeFighter({ attributes: { skills: { boxe: 20, jambes: 20, sol: 20, soumission: 20, cardio: 20, intelligence: 20 } } });
  assert.equal(computeFightWinProbability(strong, weak), computeWinProbability(strong.getOverallRating(), weak.getOverallRating()));
  assert.ok(computeFightWinProbability(strong, weak) > 0.5);
});

test('getAgeDeclineAnnualRate is 0 below 28, 2%/an from 28, and 5%/an from 35', () => {
  assert.equal(getAgeDeclineAnnualRate(20), 0);
  assert.equal(getAgeDeclineAnnualRate(27), 0);
  assert.equal(getAgeDeclineAnnualRate(28), BALANCE.AGE.DECLINE_CURVE_REFERENCE.EARLY_ANNUAL_RATE);
  assert.equal(getAgeDeclineAnnualRate(34), BALANCE.AGE.DECLINE_CURVE_REFERENCE.EARLY_ANNUAL_RATE);
  assert.equal(getAgeDeclineAnnualRate(35), BALANCE.AGE.DECLINE_CURVE_REFERENCE.STEEP_ANNUAL_RATE);
  assert.equal(getAgeDeclineAnnualRate(50), BALANCE.AGE.DECLINE_CURVE_REFERENCE.STEEP_ANNUAL_RATE);
});

test('getEquipmentPaybackWeeks divides purchaseCost by the assumed weekly value, and null-guards bad inputs', () => {
  const def = EQUIPMENT_CATALOG.HEAVY_BAGS;
  assert.equal(getEquipmentPaybackWeeks('HEAVY_BAGS', 100), def.purchaseCost / 100);
  assert.equal(getEquipmentPaybackWeeks('NOT_A_REAL_ITEM', 100), null);
  assert.equal(getEquipmentPaybackWeeks('HEAVY_BAGS', 0), null);
  assert.equal(getEquipmentPaybackWeeks('HEAVY_BAGS', -5), null);
});

test('getLeagueEconomySnapshot bundles the current tier with both League purse/passive-income multipliers', () => {
  const playerState = new PlayerState({ money: 25000 });
  const snapshot = getLeagueEconomySnapshot(playerState);
  assert.equal(snapshot.tier.id, BALANCE.LEAGUE_PYRAMID.TIER_ORDER[0]);
  assert.equal(snapshot.purseMultiplier, 1);
  assert.equal(snapshot.passiveIncomeMultiplier, 1);
});
