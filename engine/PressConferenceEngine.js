/**
 * engine/PressConferenceEngine.js
 * ---------------------------------------------------------------------------
 * A pre-fight stance choice (BALANCE.PRESS_CONFERENCE.STANCES), offered only
 * ahead of a "big fight" — see isMainEventEligible(). An ordinary undercard
 * bout never shows this; web/app.js checks eligibility before presenting the
 * choice, then calls applyPressConferenceChoice() once, immediately before
 * the fight actually starts (see web/app.js#_startFight).
 *
 * Pure functions only — this module never mutates anything except through
 * applyPressConferenceChoice's own explicit, documented side effects
 * (Fighter#adjustMorale, WorldState#upsertRelationship, and setting
 * Fighter#preparation.tacticalBonusPending directly, the same way
 * engine/WeeklyPlanningEngine.js's own TACTICAL_PREP activity already does).
 * ---------------------------------------------------------------------------
 */

import BALANCE from '../data/balance.js';

/**
 * @param {Object} options
 * @param {Object} options.fighterA - The player's own fighter.
 * @param {Object} options.fighterB - The opponent.
 * @param {number} [options.opponentGymReputation=0] - The opponent's gym's Reputation, if fighting a rival gym's roster.
 * @returns {boolean} True once either fighter already holds a title, or the
 *   opponent's gym reputation reaches BALANCE.PRESS_CONFERENCE's configured tier.
 */
export function isMainEventEligible({ fighterA, fighterB, opponentGymReputation = 0 }) {
  const cfg = BALANCE.PRESS_CONFERENCE;
  const reputationThreshold = BALANCE.GYM.PROMOTION_TIER_REPUTATION_REQUIREMENT[cfg.MAIN_EVENT_REPUTATION_TIER];
  const eitherHoldsTitle = fighterA.career.titles.length > 0 || fighterB.career.titles.length > 0;
  return eitherHoldsTitle || opponentGymReputation >= reputationThreshold;
}

/** @returns {Object[]} The 3 stances (Respectueux/Provocateur/Tactique), in catalog order. */
export function getStances() {
  return Object.values(BALANCE.PRESS_CONFERENCE.STANCES);
}

/**
 * Applies one stance's effects, once, ahead of the fight actually starting.
 *
 * @param {string} stanceId - One of BALANCE.PRESS_CONFERENCE.STANCES' keys.
 * @param {Object} options
 * @param {Object} options.fighterA - The player's own fighter; receives the morale/tactical-prep effects.
 * @param {Object} options.fighterB - The opponent; only used as the other half of the tension relationship.
 * @param {Object} [options.worldState] - Needed only for the Provocateur stance's tension bump; safely skipped if omitted.
 * @returns {{ stance: Object, purseMultiplier: number }} purseMultiplier is
 *   meant to be passed straight into CombatEngine#setupMatch's rules param
 *   (rules.purseMultiplier), which already compounds with every other purse
 *   multiplier (League tier, Vale Tudo...) in _computePurses.
 */
export function applyPressConferenceChoice(stanceId, { fighterA, fighterB, worldState = null }) {
  const stance = BALANCE.PRESS_CONFERENCE.STANCES[stanceId];
  if (!stance) {
    throw new TypeError(`PressConferenceEngine.applyPressConferenceChoice: unknown stance "${stanceId}".`);
  }

  if (stance.moraleDelta) fighterA.adjustMorale(stance.moraleDelta);

  if (stance.tensionDelta && worldState) {
    worldState.upsertRelationship(
      fighterA.identity.id,
      fighterB.identity.id,
      { tension: stance.tensionDelta },
      { type: 'PRESS_CONFERENCE', description: `${fighterA.identity.name} chauffe la conference d'avant-combat face a ${fighterB.identity.name}.` }
    );
  }

  if (stance.grantsTacticalPrep) fighterA.preparation.tacticalBonusPending = true;

  return { stance, purseMultiplier: stance.purseMultiplier ?? 1 };
}

export default { isMainEventEligible, getStances, applyPressConferenceChoice };
