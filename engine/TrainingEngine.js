/**
 * engine/TrainingEngine.js
 * ---------------------------------------------------------------------------
 * Weekly training resolution: turns each roster fighter's training plan
 * (Fighter.training — see models/Fighter.js#setTrainingPlan) into a skill
 * gain, a form change, an overtraining-injury roll, and age-driven passive
 * decline. Pure function over State + Models, driven entirely by BALANCE —
 * no gameplay constant is hardcoded here.
 *
 * Like CombatEngine, this module never imports PlayerState/WorldState's
 * classes — it receives live instances and mutates them through their own
 * public methods (Fighter.adjustSkill/adjustForm/adjustMorale/applyInjury).
 * ---------------------------------------------------------------------------
 */

import EventBus from '../core/EventBus.js';
import BALANCE from '../data/balance.js';

/** Event names published on EventBus by TrainingEngine. Import instead of raw strings. */
export const TRAINING_EVENTS = Object.freeze({
  PROGRESSION: 'training:progression',
  OVERTRAINED_INJURY: 'training:overtrained_injury',
  DECLINE: 'training:decline',
});

const PHYSICAL_SKILLS = Object.freeze(['boxe', 'jambes', 'sol', 'soumission', 'cardio']);
const ALL_SKILLS = Object.freeze([...PHYSICAL_SKILLS, 'intelligence']);
const WEEKS_PER_YEAR = BALANCE.CALENDAR.WEEKS_PER_SEASON * BALANCE.CALENDAR.SEASONS_PER_YEAR;

function classifyAgeBand(age) {
  const { PEAK_AGE_RANGE, DECLINE_START_AGE } = BALANCE.AGE;
  if (age < PEAK_AGE_RANGE.MIN) return 'PROSPECT';
  if (age <= PEAK_AGE_RANGE.MAX) return 'PEAK';
  if (age <= DECLINE_START_AGE) return 'VETERAN';
  return 'DECLINING';
}

/**
 * Best coach bonus available for a given focus skill: a specialist in that
 * exact skill applies their full skill rating; otherwise the best available
 * generalist still helps, at reduced effectiveness.
 */
function computeCoachMultiplier(coaches, focus) {
  if (!coaches || coaches.length === 0) return 1;

  let bestSpecialist = null;
  let bestAny = null;
  for (const coach of coaches) {
    const skill = coach.skill ?? 0;
    if (!bestAny || skill > (bestAny.skill ?? 0)) bestAny = coach;
    if (coach.specialty === focus && (!bestSpecialist || skill > (bestSpecialist.skill ?? 0))) {
      bestSpecialist = coach;
    }
  }

  if (bestSpecialist) {
    return 1 + (bestSpecialist.skill ?? 0) * BALANCE.TRAINING.COACH_SKILL_GAIN_MULTIPLIER_PER_POINT;
  }
  return (
    1 +
    (bestAny?.skill ?? 0) *
      BALANCE.TRAINING.COACH_SKILL_GAIN_MULTIPLIER_PER_POINT *
      BALANCE.TRAINING.GENERALIST_COACH_EFFECTIVENESS
  );
}

function computeEquipmentGainMultiplier(equipment, focus) {
  let multiplier = 1;
  for (const item of equipment ?? []) {
    const def = BALANCE.EQUIPMENT.DEFINITIONS[item?.id];
    if (!def) continue;
    if (!def.appliesToSkills || def.appliesToSkills.includes(focus)) {
      multiplier *= def.trainingGainMultiplier ?? 1;
    }
  }
  return multiplier;
}

