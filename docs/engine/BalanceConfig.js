/**
 * engine/BalanceConfig.js
 * ---------------------------------------------------------------------------
 * A single reference surface over the game's economy/balance constants,
 * built for anything that wants to READ or DISPLAY balance data without
 * reaching into data/balance.js's many sub-sections individually — e.g. a
 * pre-fight odds readout, a fighter profile's "projected decline" line, or
 * tools/BalanceSimulation.test.js's 50-season validator.
 *
 * This module does NOT introduce new gameplay rules. Every function here is
 * either:
 *   (a) a pure re-export/lookup of numbers that already live in
 *       data/balance.js (SALARY_GRID, LEAGUE_PURSE_TABLE, EQUIPMENT_CATALOG), or
 *   (b) a reference-only computation explicitly NOT wired into the engines
 *       that actually run the game (computeWinProbability,
 *       getAgeDeclineAnnualRate) — see BALANCE.WIN_PROBABILITY and
 *       BALANCE.AGE.DECLINE_CURVE_REFERENCE's own doc comments for why.
 *       CombatEngine's round-by-round simulation and ProgressionEngine's
 *       actual weekly attribute decline remain the sole authority over what
 *       really happens; this module never feeds back into them.
 * ---------------------------------------------------------------------------
 */

import BALANCE from '../data/balance.js';
import { getPurseMultiplier, getPassiveIncomeMultiplier } from './LeagueEngine.js';

/** Re-export of BALANCE.EQUIPMENT.DEFINITIONS — every equipment item's purchase/upkeep/bonus numbers in one place. */
export const EQUIPMENT_CATALOG = BALANCE.EQUIPMENT.DEFINITIONS;

/** Re-export of BALANCE.LEAGUE_PYRAMID.TIERS — the 3 competitive tiers' reputation thresholds and purse/passive-income multipliers. */
export const LEAGUE_PURSE_TABLE = BALANCE.LEAGUE_PYRAMID.TIERS;

/** Fighter/coach/staff weekly salary tiers (BALANCE.ECONOMY.SALARIES + BALANCE.STAFF role base costs) in one grid. */
export const SALARY_GRID = Object.freeze({
  FIGHTER: BALANCE.ECONOMY.SALARIES.FIGHTER_BASE_WEEKLY,
  LEGACY_COACH_BASE_WEEKLY: BALANCE.ECONOMY.SALARIES.COACH_BASE_WEEKLY,
  STAFF_BASE_WEEKLY: BALANCE.ECONOMY.SALARIES.STAFF_BASE_WEEKLY,
  STAFF_SALARY_BASE_WEEKLY: BALANCE.STAFF.SALARY_BASE_WEEKLY,
  STAFF_SALARY_PER_SKILL_POINT: BALANCE.STAFF.SALARY_PER_SKILL_POINT,
});

/**
 * P(A beats B) under the spec's logistic (Elo-style) formula:
 *   P = 1 / (1 + 10 ^ ((OverallB - OverallA) / RATING_DIVISOR))
 * A display/analysis-only pre-fight estimate — see this file's header.
 *
 * @param {number} overallA
 * @param {number} overallB
 * @returns {number} 0-1.
 */
export function computeWinProbability(overallA, overallB) {
  const divisor = BALANCE.WIN_PROBABILITY.RATING_DIVISOR;
  return 1 / (1 + 10 ** ((overallB - overallA) / divisor));
}

/**
 * Convenience wrapper around computeWinProbability() for two live Fighter
 * instances, reading their current getOverallRating().
 * @param {Object} fighterA
 * @param {Object} fighterB
 * @returns {number} 0-1.
 */
export function computeFightWinProbability(fighterA, fighterB) {
  return computeWinProbability(fighterA.getOverallRating(), fighterB.getOverallRating());
}

/**
 * The reference annual attribute-decline RATE at a given age, per
 * BALANCE.AGE.DECLINE_CURVE_REFERENCE (0 below 28, 2%/an from 28,
 * accelerating to 5%/an from 35) — display-only, see this file's header.
 * @param {number} age
 * @returns {number} 0, 0.02, or 0.05.
 */
export function getAgeDeclineAnnualRate(age) {
  const curve = BALANCE.AGE.DECLINE_CURVE_REFERENCE;
  if (age >= curve.STEEP_DECLINE_START_AGE) return curve.STEEP_ANNUAL_RATE;
  if (age >= curve.EARLY_DECLINE_START_AGE) return curve.EARLY_ANNUAL_RATE;
  return 0;
}

/**
 * How many weeks of an assumed extra weekly revenue/value an equipment
 * purchase takes to pay for itself, ignoring its own ongoing weekly
 * maintenance cost (i.e. payback of the purchaseCost alone) — a rough
 * "ROI d'equipement" readout, not a mechanic.
 * @param {string} equipmentId
 * @param {number} weeklyValueEstimate - Assumed weekly value gained (money-equivalent), > 0.
 * @returns {number|null} Weeks to break even, or null for an unknown item or a non-positive estimate.
 */
export function getEquipmentPaybackWeeks(equipmentId, weeklyValueEstimate) {
  const def = EQUIPMENT_CATALOG[equipmentId];
  if (!def || weeklyValueEstimate <= 0) return null;
  return def.purchaseCost / weeklyValueEstimate;
}

/**
 * @param {Object} playerState
 * @returns {{ tier: Object, purseMultiplier: number, passiveIncomeMultiplier: number }}
 *   The gym's current league tier alongside both of LeagueEngine's own
 *   multipliers, bundled for a single-call balance readout.
 */
export function getLeagueEconomySnapshot(playerState) {
  return {
    tier: LEAGUE_PURSE_TABLE[playerState.leagueTier] ?? LEAGUE_PURSE_TABLE[BALANCE.LEAGUE_PYRAMID.TIER_ORDER[0]],
    purseMultiplier: getPurseMultiplier(playerState),
    passiveIncomeMultiplier: getPassiveIncomeMultiplier(playerState),
  };
}

export default {
  EQUIPMENT_CATALOG,
  LEAGUE_PURSE_TABLE,
  SALARY_GRID,
  computeWinProbability,
  computeFightWinProbability,
  getAgeDeclineAnnualRate,
  getEquipmentPaybackWeeks,
  getLeagueEconomySnapshot,
};
