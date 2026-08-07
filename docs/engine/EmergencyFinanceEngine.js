/**
 * engine/EmergencyFinanceEngine.js
 * ---------------------------------------------------------------------------
 * 3 crisis levers (BALANCE.EMERGENCY_FINANCE), offered by web/app.js's Hub
 * once the gym's treasury drops below TREASURY_CRISIS_THRESHOLD — well
 * before ECONOMY.INSOLVENCY's automatic response (coach layoff + reputation
 * hit) kicks in at a much deeper negative balance:
 *
 *   - takePredatoryLoan: an immediate cash injection, repaid at a real loss
 *     (TOTAL_REPAYMENT > PRINCIPAL) over several weeks via the pre-existing
 *     activeDeals weekly-deal mechanism (a negative weeklyAmount — see
 *     PlayerState#addActiveDeal / engine/GymStipulations.js#processActiveDeals,
 *     already wired into every week's resolution).
 *   - fireSaleEquipment: sells one owned item outright for a fraction of
 *     what it cost, permanently losing its bonus.
 *   - the third lever ("combat clandestin underground a haut risque") isn't
 *     a new mechanic: it's engine/UndergroundEngine.js's pre-existing
 *     VALE_TUDO mode, which already carries elevated injury risk and purse —
 *     web/app.js simply routes the player there instead of this module
 *     duplicating combat logic.
 * ---------------------------------------------------------------------------
 */

import BALANCE from '../data/balance.js';

/**
 * @param {Object} playerState
 * @returns {boolean} True once treasury has dropped below TREASURY_CRISIS_THRESHOLD.
 */
export function isTreasuryCrisis(playerState) {
  return playerState.money < BALANCE.EMERGENCY_FINANCE.TREASURY_CRISIS_THRESHOLD;
}

/**
 * Grants an immediate PRINCIPAL cash injection, then schedules
 * WEEKS_TO_REPAY weekly deductions (an activeDeal with a negative
 * weeklyAmount) totalling TOTAL_REPAYMENT — a real loss versus the
 * principal received, the "usurier" part of the loan.
 * @param {Object} playerState
 * @returns {Object} The stored repayment deal record.
 */
export function takePredatoryLoan(playerState) {
  const cfg = BALANCE.EMERGENCY_FINANCE.PREDATORY_LOAN;
  playerState.changeMoney(cfg.PRINCIPAL, 'EMERGENCY_FINANCE:PREDATORY_LOAN');

  const weeklyInstallment = Math.round(cfg.TOTAL_REPAYMENT / cfg.WEEKS_TO_REPAY);
  return playerState.addActiveDeal({
    type: 'PREDATORY_LOAN_REPAYMENT',
    weeklyAmount: -weeklyInstallment,
    weeksRemaining: cfg.WEEKS_TO_REPAY,
  });
}

/**
 * @param {string} equipmentId
 * @returns {number} The fire-sale price for this owned item (0 for an unknown id).
 */
export function getFireSalePrice(equipmentId) {
  const def = BALANCE.EQUIPMENT.DEFINITIONS[equipmentId];
  if (!def) return 0;
  return Math.round(def.purchaseCost * BALANCE.EMERGENCY_FINANCE.EQUIPMENT_FIRE_SALE.SALE_FRACTION_OF_PURCHASE);
}

/**
 * Sells one owned equipment item outright for getFireSalePrice(), removing
 * it (and any bonus/capacity cost it carried) from the gym. No-ops (returns
 * false) if the item isn't owned.
 * @param {Object} playerState
 * @param {string} equipmentId
 * @returns {boolean}
 */
export function fireSaleEquipment(playerState, equipmentId) {
  const price = getFireSalePrice(equipmentId);
  const removed = playerState.removeEquipmentItem(equipmentId);
  if (!removed) return false;

  playerState.changeMoney(price, `EMERGENCY_FINANCE:FIRE_SALE:${equipmentId}`);
  return true;
}

export default {
  isTreasuryCrisis,
  takePredatoryLoan,
  getFireSalePrice,
  fireSaleEquipment,
};
