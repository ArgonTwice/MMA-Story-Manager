/**
 * engine/FightWeekEngine.js — V3.6/V3.7 ("Fight Week" + "Fight Launch Contract")
 * ---------------------------------------------------------------------------
 * Owns the "Fight Launch Contract": a booked Combat-tab fight is never
 * simulated the instant an opponent is picked. Since V3.7, the booking's
 * date and opponent both come from engine/LeagueEngine.js#registerForGala
 * (the player registers onto an open weight-class slot of an upcoming
 * Gala — see BALANCE.GALA_CIRCUIT — and the opponent is drawn from a
 * global pool) — scheduleFight() here is the low-level contract builder
 * that call site hands off to, locking the opponent in as a plain JSON
 * snapshot (opponentSnapshot) taken at signup time. Deliberately NEVER
 * re-derived from a live rival-gym roster afterward: over a multi-week
 * gap that roster can legitimately change (autonomous TransferMarket
 * churn, a Mercato buyout/poach), and a signed contract shouldn't quietly
 * evaporate or point at the wrong fighter because of it.
 *
 * Between signing and fight day, this module manages the week-by-week run-up:
 *   - A weekly Training Camp orientation (Sparring Intensif / Analyse Video /
 *     Cardio Focus) for the booked fighter, applied instead of their normal
 *     Planning-tab slots for as long as the fight is booked and it isn't
 *     fight week yet (real camps taper off in the final week).
 *   - Once fight week starts (the final BALANCE.CALENDAR.DAYS_PER_WEEK days
 *     before the booked date), a Weight Cut choice (a friendlier 3-tier
 *     relabeling of 3 of BALANCE.WEIGH_IN.PROFILES's existing 4 keys — the
 *     SAME missed-weight mechanic CombatEngine already resolves at its own
 *     WEIGH_IN phase, just chosen earlier) and a one-off Logistics
 *     (transport/hotel) choice that nudges the fighter's Fatigue/Moral
 *     going into the bout.
 *
 * Only ONE fight can be booked at a time (PlayerState#scheduledFight) —
 * Underground Circuit challenges are untouched by any of this and stay
 * instant, matching their own "clandestine, no formalities" identity.
 * ---------------------------------------------------------------------------
 */

import BALANCE from '../data/balance.js';

const DAYS_PER_WEEK = BALANCE.CALENDAR.DAYS_PER_WEEK;

/**
 * Books a new Fight Launch Contract, replacing any previous booking. Pure
 * record construction — never simulates anything itself (see web/app.js's
 * _launchFight, called once the booked date is actually reached). The
 * caller (engine/LeagueEngine.js#registerForGala) is the source of truth
 * for WHEN (fightDay, from the chosen Gala) and WHO (opponentSnapshot,
 * drawn from the global pool) — this function only locks that decision in.
 *
 * @param {Object} playerState
 * @param {Object} worldState
 * @param {Object} options
 * @param {string} options.fighterId - The player's own booked fighter.
 * @param {Object} options.opponentSnapshot - Fighter#toJSON() of the drawn opponent, locked in for good — never re-derived from a live roster.
 * @param {string|null} [options.gymId] - The opponent's originating rival gym, for display only — null for an independent (gym-less) opponent.
 * @param {string|null} [options.galaId] - Which Gala this booking is part of, or null.
 * @param {string} options.orgId - Sanctioning org (see BALANCE.GALA_CIRCUIT.ORGANIZATIONS).
 * @param {number} options.fightDay - worldState.currentDay this booking resolves on.
 * @param {boolean} [options.isTitle]
 * @param {Object|null} [options.rules] - Press-conference-derived rules (e.g. { purseMultiplier }), or null.
 * @returns {Object} The stored Fight Launch Contract.
 */
export function scheduleFight(playerState, worldState, options) {
  const { fighterId, opponentSnapshot, gymId = null, galaId = null, orgId, fightDay, isTitle = false, rules = null } = options;
  const cfg = BALANCE.FIGHT_WEEK;

  return playerState.setScheduledFight({
    fighterId,
    opponentSnapshot: { ...opponentSnapshot },
    opponentId: opponentSnapshot.identity.id,
    gymId,
    galaId,
    orgId,
    isTitle,
    rules,
    scheduledDay: worldState.currentDay,
    fightDay,
    campOrientation: cfg.DEFAULT_CAMP_ORIENTATION,
    campLog: [],
    weightCutChoice: null,
    logisticsChoice: null,
  });
}

/**
 * @param {Object} scheduledFight
 * @param {number} currentDay
 * @returns {number} Days remaining until the booked fight, floored at 0.
 */
export function getDaysUntilFight(scheduledFight, currentDay) {
  return Math.max(0, scheduledFight.fightDay - currentDay);
}

/** @returns {boolean} True once the booking has entered its final (taper) week. */
export function isFightWeek(scheduledFight, currentDay) {
  return getDaysUntilFight(scheduledFight, currentDay) <= DAYS_PER_WEEK;
}

/** @returns {boolean} True once the booked date has actually arrived (or passed). */
export function isFightDue(scheduledFight, currentDay) {
  return currentDay >= scheduledFight.fightDay;
}

/**
 * Sets (or changes) this week's Training Camp orientation. Free to change
 * any week up until fight week starts — see applyWeeklyCampOrientation()
 * for what actually consumes it.
 * @param {Object} playerState
 * @param {string} orientationId - A BALANCE.FIGHT_WEEK.CAMP_ORIENTATIONS key.
 * @returns {Object|null} The updated booking, or null if nothing is booked.
 */
