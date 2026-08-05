/**
 * engine/WeeklyPlanningEngine.js
 * ---------------------------------------------------------------------------
 * Phase 3.1 v1 ("Planning, Charge & Readiness System"): resolves each
 * roster fighter's 3-slot weekly plan (Fighter.weeklyPlan.slots — see
 * models/Fighter.js#setWeeklyPlanSlot) into skill gains, Fatigue changes, a
 * pending tactical-prep bonus consumed by the fighter's next fight, media/
 * sponsor income, and an occasional Sparring micro-injury. Pure function
 * over State + Models, driven entirely by BALANCE.WEEKLY_PLANNING — no
 * gameplay constant is hardcoded here.
 *
 * Deliberately independent from engine/TrainingEngine.js's legacy
 * training.focus/intensity path: the two resolve different Fighter fields
 * and are never both driven for the same fighter in the same run (see
 * tools/SimRunner.js, whose headless coach-AI drives this engine instead of
 * TrainingEngine's for Phase 3.1's telemetry).
 * ---------------------------------------------------------------------------
 */

import EventBus from '../core/EventBus.js';
import BALANCE from '../data/balance.js';
import { computeCombinedModifiers } from './PersonalityEngine.js';

/** Event names published on EventBus by WeeklyPlanningEngine. Import instead of raw strings. */
export const WEEKLY_PLANNING_EVENTS = Object.freeze({
  ACTIVITY_RESOLVED: 'weeklyPlanning:activity_resolved',
  SPARRING_INJURY: 'weeklyPlanning:sparring_injury',
});

const SKILL_KEYS = Object.freeze(['boxe', 'jambes', 'sol', 'soumission', 'cardio', 'intelligence']);

/** Mirrors tools/SimRunner.js's existing coach-AI heuristic: TECHNIQUE/SPARRING both train whichever skill is currently weakest. */
function pickWeakestSkill(fighter) {
  const skills = fighter.attributes.skills;
  return SKILL_KEYS.reduce((min, key) => (skills[key] < skills[min] ? key : min), SKILL_KEYS[0]);
}

/** Same weighted-roll shape as TrainingEngine.js's own copy — kept local rather than imported, matching this codebase's convention of Engine modules never importing each other. */
function rollWeightedSeverity(rng, weights) {
  const entries = Object.entries(weights);
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = rng() * total;
  for (const [severity, weight] of entries) {
    if (roll < weight) return severity;
    roll -= weight;
  }
  return entries[entries.length - 1][0];
}

/**
 * Rolls SPARRING's "risque leger de blessure micro-traumatique" — a small,
 * documented-default chance (WEEKLY_PLANNING.ACTIVITIES.SPARRING.injuryChance)
 * of a real injury, severity/body-part rolled from the same BALANCE.INJURIES
 * tables TrainingEngine's overtraining roll uses.
 * @returns {Object|null}
 */
function rollSparringInjury(fighter, worldState, rng) {
  const activity = BALANCE.WEEKLY_PLANNING.ACTIVITIES.SPARRING;
  if (rng() >= activity.injuryChance) return null;

  const severity = rollWeightedSeverity(rng, BALANCE.INJURIES.SEVERITY_WEIGHTS);
  const bodyPart = BALANCE.INJURIES.BODY_PARTS[Math.floor(rng() * BALANCE.INJURIES.BODY_PARTS.length)];
  const dayAnchor = worldState ? worldState.currentDay : 0;

  const injury = {
    severity,
    bodyPart,
    occurredOnDay: dayAnchor,
    injuredUntilDay: dayAnchor + BALANCE.INJURIES.RECOVERY_DAYS[severity],
  };

  fighter.applyInjury(injury);
  fighter.adjustMorale(BALANCE.MORALE.EVENTS.INJURY_SUSTAINED);

  const report = { fighterId: fighter.identity.id, ...injury };
  EventBus.publish(WEEKLY_PLANNING_EVENTS.SPARRING_INJURY, report);
  return report;
}

/**
 * Resolves MEDIA_SPONSORS' gym-level payoff (reputation/hype/money, via the
 * same PlayerState mutators CombatEngine's post-fight rewards use) and its
 * personality-scaled morale swing — "moral variable selon la personnalite"
 * reuses PERSONALITY.ARCHETYPES/TRAITS' existing moraleVolatility dimension
 * and MORALE.EVENTS.SPONSOR_DEAL_SIGNED as the base magnitude, rather than
 * inventing a parallel per-archetype table.
 */
