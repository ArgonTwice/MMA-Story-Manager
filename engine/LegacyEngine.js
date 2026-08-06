/**
 * engine/LegacyEngine.js — Phase 4.2 ("Memoire du Monde, Legacy Engine &
 * Attachement au Roster")
 * ---------------------------------------------------------------------------
 * Decides what a retiring fighter becomes: a Hall of Famer (delegated to
 * engine/HistoryEngine.js#evaluateHallOfFameEligibility/induct), and one of
 * four reconversion paths (see LEGACY_ENGINE_OUTCOMES) weighted by their own
 * career resume + personality archetype (see BALANCE.LEGACY_ENGINE).
 *
 * Only COACH_IN_GYM and RIVAL_GYM_OWNER carry a real mechanical effect —
 * hiring the retiree onto the player's own coaching staff (which then
 * actually influences future fighters' training gains, see
 * engine/TrainingEngine.js#computeCoachMultiplier), or boosting an existing
 * rival gym's reputation. PHYSIO and RECRUITER are deliberately
 * classification-only in this phase: the spec's own emphasis ("Injecter les
 * anciens champions reconvertis comme coachs influencant les futurs
 * combattants") singles out the coaching path specifically, and building a
 * live Physio/Recruiter mechanical system is out of this phase's scope —
 * both outcomes are still real, telemetered, career-informed choices,
 * visible in tools/BalanceReporter.js's reconversion breakdown, just without
 * a further gameplay effect wired to them yet.
 *
 * Called once per forced retirement, synchronously, by whoever removes the
 * fighter from the roster (tools/SimRunner.js#processRetirements today; a
 * future real-game ProgressionEngine retirement path would call it the same
 * way) — BEFORE the fighter is removed, since induction/coach-hire both
 * still need the live Fighter instance's full career state.
 * ---------------------------------------------------------------------------
 */

import BALANCE from '../data/balance.js';
import { evaluateHallOfFameEligibility, induct } from './HistoryEngine.js';

/** The four reconversion paths a retiree can land on. Import instead of raw strings. */
export const LEGACY_ENGINE_OUTCOMES = Object.freeze({
  COACH_IN_GYM: 'COACH_IN_GYM',
  PHYSIO: 'PHYSIO',
  RIVAL_GYM_OWNER: 'RIVAL_GYM_OWNER',
  RECRUITER: 'RECRUITER',
});

/**
 * Combines BASE_RECONVERSION_WEIGHTS with the fighter's archetype lean and
 * (if applicable) the Hall of Fame multiplier — all three layers are purely
 * multiplicative, see BALANCE.LEGACY_ENGINE's own doc comment for the
 * reasoning behind each.
 */
function computeReconversionWeights(fighter, isHallOfFamer) {
  const cfg = BALANCE.LEGACY_ENGINE;
  const weights = { ...cfg.BASE_RECONVERSION_WEIGHTS };

  const archetypeLean = cfg.ARCHETYPE_RECONVERSION_LEAN[fighter.psychology.personality.archetype] ?? {};
  for (const [outcome, multiplier] of Object.entries(archetypeLean)) {
    weights[outcome] *= multiplier;
  }

  if (isHallOfFamer) {
    for (const [outcome, multiplier] of Object.entries(cfg.HALL_OF_FAME_RECONVERSION_MULTIPLIER)) {
      weights[outcome] *= multiplier;
    }
  }

  return weights;
}

/** Same weighted-random pick shape as tools/SimRunner.js's own weightedPick (independent copies — this file must stay import-free of tools/). */
function weightedPickOutcome(weights, rng) {
  const entries = Object.entries(weights);
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = rng() * total;
  for (const [key, weight] of entries) {
    if (roll < weight) return key;
    roll -= weight;
  }
  return entries[entries.length - 1][0];
}

/** @returns {string} The skill key this fighter is strongest in — becomes their coaching specialty. */
function strongestSkill(fighter) {
  const { skills } = fighter.attributes;
  return Object.keys(skills).reduce((best, key) => (skills[key] > skills[best] ? key : best));
}

/**
 * Hires the retiree onto playerState's own coaching staff, if a
 * MAX_LEGACY_COACHES slot is free. Coach skill is a direct mapping of the
 * fighter's final getOverallRating() (both already 0-100 scales) — a
 * fighter who was a 90-rated performer becomes a 90-skill coach.
 *
 * @returns {boolean} True if actually hired (false if no slot was free).
 */
function tryHireAsCoach(fighter, playerState) {
  const cfg = BALANCE.LEGACY_ENGINE;
  const legacyCoachCount = playerState.coaches.filter((coach) => coach.isLegacyCoach).length;
  if (legacyCoachCount >= cfg.MAX_LEGACY_COACHES) return false;

  playerState.addCoach({
    name: fighter.identity.name,
    skill: Math.round(fighter.getOverallRating()),
    specialty: strongestSkill(fighter),
    isLegacyCoach: true,
    formerFighterId: fighter.identity.id,
  });
  return true;
}

/**
 * Boosts an existing rival gym's reputation, tagging it as now run by this
 * retiree. A no-op (still telemetered as the chosen outcome) if WorldState
 * has no rival gyms at all.
 *
 * @returns {boolean} True if a rival gym was actually found and boosted.
 */
function tryBecomeRivalGymOwner(fighter, worldState, rng) {
  const gyms = worldState.rivalGyms;
  if (gyms.length === 0) return false;

  const gym = gyms[Math.floor(rng() * gyms.length)];
  const currentReputation = gym.reputation ?? BALANCE.GYM.STARTING_REPUTATION;
  worldState.updateRivalGym(gym.id, {
    reputation: Math.min(BALANCE.GYM.MAX_REPUTATION, currentReputation + BALANCE.LEGACY_ENGINE.RIVAL_GYM_OWNER_REPUTATION_BOOST),
    formerChampionOwner: fighter.identity.name,
  });
  return true;
}

/**
 * Resolves one fighter's retirement: Hall of Fame induction check, then a
 * weighted-random reconversion pick, then the mechanical effect (if any)
 * for that pick.
 *
 * @param {Object} fighter - A Fighter instance, still fully populated (call
 *   this BEFORE removing them from playerState.roster).
 * @param {Object} deps
 * @param {Object} deps.playerState
 * @param {Object} deps.worldState
 * @param {() => number} deps.rng
 * @returns {Object} { fighterId, name, archetype, isHallOfFamer, outcome, applied }
 */
export function processRetirement(fighter, { playerState, worldState, rng }) {
  const isHallOfFamer = evaluateHallOfFameEligibility(fighter);
  if (isHallOfFamer) {
    induct(fighter, worldState, playerState);
  }

  const weights = computeReconversionWeights(fighter, isHallOfFamer);
  const outcome = weightedPickOutcome(weights, rng);

  let applied = false;
  if (outcome === LEGACY_ENGINE_OUTCOMES.COACH_IN_GYM) {
    applied = tryHireAsCoach(fighter, playerState);
  } else if (outcome === LEGACY_ENGINE_OUTCOMES.RIVAL_GYM_OWNER) {
    applied = tryBecomeRivalGymOwner(fighter, worldState, rng);
  }
  // PHYSIO / RECRUITER: classification-only, see this file's header.

  return {
    fighterId: fighter.identity.id,
    name: fighter.identity.name,
    nickname: fighter.identity.nickname,
    archetype: fighter.psychology.personality.archetype,
    isHallOfFamer,
    outcome,
    applied,
  };
}
