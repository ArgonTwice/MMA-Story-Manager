/**
 * engine/EconomyEngine.js
 * ---------------------------------------------------------------------------
 * Weekly financial resolution for the player's gym: rent, coach payroll,
 * equipment upkeep, and passive income (memberships/local sponsors), plus
 * an insolvency crisis response when the treasury collapses.
 *
 * Deliberately out of scope here: fighter salaries/contracts (a future
 * ContractEngine's job — BALANCE.ECONOMY.SALARIES.FIGHTER_BASE_WEEKLY is
 * reserved for it). This engine only touches the four line items the gym
 * itself is billed for.
 *
 * Every money/reputation change goes through PlayerState's own mutation
 * methods (changeMoney/changeReputation/removeCoach), which already publish
 * their own granular events — this engine adds the higher-level narrative
 * events layered on top (see ECONOMY_EVENTS).
 * ---------------------------------------------------------------------------
 */

import EventBus from '../core/EventBus.js';
import BALANCE from '../data/balance.js';

/** Event names published on EventBus by EconomyEngine. Import instead of raw strings. */
export const ECONOMY_EVENTS = Object.freeze({
  WEEKLY_PROCESSED: 'economy:weekly_processed',
  INSOLVENT: 'economy:insolvent',
  STAFF_FIRED_AUTOFINANCE: 'economy:staff_fired_autofinance',
});

/**
 * Picks the coach to lay off first during an insolvency crisis: the lowest
 * skill-rated coach (cheapest to have kept, least costly to lose).
 * @param {Object[]} coaches
 * @returns {Object|null}
 */
function pickCoachToLayOff(coaches) {
  if (!coaches || coaches.length === 0) return null;
  return coaches.reduce((worst, coach) => {
    const skill = coach.skill ?? 0;
    const worstSkill = worst?.skill ?? 0;
    return !worst || skill < worstSkill ? coach : worst;
  }, null);
}

/**
 * Processes one week of gym expenses/income for the player.
 *
 * @param {Object} playerState - A PlayerState instance.
 * @returns {Object} The weekly financial summary (also published as ECONOMY_EVENTS.WEEKLY_PROCESSED).
 */
export function processWeeklyExpenses(playerState) {
  const econ = BALANCE.ECONOMY;

  const rent = econ.BASE_WEEKLY_UPKEEP + playerState.equipLevel * econ.UPKEEP_PER_FACILITY_LEVEL;
  const coachPayroll = playerState.coaches.reduce(
    (sum, coach) => sum + (coach.salary ?? econ.SALARIES.COACH_BASE_WEEKLY),
    0
  );
  const equipmentMaintenance = playerState.equipment.reduce((sum, item) => {
    const def = BALANCE.EQUIPMENT.DEFINITIONS[item?.id];
    return sum + (def?.weeklyMaintenanceCost ?? 0);
  }, 0);
  const passiveIncome =
    econ.PASSIVE_INCOME.BASE_WEEKLY +
    playerState.reputation * econ.PASSIVE_INCOME.PER_REPUTATION_POINT +
    playerState.hype * econ.PASSIVE_INCOME.PER_HYPE_POINT;

  if (passiveIncome !== 0) playerState.changeMoney(passiveIncome, 'WEEKLY_PASSIVE_INCOME');
  if (rent !== 0) playerState.changeMoney(-rent, 'WEEKLY_RENT');
  if (coachPayroll !== 0) playerState.changeMoney(-coachPayroll, 'WEEKLY_COACH_PAYROLL');
  if (equipmentMaintenance !== 0) playerState.changeMoney(-equipmentMaintenance, 'WEEKLY_EQUIPMENT_MAINTENANCE');

  const netChange = passiveIncome - rent - coachPayroll - equipmentMaintenance;

  let insolvent = false;
  let firedCoachId = null;

  if (playerState.money < econ.INSOLVENCY.DEBT_THRESHOLD) {
    insolvent = true;

    const coachToFire = pickCoachToLayOff(playerState.coaches);
    if (coachToFire) {
      firedCoachId = coachToFire.id;
      playerState.removeCoach(firedCoachId);
      EventBus.publish(ECONOMY_EVENTS.STAFF_FIRED_AUTOFINANCE, {
        coachId: firedCoachId,
        reason: 'INSOLVENCY',
      });
    }

    playerState.changeReputation(econ.INSOLVENCY.REPUTATION_PENALTY, 'INSOLVENCY_CRISIS');

    EventBus.publish(ECONOMY_EVENTS.INSOLVENT, {
      balance: playerState.money,
      threshold: econ.INSOLVENCY.DEBT_THRESHOLD,
      firedCoachId,
    });
  }

  const summary = {
    rent,
    coachPayroll,
    equipmentMaintenance,
    passiveIncome,
    netChange,
    balanceAfter: playerState.money,
    insolvent,
    firedCoachId,
  };

  EventBus.publish(ECONOMY_EVENTS.WEEKLY_PROCESSED, summary);
  return summary;
}