function resolveMediaSponsors(fighter, playerState, personalityModifiers) {
  const activity = BALANCE.WEEKLY_PLANNING.ACTIVITIES.MEDIA_SPONSORS;

  playerState.changeReputation(activity.reputationGain, 'WEEKLY_PLANNING:MEDIA_SPONSORS');
  playerState.changeHype(activity.hypeGain, 'WEEKLY_PLANNING:MEDIA_SPONSORS');
  playerState.changeMoney(activity.moneyGain, `WEEKLY_PLANNING:MEDIA_SPONSORS:${fighter.identity.name}`);

  const moraleDelta = BALANCE.MORALE.EVENTS.SPONSOR_DEAL_SIGNED * personalityModifiers.moraleVolatility;
  fighter.adjustMorale(moraleDelta);

  return {
    fighterId: fighter.identity.id,
    reputationGain: activity.reputationGain,
    hypeGain: activity.hypeGain,
    moneyGain: activity.moneyGain,
    moraleDelta: Math.round(moraleDelta * 100) / 100,
  };
}

/**
 * Resolves one fighter's one activity slot: skill gain, tactical-bonus flag,
 * Sparring injury roll, media payoff, and the Fatigue cost/recovery itself.
 * fatigueCost is scaled by this fighter's own PERSONALITY fatigueMultiplier
 * (the "wear a training/fight session leaves" dimension — see
 * engine/PersonalityEngine.js#computeCombinedModifiers); PHYSIO_REST's
 * fatigueDelta is recovery, not wear, so it is NOT scaled by that modifier.
 *
 * @returns {{ report: Object, injury: Object|null, mediaReport: Object|null }}
 */
function resolveSlot(activityKey, fighter, playerState, worldState, rng, personalityModifiers) {
  const activity = BALANCE.WEEKLY_PLANNING.ACTIVITIES[activityKey];
  const report = { fighterId: fighter.identity.id, activity: activityKey };

  if (activity.skillGain) {
    const skillKey = pickWeakestSkill(fighter);
    const before = fighter.attributes.skills[skillKey];
    fighter.adjustSkill(skillKey, activity.skillGain);
    report.skillKey = skillKey;
    report.gain = Math.round((fighter.attributes.skills[skillKey] - before) * 1000) / 1000;
  }

  if (activity.tacticalBonus) {
    fighter.preparation.tacticalBonusPending = true;
    report.tacticalBonus = activity.tacticalBonus;
  }

  const injury = activity.injuryChance ? rollSparringInjury(fighter, worldState, rng) : null;
  if (injury) report.injury = injury;

  const isMediaActivity = Boolean(activity.reputationGain || activity.hypeGain || activity.moneyGain);
  const mediaReport = isMediaActivity ? resolveMediaSponsors(fighter, playerState, personalityModifiers) : null;
  if (mediaReport) report.media = mediaReport;

  const fatigueFromCost = activity.fatigueCost ? activity.fatigueCost * personalityModifiers.fatigueMultiplier : 0;
  const fatigueFromRecovery = activity.fatigueDelta ?? 0;
  fighter.adjustFatigue(fatigueFromCost + fatigueFromRecovery);
  report.fatigueDelta = Math.round((fatigueFromCost + fatigueFromRecovery) * 100) / 100;

  EventBus.publish(WEEKLY_PLANNING_EVENTS.ACTIVITY_RESOLVED, report);
  return { report, injury, mediaReport };
}

/**
 * Processes one week of weekly-plan resolution for every fighter in the
 * player's roster: every non-empty slot in Fighter.weeklyPlan.slots is
 * resolved in order, then this week's total Charge is snapshotted onto
 * Fighter.preparation.weeklyCharge for getReadiness() to read.
 *
 * @param {Object} playerState - A PlayerState instance.
 * @param {Object} worldState - A WorldState instance (used to anchor injury dates).
 * @param {Object} [options]
 * @param {() => number} [options.rng] - Random source in [0, 1). Defaults to Math.random.
 * @returns {{ activityLog: Object[], injuries: Object[], mediaEvents: Object[] }}
 */
export function processWeeklyPlan(playerState, worldState, options = {}) {
  const rng = options.rng ?? Math.random;

  const activityLog = [];
  const injuries = [];
  const mediaEvents = [];

  for (const fighter of playerState.roster) {
    const personalityModifiers = computeCombinedModifiers(fighter);
    let weeklyCharge = 0;

    for (const activityKey of fighter.weeklyPlan.slots) {
      if (!activityKey) continue;

      const activity = BALANCE.WEEKLY_PLANNING.ACTIVITIES[activityKey];
      weeklyCharge += activity.charge;

      const { report, injury, mediaReport } = resolveSlot(
        activityKey,
        fighter,
        playerState,
        worldState,
        rng,
        personalityModifiers
      );
      activityLog.push(report);
      if (injury) injuries.push(injury);
      if (mediaReport) mediaEvents.push(mediaReport);
    }

    fighter.preparation.weeklyCharge = weeklyCharge;
  }

  return { activityLog, injuries, mediaEvents };
}
