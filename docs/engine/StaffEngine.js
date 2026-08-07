/**
 * engine/StaffEngine.js
 * ---------------------------------------------------------------------------
 * The player's 3 recruitable staff ROLES (BALANCE.STAFF.ROLES) — Head
 * Coach, Coach Frappe/Grappling, Physio — layered on top of PlayerState's
 * pre-existing, loosely-typed `coaches` array (engine/LegacyEngine.js's
 * retired-fighter-becomes-a-coach flow keeps working unchanged: a legacy
 * coach simply has no `role`, so every getter below treats it as "no
 * effect", same as an empty roster).
 *
 * Every mechanical effect is expressed as an OFFSET from the role's own
 * baselineSkill (BALANCE.STAFF.ROLES[*].baselineSkill, 50): a coach exactly
 * at baseline changes nothing, a better one helps, a worse one (rare, but
 * legal) hurts. No staff hired at all reads identically to "an army of
 * baseline coaches" — zero effect, today's pre-StaffEngine behavior.
 *
 * Pure functions only: this module never mutates PlayerState directly
 * except hireStaff()/rollStaffConflict() (both explicitly state-mutating
 * by name) — every getXBonus()-shaped function only reads and returns a
 * number for the caller (engine/CombatEngine.js, engine/EconomyEngine.js,
 * web/app.js's weekly resolution) to apply itself.
 * ---------------------------------------------------------------------------
 */

import BALANCE from '../data/balance.js';
import { generateFighterIdentity } from './FighterGenerator.js';