export function setCampOrientation(playerState, orientationId) {
  if (!(orientationId in BALANCE.FIGHT_WEEK.CAMP_ORIENTATIONS)) {
    throw new TypeError(`FightWeekEngine.setCampOrientation: invalid orientation "${orientationId}".`);
  }
  return playerState.updateScheduledFight({ campOrientation: orientationId });
}

/**
 * Applies one week of the booked fighter's current Camp orientation
 * (skill gain + physical/mental fatigue cost), in place of their normal
 * Planning-tab weekly slots. No-ops once fight week has started (real
 * camps taper) or if nothing is booked / the booked fighter is no longer
 * on the roster (e.g. retired mid-camp).
 *
 * @param {Object} playerState
 * @param {Object} worldState
 * @returns {{ fighterId: string, orientationId: string, skillKeys: string[] }|null}
 *   A log entry for this week's camp work, or null if nothing was applied.
 */
export function applyWeeklyCampOrientation(playerState, worldState) {
  const scheduledFight = playerState.scheduledFight;
  if (!scheduledFight || isFightWeek(scheduledFight, worldState.currentDay)) return null;

  const fighter = playerState.getFighter(scheduledFight.fighterId);
  if (!fighter) return null;

  const orientation = BALANCE.FIGHT_WEEK.CAMP_ORIENTATIONS[scheduledFight.campOrientation]
    ?? BALANCE.FIGHT_WEEK.CAMP_ORIENTATIONS[BALANCE.FIGHT_WEEK.DEFAULT_CAMP_ORIENTATION];

  for (const skillKey of orientation.skillKeys) {
    fighter.adjustSkill(skillKey, orientation.skillGainPerWeek);
  }
  fighter.adjustPhysicalFatigue(orientation.physicalFatiguePerWeek);
  fighter.adjustMentalFatigue(orientation.mentalFatiguePerWeek);

  const logEntry = { day: worldState.currentDay, orientationId: scheduledFight.campOrientation };
  playerState.updateScheduledFight({ campLog: [...scheduledFight.campLog, logEntry] });

  return { fighterId: fighter.identity.id, orientationId: scheduledFight.campOrientation, skillKeys: orientation.skillKeys };
}

/**
 * Records the fight-week Weight Cut choice. Purely a booking-state write —
 * resolveWeightCutProfileKey() is what a caller (web/app.js, right before
 * launching the actual CombatEngine match) turns this into the
 * BALANCE.WEIGH_IN profile key CombatEngine#selectWeightCutProfile expects.
 * @param {Object} playerState
 * @param {string} choiceId - A BALANCE.FIGHT_WEEK.WEIGHT_CUT_CHOICES key.
 * @returns {Object|null}
 */
export function setWeightCutChoice(playerState, choiceId) {
  if (!(choiceId in BALANCE.FIGHT_WEEK.WEIGHT_CUT_CHOICES)) {
    throw new TypeError(`FightWeekEngine.setWeightCutChoice: invalid choice "${choiceId}".`);
  }
  return playerState.updateScheduledFight({ weightCutChoice: choiceId });
}

/**
 * @param {Object} scheduledFight
 * @returns {string} The BALANCE.WEIGH_IN.PROFILES key the chosen (or
 *   default, if none chosen yet) Weight Cut tier maps to.
 */
export function resolveWeightCutProfileKey(scheduledFight) {
  const choiceId = scheduledFight?.weightCutChoice;
  const choice = choiceId ? BALANCE.FIGHT_WEEK.WEIGHT_CUT_CHOICES[choiceId] : null;
  return choice?.profileKey ?? 'NATUREL';
}

/**
 * Pays for and applies the one-off Logistics (transport/hotel) choice: a
 * single Fatigue/Moral nudge to the booked fighter, applied once, right
 * when the choice is made. No-ops (returns a failure reason) if the gym
 * can't afford it, if nothing is booked, or if a Logistics choice was
 * already made for this booking (never charged/applied twice).
 *
 * @param {Object} playerState
 * @param {string} choiceId - A BALANCE.FIGHT_WEEK.LOGISTICS key.
 * @returns {{ success: boolean, reason?: string, cost?: number }}
 */
export function setLogisticsChoice(playerState, choiceId) {
  const scheduledFight = playerState.scheduledFight;
  if (!scheduledFight) return { success: false, reason: 'NO_SCHEDULED_FIGHT' };
  if (scheduledFight.logisticsChoice) return { success: false, reason: 'ALREADY_CHOSEN' };

  const option = BALANCE.FIGHT_WEEK.LOGISTICS[choiceId];
  if (!option) throw new TypeError(`FightWeekEngine.setLogisticsChoice: invalid choice "${choiceId}".`);

  if (playerState.money < option.cost) return { success: false, reason: 'INSUFFICIENT_FUNDS', cost: option.cost };

  const fighter = playerState.getFighter(scheduledFight.fighterId);
  if (!fighter) return { success: false, reason: 'FIGHTER_NOT_FOUND' };

  playerState.changeMoney(-option.cost, `FIGHT_WEEK_LOGISTICS:${choiceId}`);
  fighter.adjustPhysicalFatigue(option.physicalFatigueDelta);
  fighter.adjustMorale(option.moraleDelta);
  playerState.updateScheduledFight({ logisticsChoice: choiceId });

  return { success: true, cost: option.cost };
}

/** Clears the current booking outright (fight actually fought, or cancelled — e.g. the booked fighter got hurt/left the roster). */
export function cancelScheduledFight(playerState) {
  playerState.clearScheduledFight();
}

export default {
  scheduleFight,
  getDaysUntilFight,
  isFightWeek,
  isFightDue,
  setCampOrientation,
  applyWeeklyCampOrientation,
  setWeightCutChoice,
  resolveWeightCutProfileKey,
  setLogisticsChoice,
  cancelScheduledFight,
};