function computeEquipmentFormRecoveryMultiplier(equipment) {
  let multiplier = 1;
  for (const item of equipment ?? []) {
    const def = BALANCE.EQUIPMENT.DEFINITIONS[item?.id];
    if (def?.formRecoveryMultiplier) multiplier *= def.formRecoveryMultiplier;
  }
  return multiplier;
}

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
 * Applies this week's passive age-driven decline to a fighter's
 * non-focused skills (the focused skill is actively maintained by
 * training, so it's exempt). Intelligence is exempt below
 * BALANCE.AGE.MENTAL_ATTRIBUTE_DECLINE_IMMUNITY_AGE. No-ops entirely below
 * BALANCE.AGE.DECLINE_START_AGE.
 *
 * @returns {Object|null} { fighterId, declined: { [skill]: delta } } or null.
 */
function applyAgeDecline(fighter) {
  if (fighter.identity.age < BALANCE.AGE.DECLINE_START_AGE) return null;

  const weeklyDecline = BALANCE.AGE.ANNUAL_DECLINE_PER_ATTRIBUTE / WEEKS_PER_YEAR;
  const declined = {};

  for (const skillKey of ALL_SKILLS) {
    if (skillKey === fighter.training.focus) continue;
    if (skillKey === 'intelligence' && fighter.identity.age < BALANCE.AGE.MENTAL_ATTRIBUTE_DECLINE_IMMUNITY_AGE) {
      continue;
    }

    const before = fighter.attributes.skills[skillKey];
    fighter.adjustSkill(skillKey, -weeklyDecline);
    const delta = fighter.attributes.skills[skillKey] - before;
    if (delta !== 0) declined[skillKey] = Math.round(delta * 1000) / 1000;
  }

  if (Object.keys(declined).length === 0) return null;

  const report = { fighterId: fighter.identity.id, declined };
  EventBus.publish(TRAINING_EVENTS.DECLINE, report);
  return report;
}

/**
 * Rolls for an overtraining injury: a fighter pushing through an active
 * (non-resting) session while their form is below
 * BALANCE.TRAINING.OVERTRAINING.FORME_THRESHOLD_PERCENT risks getting hurt.
 *
 * @returns {Object|null} The injury report, or null if none occurred.
 */
function rollOvertrainingInjury(fighter, formeBeforeSession, worldState, rng) {
  const ot = BALANCE.TRAINING.OVERTRAINING;
  const formeFraction = formeBeforeSession / BALANCE.FORM.MAX;
  if (formeFraction >= ot.FORME_THRESHOLD_PERCENT) return null;

  const riskMultiplier = ot.INTENSITY_RISK_MULTIPLIER[fighter.training.intensity] ?? 1;
  const chance = ot.BASE_INJURY_CHANCE * riskMultiplier;
  if (rng() >= chance) return null;

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
  EventBus.publish(TRAINING_EVENTS.OVERTRAINED_INJURY, report);
  return report;
}

/**
 * Resolves one fighter's active training session: skill gain on their
 * focused skill, informed by age, gym level, coaching, country bonus,
 * equipment and current form.
 *
 * @returns {Object} The training report published on TRAINING_EVENTS.PROGRESSION.
 */
function applyTrainingGain(fighter, playerState, formeBeforeSession) {
  const focus = fighter.training.focus;
  const intensity = fighter.training.intensity;
  const intensityMods = BALANCE.TRAINING.INTENSITY_MODIFIERS[intensity];
  const ageBand = classifyAgeBand(fighter.identity.age);

  const ageMultiplier = BALANCE.AGE.GROWTH_MULTIPLIER_BY_AGE[ageBand];
  const gymMultiplier = 1 + playerState.equipLevel * BALANCE.TRAINING.FACILITY_GAIN_MULTIPLIER_PER_LEVEL;
  const coachMultiplier = computeCoachMultiplier(playerState.coaches, focus);
  const countryMultiplier =
    1 + (BALANCE.TRAINING.COUNTRY_BONUSES[fighter.identity.origin]?.[focus] ?? 0);
  const equipmentMultiplier = computeEquipmentGainMultiplier(playerState.equipment, focus);
  const formMultiplier = formeBeforeSession / BALANCE.FORM.MAX;

  const currentValue = fighter.attributes.skills[focus];
  const isNearCap =
    currentValue >= BALANCE.PROGRESSION.SKILL_MAX * BALANCE.TRAINING.DIMINISHING_RETURNS_START_AT_PERCENT_OF_CAP;
  const diminishingMultiplier = isNearCap ? BALANCE.TRAINING.DIMINISHING_RETURNS_MULTIPLIER : 1;

  const baseGain =
    BALANCE.TRAINING.BASE_ATTRIBUTE_GAIN_PER_SESSION *
    BALANCE.TRAINING.SESSIONS_PER_WEEK *
    intensityMods.gainMultiplier;

  const totalGain =
    baseGain *
    ageMultiplier *
    gymMultiplier *
    coachMultiplier *
    countryMultiplier *
    equipmentMultiplier *
    formMultiplier *
    diminishingMultiplier;

  const before = fighter.attributes.skills[focus];
  fighter.adjustSkill(focus, totalGain);
  const after = fighter.attributes.skills[focus];

  const report = {
    fighterId: fighter.identity.id,
    focus,
    intensity,
    ageBand,
    gain: Math.round((after - before) * 1000) / 1000,
    newValue: after,
  };
  EventBus.publish(TRAINING_EVENTS.PROGRESSION, report);
  return report;
}

/**
 * Processes one week of training for every fighter in the player's roster.
 *
 * @param {Object} playerState - A PlayerState instance.
 * @param {Object} worldState - A WorldState instance (used to anchor injury dates).
 * @param {Object} [options]
 * @param {() => number} [options.rng] - Random source in [0, 1). Defaults to Math.random.
 * @returns {{ trained: Object[], injuries: Object[], declines: Object[] }}
 */
export function processWeeklyTraining(playerState, worldState, options = {}) {
  const rng = options.rng ?? Math.random;

  const trained = [];
  const injuries = [];
  const declines = [];

  for (const fighter of playerState.roster) {
    const isResting = !fighter.training.focus || fighter.training.intensity === 'REST';
    const formeBeforeSession = fighter.attributes.forme;

    const decline = applyAgeDecline(fighter);
    if (decline) declines.push(decline);

    if (!isResting) {
      const injury = rollOvertrainingInjury(fighter, formeBeforeSession, worldState, rng);
      if (injury) injuries.push(injury);
    }

    const intensityMods = BALANCE.TRAINING.INTENSITY_MODIFIERS[isResting ? 'REST' : fighter.training.intensity];
    const formRecoveryMultiplier = computeEquipmentFormRecoveryMultiplier(playerState.equipment);
    const formDelta =
      intensityMods.formDelta > 0 ? intensityMods.formDelta * formRecoveryMultiplier : intensityMods.formDelta;
    fighter.adjustForm(formDelta);

    if (isResting) continue;

    trained.push(applyTrainingGain(fighter, playerState, formeBeforeSession));
  }

  return { trained, injuries, declines };
}
