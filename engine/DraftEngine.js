/**
 * engine/DraftEngine.js
 * ---------------------------------------------------------------------------
 * Player-facing fighter recruitment, in two flavors that share the same
 * generation logic (generateProspectPool):
 *
 *   - Initial Draft ("Mercato de demarrage"): a brand new gym starts with
 *     STRICTLY ZERO fighters (see web/app.js's btnNewGame handler, which no
 *     longer calls the old bootstrapRoster() auto-fill) and must spend its
 *     starting funds signing BALANCE.INITIAL_DRAFT.MIN_PICKS-MAX_PICKS
 *     prospects from a generated pool before entering the gym at all.
 *   - Recruitment Market: the same idea, permanently available (not
 *     gated to once-a-year like engine/AcademyEngine.js's free Academy
 *     Draft, and not autonomous/rival-only like engine/TransferMarket.js)
 *     from the Effectif tab, one signing at a time, any week.
 *
 * Every candidate carries real Prenom+Nom identities via
 * engine/FighterGenerator.js#generateFighterIdentity (data/names.js) —
 * never the old `${style} Prospect` placeholder.
 *
 * Pure generation only, like engine/AcademyEngine.js/engine/TransferMarket.js:
 * this module builds Fighter instances and returns them with a signing
 * cost — it never touches PlayerState itself. The caller (web/app.js)
 * decides whether/when to call PlayerState#addFighter() and
 * PlayerState#changeMoney() for the chosen candidate(s).
 * ---------------------------------------------------------------------------
 */

import BALANCE from '../data/balance.js';
import Fighter from '../models/Fighter.js';
import { generateFighterIdentity, generatePersonality } from './FighterGenerator.js';

const STARTING_STYLES = Object.freeze(['Boxe', 'Muay Thai', 'Lutte', 'Jiu-Jitsu Bresilien', 'Freestyle', 'Kickboxing']);
const SKILL_KEYS = Object.freeze(['boxe', 'jambes', 'sol', 'soumission', 'cardio', 'intelligence']);

function pick(rng, list) {
  return list[Math.floor(rng() * list.length)];
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Generates one candidate ({ fighter, cost }) from a skill mean/spread, an
 * age range, and the CALLER's own cost economy (baseCost/costPerSkillPoint,
 * clamped to [minCost, maxCost]) — the shared shape
 * generateInitialDraftPool/generateRecruitmentPool/
 * generateRivalGymStarterRoster all build on, each with their own pricing
 * (a starting-roster signing bonus is a different economy than the ongoing
 * market's per-skill pricing — see BALANCE.INITIAL_DRAFT vs
 * BALANCE.RECRUITMENT_MARKET).
 * @param {Object} options
 * @param {number} options.skillMean
 * @param {number} options.skillSpread
 * @param {number} options.minAge
 * @param {number} options.maxAge
 * @param {number} options.baseCost
 * @param {number} options.costPerSkillPoint
 * @param {number} options.minCost
 * @param {number} options.maxCost
 * @param {() => number} options.rng
 * @returns {{ fighter: Fighter, cost: number }}
 */
function generateCandidate({ skillMean, skillSpread, minAge, maxAge, baseCost, costPerSkillPoint, minCost, maxCost, rng }) {
  const identity = generateFighterIdentity(rng);

  const skills = Object.fromEntries(
    SKILL_KEYS.map((key) => [key, Math.max(1, Math.round(skillMean + (rng() * 2 - 1) * skillSpread))])
  );

  const fighter = new Fighter({
    identity: {
      name: identity.name,
      age: minAge + Math.floor(rng() * (maxAge - minAge + 1)),
      style: pick(rng, STARTING_STYLES),
      weightClass: 'Poids Welter',
    },
    attributes: { skills },
    psychology: { personality: generatePersonality(rng) },
  });

  const skillMeanActual = Object.values(skills).reduce((sum, value) => sum + value, 0) / SKILL_KEYS.length;
  const cost = Math.round(clamp(baseCost + costPerSkillPoint * skillMeanActual, minCost, maxCost));

  return { fighter, cost };
}

/**
 * Generates the "Mercato de demarrage" pool a brand-new gym drafts its very
 * first roster from — see BALANCE.INITIAL_DRAFT for pool size/age/skill
 * tuning. Pure: never touches PlayerState/WorldState.
 *
 * @param {Object} [options]
 * @param {() => number} [options.rng] - Random source in [0, 1). Defaults to Math.random.
 * @returns {{ fighter: Fighter, cost: number }[]}
 */
export function generateInitialDraftPool({ rng = Math.random } = {}) {
  const cfg = BALANCE.INITIAL_DRAFT;
  return Array.from({ length: cfg.POOL_SIZE }, () =>
    generateCandidate({
      skillMean: cfg.BASE_SKILL_MEAN,
      skillSpread: cfg.SKILL_SPREAD,
      minAge: cfg.MIN_AGE,
      maxAge: cfg.MAX_AGE,
      baseCost: cfg.SIGNING_BONUS_BASE,
      costPerSkillPoint: cfg.SIGNING_BONUS_PER_SKILL_POINT,
      minCost: cfg.SIGNING_BONUS_MIN,
      maxCost: cfg.SIGNING_BONUS_MAX,
      rng,
    })
  );
}

/**
 * Generates the permanent recruitment market's pool — quality scales with
 * the gym's own Reputation (same "State drives generation" precedent as
 * engine/AcademyEngine.js). Pure: never touches PlayerState/WorldState.
 *
 * @param {Object} options
 * @param {Object} options.playerState - A PlayerState instance (reads .reputation only).
 * @param {() => number} [options.rng] - Random source in [0, 1). Defaults to Math.random.
 * @returns {{ fighter: Fighter, cost: number }[]}
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
      baseCost: cfg.BASE_COST,
      costPerSkillPoint: cfg.COST_PER_SKILL_POINT,
      minCost: 0,
      maxCost: Infinity,
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
      // A rival gym's own roster is never bought by the player — cost is
      // computed but simply discarded below (.fighter only).
      baseCost: cfg.BASE_COST,
      costPerSkillPoint: cfg.COST_PER_SKILL_POINT,
      minCost: 0,
      maxCost: Infinity,
      rng,
    }).fighter
  );
}

export default { generateInitialDraftPool, generateRecruitmentPool, generateRivalGymStarterRoster };
