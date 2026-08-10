/**
 * engine/DraftEngine.js
 * ---------------------------------------------------------------------------
 * Player-facing fighter recruitment: the permanent Recruitment Market
 * (Effectif tab, one signing at a time, any week — not gated to once-a-year
 * like engine/AcademyEngine.js's free Academy Draft, and not autonomous/
 * rival-only like engine/TransferMarket.js), plus the starter roster used to
 * seed a brand-new rival gym at game creation.
 *
 * There used to be a mandatory "Initial Draft" step blocking entry into a
 * brand-new game (0 fighters, forced picks before the Hub was reachable) —
 * removed: a new gym now goes straight to the Hub with an empty roster, and
 * the Recruitment Market below is the only way fighters ever join it.
 *
 * Every candidate carries real Prenom+Nom identities via
 * engine/FighterGenerator.js#generateFighterIdentity (data/names.js) —
 * never a placeholder like "${style} Prospect".
 *
 * Pricing (see BALANCE.RECRUITMENT_MARKET): signing cost and weekly wage
 * both grow with the candidate's actual Fighter#getOverallRating() on an
 * EXPONENTIAL curve (COST_BASE * COST_GROWTH_PER_RATING_POINT ** rating),
 * not a flat per-skill-point rate — a weak prospect stays cheap
 * (800$-2000$-ish) while a genuine "pepite" (an occasional high-tier roll,
 * see POTENTIAL_TIERS) or an experienced veteran at their peak costs
 * dramatically more (5000$-15000$+), the same "a handful of great players
 * cost far more than proportionally to their rating" curve real transfer
 * markets show. Age further multiplies cost/wage via AGE_COST_MULTIPLIER,
 * reusing BALANCE.AGE's existing PROSPECT/PEAK/VETERAN/DECLINING bands
 * (see classifyAgeBand) rather than inventing a new age concept.
 *
 * Pure generation only, like engine/AcademyEngine.js/engine/TransferMarket.js:
 * this module builds Fighter instances and returns them with a signing cost
 * (and, for the Recruitment Market, a weekly wage) — it never touches
 * PlayerState itself. The caller (web/app.js) decides whether/when to call
 * PlayerState#addFighter()/#changeMoney() and set Fighter#weeklySalary for
 * the chosen candidate.
 * ---------------------------------------------------------------------------
 */

import BALANCE from '../data/balance.js';
import Fighter from '../models/Fighter.js';
import { generateFighterIdentity, generatePersonality, generatePhysicalProfile } from './FighterGenerator.js';

const STARTING_STYLES = Object.freeze(['Boxe', 'Muay Thai', 'Lutte', 'Jiu-Jitsu Bresilien', 'Freestyle', 'Kickboxing']);
const SKILL_KEYS = Object.freeze(['boxe', 'jambes', 'sol', 'soumission', 'cardio', 'intelligence']);