function pick(rng, list) {
  return list[Math.floor(rng() * list.length)];
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** @returns {Object|null} The first hired coach with this role, or null if none is on staff. */
function findStaffByRole(playerState, roleId) {
  return playerState.coaches.find((coach) => coach.role === roleId) ?? null;
}

/** @returns {number} coach.skill - that role's baselineSkill, or 0 if no such coach is hired. */
function skillOffset(playerState, roleId) {
  const coach = findStaffByRole(playerState, roleId);
  if (!coach) return 0;
  return coach.skill - BALANCE.STAFF.ROLES[roleId].baselineSkill;
}

/**
 * Generates this session's hiring pool — real-named candidates for all 3
 * roles, a Striking/Grappling Coach candidate randomly leaning one
 * specialty or the other. Pure: never touches PlayerState.
 *
 * @param {Object} [options]
 * @param {() => number} [options.rng] - Random source in [0, 1). Defaults to Math.random.
 * @returns {{ id: string, name: string, role: string, specialty: string|null, skill: number, salary: number, relationship: number }[]}
 */
export function generateHiringPool({ rng = Math.random } = {}) {
  const cfg = BALANCE.STAFF;
  const roleIds = Object.keys(cfg.ROLES);

  return Array.from({ length: cfg.HIRING_POOL_SIZE }, (_, index) => {
    const roleId = roleIds[index % roleIds.length];
    const identity = generateFighterIdentity(rng);
    const skill = Math.round(cfg.MIN_SKILL + rng() * (cfg.MAX_SKILL - cfg.MIN_SKILL));
    const specialty = roleId === 'STRIKING_GRAPPLING_COACH' ? pick(rng, ['STRIKING', 'GRAPPLING']) : null;

    return {
      id: `staff_${Date.now().toString(36)}_${index}_${Math.floor(rng() * 1e6).toString(36)}`,
      name: identity.name,
      role: roleId,
      specialty,
      skill,
      salary: Math.round(cfg.SALARY_BASE_WEEKLY + cfg.SALARY_PER_SKILL_POINT * skill),
      relationship: cfg.STARTING_RELATIONSHIP,
    };
  });
}

/**
 * Hires a candidate from generateHiringPool() onto the player's staff —
 * the only place this module actually mutates PlayerState.
 * @param {Object} playerState
 * @param {Object} candidate - One entry from generateHiringPool().
 * @returns {Object} The stored coach record (see PlayerState#addCoach).
 */
export function hireStaff(playerState, candidate) {
  return playerState.addCoach({
    name: candidate.name,
    role: candidate.role,
    specialty: candidate.specialty,
    skill: candidate.skill,
    salary: candidate.salary,
    relationship: candidate.relationship,
  });
}

// ---- mechanical effect getters (pure reads) ----------------------------------

/**
 * Head Coach's contribution to CombatEngine's momentumMultiplier — same
 * additive-offset shape as CONFIDENCE's own bonus, see
 * engine/CombatEngine.js#_computeRoundOffense.
 * @returns {number}
 */
export function getHeadCoachMomentumBonus(playerState) {
  return skillOffset(playerState, 'HEAD_COACH') * BALANCE.STAFF.ROLES.HEAD_COACH.momentumBonusPerSkillPoint;
}

/**
 * Head Coach's weekly morale bonus, applied to every roster fighter (see
 * applyWeeklyStaffEffects).
 * @returns {number}
 */
export function getHeadCoachWeeklyMoraleBonus(playerState) {
  return skillOffset(playerState, 'HEAD_COACH') * BALANCE.STAFF.ROLES.HEAD_COACH.weeklyMoraleBonusPerSkillPoint;
}

/**
 * Head Coach's skill IS the "CompetenceCoach" the Fog of War formula reads
 * (see BALANCE.SCOUTING_FOG / engine/ScoutingEngine.js#estimateFighterSkills)
 * — falls back to NO_COACH_COMPETENCE when nobody is hired.
 * @returns {number}
 */
export function getScoutingCompetence(playerState) {
  const coach = findStaffByRole(playerState, 'HEAD_COACH');
  return coach ? coach.skill : BALANCE.SCOUTING_FOG.NO_COACH_COMPETENCE;
}

/**
 * The Striking/Grappling Coach's output multipliers per CombatEngine
 * distance — STRIKING and CLINCH both count as "striking" for this
 * purpose (CLINCH already has its own separate style-driven bonus; this
 * layers on top), GROUND is "grappling". A striking-specialty coach
 * boosts STRIKING/CLINCH output and maluses GROUND, and vice versa for a
 * grappling specialty. 1 (no effect) for any distance when no such coach
 * is hired.
 * @returns {{ STRIKING: number, CLINCH: number, GROUND: number }}
 */
export function getStrikingGrapplingMultipliers(playerState) {
  const coach = findStaffByRole(playerState, 'STRIKING_GRAPPLING_COACH');
  if (!coach) return { STRIKING: 1, CLINCH: 1, GROUND: 1 };

  const cfg = BALANCE.STAFF.ROLES.STRIKING_GRAPPLING_COACH;
  const offset = coach.skill - cfg.baselineSkill;
  const primaryBonus = 1 + offset * cfg.primaryBonusPerSkillPoint;
  const secondaryMalus = 1 - offset * cfg.secondaryMalusPerSkillPoint;

  return coach.specialty === 'GRAPPLING'
    ? { STRIKING: secondaryMalus, CLINCH: secondaryMalus, GROUND: primaryBonus }
    : { STRIKING: primaryBonus, CLINCH: primaryBonus, GROUND: secondaryMalus };
}

/**
 * Physio's multiplicative reduction to injury chance (< 1 reduces risk),
 * floored so a Physio can meaningfully lower but never fully eliminate
 * injury risk. 1 (no effect) with no Physio hired.
 * @returns {number}
 */
export function getPhysioInjuryRiskMultiplier(playerState) {
  const cfg = BALANCE.STAFF.ROLES.PHYSIO;
  const multiplier = 1 - skillOffset(playerState, 'PHYSIO') * cfg.injuryRiskReductionPerSkillPoint;
  return clamp(multiplier, 0.3, 1.5);
}

/**
 * Physio's multiplicative bonus to CORNER_PAUSE stamina regen. 1 (no
 * effect) with no Physio hired.
 * @returns {number}
 */
export function getPhysioStaminaRegenMultiplier(playerState) {
  const cfg = BALANCE.STAFF.ROLES.PHYSIO;
  return Math.max(0.5, 1 + skillOffset(playerState, 'PHYSIO') * cfg.staminaRegenBonusPerSkillPoint);
}

/**
 * Applies the Head Coach's weekly morale bump to every roster fighter —
 * call once per week (see web/app.js's weekly resolution, alongside
 * processActiveDeals). No-op (returns 0) with no Head Coach hired.
 * @param {Object} playerState
 * @returns {number} The morale delta applied (0 if none).
 */
export function applyWeeklyStaffEffects(playerState) {
  const bonus = getHeadCoachWeeklyMoraleBonus(playerState);
  if (bonus !== 0) {
    for (const fighter of playerState.roster) fighter.adjustMorale(bonus);
  }
  return bonus;
}

/**
 * Weekly ego/relationship conflict roll ("avis divergeant sur l'etat de
 * sante d'un combattant...") — each hired staff member independently
 * rolls a small chance of a conflict, more likely the lower their current
 * relationship already is. On a hit, docks that staff member's own
 * relationship further (a conflict leaves a mark) and returns a
 * descriptor for the UI to surface as a toast/notification.
 *
 * @param {Object} playerState
 * @param {() => number} [rng] - Random source in [0, 1). Defaults to Math.random.
 * @returns {{ coachId: string, coachName: string, description: string }[]}
 */
export function rollStaffConflict(playerState, rng = Math.random) {
  const cfg = BALANCE.STAFF.CONFLICT;
  const conflicts = [];

  for (const coach of playerState.coaches) {
    if (!coach.role) continue; // a Legacy coach (no role) never triggers this — pre-existing coaches are unaffected.
    const relationship = coach.relationship ?? BALANCE.STAFF.STARTING_RELATIONSHIP;
    const chance = cfg.BASE_WEEKLY_CHANCE + (relationship <= cfg.LOW_RELATIONSHIP_THRESHOLD ? cfg.LOW_RELATIONSHIP_CHANCE_BONUS : 0);
    if (rng() >= chance) continue;

    coach.relationship = clamp(relationship + cfg.RELATIONSHIP_HIT, 0, 100);
    conflicts.push({
      coachId: coach.id,
      coachName: coach.name,
      description: `${coach.name} exprime son desaccord sur l'etat de sante d'un combattant — tension avec le staff.`,
    });
  }

  return conflicts;
}

export default {
  generateHiringPool,
  hireStaff,
  getHeadCoachMomentumBonus,
  getHeadCoachWeeklyMoraleBonus,
  getScoutingCompetence,
  getStrikingGrapplingMultipliers,
  getPhysioInjuryRiskMultiplier,
  getPhysioStaminaRegenMultiplier,
  applyWeeklyStaffEffects,
  rollStaffConflict,
};