function pick(rng, list) {
  return list[Math.floor(rng() * list.length)];
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Rolls one of `tiers` (highest tier whose minRoll the roll clears wins) —
 * same shape/semantics as engine/AcademyEngine.js#rollPotentialTier.
 * @param {() => number} rng
 * @param {Object} tiers - BALANCE.RECRUITMENT_MARKET.POTENTIAL_TIERS.
 * @returns {{ key: string, label: string, skillMeanBonus: number }}
 */
function rollPotentialTier(rng, tiers) {
  const roll = rng();
  let selected = null;
  for (const [key, tier] of Object.entries(tiers)) {
    if (roll >= tier.minRoll) selected = { key, ...tier };
  }
  return selected;
}

/**
 * Classifies an age into the same PROSPECT/PEAK/VETERAN/DECLINING bands
 * BALANCE.AGE.GROWTH_MULTIPLIER_BY_AGE already uses for training gains —
 * reused here (via its own AGE_COST_MULTIPLIER) so "potential" is priced
 * off a concept this codebase already treats as canonical, not a new one.
 * @param {number} age
 * @returns {'PROSPECT'|'PEAK'|'VETERAN'|'DECLINING'}
 */
function classifyAgeBand(age) {
  const ageCfg = BALANCE.AGE;
  if (age < ageCfg.PEAK_AGE_RANGE.MIN) return 'PROSPECT';
  if (age <= ageCfg.PEAK_AGE_RANGE.MAX) return 'PEAK';
  if (age <= ageCfg.DECLINE_START_AGE) return 'VETERAN';
  return 'DECLINING';
}

/**
 * Generates one candidate from a skill mean/spread, an age range, and the
 * caller's own pricing knobs — the shared shape generateRecruitmentPool/
 * generateRivalGymStarterRoster both build on.
 * @param {Object} options
 * @param {number} options.skillMean
 * @param {number} options.skillSpread
 * @param {number} options.minAge
 * @param {number} options.maxAge
 * @param {number} options.costBase
 * @param {number} options.costGrowthPerRatingPoint
 * @param {number} options.minCost
 * @param {number} options.salaryRatioOfCost
 * @param {Object} [options.ageCostMultiplier] - { PROSPECT, PEAK, VETERAN, DECLINING }, defaults to no age adjustment (all 1).
 * @param {Object} [options.potentialTiers] - BALANCE.RECRUITMENT_MARKET.POTENTIAL_TIERS, or omitted for no tier variance/label.
 * @param {() => number} options.rng
 * @returns {{ fighter: Fighter, cost: number, weeklySalary: number, potentialLabel: string|null }}
 */
function generateCandidate({
  skillMean,
  skillSpread,
  minAge,
  maxAge,
  costBase,
  costGrowthPerRatingPoint,
  minCost,
  salaryRatioOfCost,
  ageCostMultiplier = null,
  potentialTiers = null,
  rng,
}) {
  const identity = generateFighterIdentity(rng);
  const physical = generatePhysicalProfile(rng, identity.gender);
  const potential = potentialTiers ? rollPotentialTier(rng, potentialTiers) : null;
  const effectiveSkillMean = skillMean + (potential?.skillMeanBonus ?? 0);

  const skills = Object.fromEntries(
    SKILL_KEYS.map((key) => [key, Math.max(1, Math.round(effectiveSkillMean + (rng() * 2 - 1) * skillSpread))])
  );
  const age = minAge + Math.floor(rng() * (maxAge - minAge + 1));

  const fighter = new Fighter({
    identity: {
      name: identity.name,
      age,
      style: pick(rng, STARTING_STYLES),
      weightClass: physical.weightClassLabel,
      gender: physical.gender,
      heightCm: physical.heightCm,
      weightKg: physical.weightKg,
    },
    attributes: { skills },
    psychology: { personality: generatePersonality(rng) },
  });

  const rating = fighter.getOverallRating();
  const ageMultiplier = ageCostMultiplier?.[classifyAgeBand(age)] ?? 1;
  const cost = Math.round(Math.max(minCost, costBase * costGrowthPerRatingPoint ** rating * ageMultiplier));
  const weeklySalary = Math.round(cost * salaryRatioOfCost);

  return { fighter, cost, weeklySalary, potentialLabel: potential?.label ?? null };
}

/**
 * Generates the permanent recruitment market's pool — quality (and thus
 * price) scales with the gym's own Reputation (same "State drives
 * generation" precedent as engine/AcademyEngine.js), and occasionally rolls
 * a genuine high-potential "pepite" (see BALANCE.RECRUITMENT_MARKET.POTENTIAL_TIERS).
 * Pure: never touches PlayerState/WorldState.
 *
 * @param {Object} options
 * @param {Object} options.playerState - A PlayerState instance (reads .reputation only).
 * @param {() => number} [options.rng] - Random source in [0, 1). Defaults to Math.random.
 * @returns {{ fighter: Fighter, cost: number, weeklySalary: number, potentialLabel: string|null }[]}
 */
export function generateRecruitmentPool({ playerState, rng = Math.random }) {
  const cfg = BALANCE.RECRUITMENT_MARKET;
  const skillMean = cfg.BASE_SKILL_MEAN + playerState.reputation * cfg.REPUTATION_SKILL_MEAN_BONUS_PER_POINT;
  return Array.from({ length: cfg.POOL_SIZE }, () =>
    generateCandidate({
      skillMean,
      skillSpread: cfg.SKILL_SPREAD,
      minAge: cfg.MIN_AGE,
      maxAge: cfg.MAX_AGE,
      costBase: cfg.COST_BASE,
      costGrowthPerRatingPoint: cfg.COST_GROWTH_PER_RATING_POINT,
      minCost: cfg.MIN_COST,
      salaryRatioOfCost: cfg.SALARY_RATIO_OF_COST,
      ageCostMultiplier: cfg.AGE_COST_MULTIPLIER,
      potentialTiers: cfg.POTENTIAL_TIERS,
      rng,
    })
  );
}

/**
 * Seeds a brand-new rival gym with a starting roster of real-named fighters
 * at game creation (see web/app.js's btnNewGame handler) — without this, a
 * rival gym added via WorldState#addRivalGym starts with an empty roster
 * (roster: []), and since engine/Matchmaking.js now forbids a competitive
 * bout between two of the player's own fighters, a fresh game would have
 * literally no legal opponent to fight until engine/TransferMarket.js's own
 * once-a-season autonomous recruiting eventually fills one in. Quality
 * scales with the given `reputation`, same "State drives generation"
 * precedent as generateRecruitmentPool. Pure: returns plain Fighter
 * instances, never touches WorldState itself.
 *
 * @param {Object} options
 * @param {number} options.reputation - The rival gym's own reputation (0-100).
 * @param {number} [options.count=3]
 * @param {() => number} [options.rng] - Random source in [0, 1). Defaults to Math.random.
 * @returns {Fighter[]}
 */
export function generateRivalGymStarterRoster({ reputation, count = 3, rng = Math.random }) {
  const cfg = BALANCE.RECRUITMENT_MARKET;
  const skillMean = cfg.BASE_SKILL_MEAN + reputation * cfg.REPUTATION_SKILL_MEAN_BONUS_PER_POINT;
  return Array.from({ length: count }, () =>
    generateCandidate({
      skillMean,
      skillSpread: cfg.SKILL_SPREAD,
      minAge: cfg.MIN_AGE,
      maxAge: cfg.MAX_AGE,
      // A rival gym's own roster is never bought by the player — cost/wage
      // are computed but simply discarded below (.fighter only).
      costBase: cfg.COST_BASE,
      costGrowthPerRatingPoint: cfg.COST_GROWTH_PER_RATING_POINT,
      minCost: cfg.MIN_COST,
      salaryRatioOfCost: cfg.SALARY_RATIO_OF_COST,
      rng,
    }).fighter
  );
}

export default { generateRecruitmentPool, generateRivalGymStarterRoster };
