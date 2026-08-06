/**
 * engine/AcademyEngine.js
 * ---------------------------------------------------------------------------
 * The "Draft Annuel de l'Academie": once per year, the gym's own academy
 * produces a small pool of young prospects the player may look over and
 * promote ONE of for free (BALANCE.ACADEMY_DRAFT.FREE_PICKS_PER_YEAR) — a
 * once-a-year alternative to any paid recruitment, meant to fire at the
 * start of a new year ("Semaine 1").
 *
 * Pool strength scales with the gym's Reputation and facility Level
 * (equipLevel), so a bigger, more prestigious gym attracts sharper
 * prospects — the same "State drives generation" pattern
 * engine/FighterGenerator.js already uses for personality.
 *
 * Pure generation only: like FighterGenerator.js, this module builds
 * Fighter instances and returns them — it never adds them to the roster or
 * mutates PlayerState itself. The caller (web/app.js today, ui/ tomorrow)
 * decides whether/when to call PlayerState#addFighter() with the chosen
 * candidate and PlayerState#recordAcademyDraftOffer() to consume the year's
 * window, exactly like ui/WeeklyFlowController.js stays a thin orchestrator
 * over engine calls rather than mutating state inline itself.
 * ---------------------------------------------------------------------------
 */

import BALANCE from '../data/balance.js';
import Fighter from '../models/Fighter.js';
import { generatePersonality } from './FighterGenerator.js';

/** Local flavor data for prospect names — not a BALANCE-owned gameplay concept, same precedent as tools/SimRunner.js's own FIRST_NAMES/LAST_NAMES. */
const FIRST_NAMES = Object.freeze([
  'Alex', 'Sacha', 'Kylian', 'Noe', 'Malo', 'Ines', 'Yanis', 'Lena',
  'Rayan', 'Camille', 'Diego', 'Amina', 'Kenji', 'Nina', 'Bruno', 'Fatou',
]);
const LAST_NAMES = Object.freeze([
  'Moreau', 'Silva', 'Nakamura', 'Diallo', 'Kowalski', 'Rossi', 'Novak', 'Santos',
  'Petit', 'Ivanov', 'Costa', 'Haddad', 'Larsson', 'Okafor', 'Dubois', 'Reyes',
]);

/** Same style roster the mobile app bootstraps a new gym with (web/app.js's STARTING_ROSTER_STYLES) — kept local rather than imported, matching this file's own "local flavor data" precedent above. */
const ACADEMY_STYLES = Object.freeze(['Boxe', 'Muay Thai', 'Lutte', 'Jiu-Jitsu Bresilien', 'Freestyle', 'Kickboxing']);

const SKILL_KEYS = Object.freeze(['boxe', 'jambes', 'sol', 'soumission', 'cardio', 'intelligence']);

function pick(rng, list) {
  return list[Math.floor(rng() * list.length)];
}

/**
 * Rolls one of BALANCE.ACADEMY_DRAFT.POTENTIAL_TIERS: the highest tier
 * whose minRoll the roll clears wins (tiers are checked in declaration
 * order, so POTENTIAL_TIERS must stay ordered low-to-high like the balance
 * file declares it).
 * @param {() => number} rng
 * @returns {{ key: string, label: string, skillMeanBonus: number }}
 */
function rollPotentialTier(rng) {
  const tiers = BALANCE.ACADEMY_DRAFT.POTENTIAL_TIERS;
  const roll = rng();
  let selected = null;
  for (const [key, tier] of Object.entries(tiers)) {
    if (roll >= tier.minRoll) selected = { key, ...tier };
  }
  return selected;
}

/**
 * Generates this year's academy prospect pool. Pure/deterministic given a
 * fixed rng — does not touch PlayerState/WorldState beyond reading from
 * them, and never adds anything to the roster.
 *
 * @param {Object} options
 * @param {Object} options.playerState - A PlayerState instance (reads .reputation/.equipLevel only).
 * @param {() => number} [options.rng] - Random source in [0, 1). Defaults to Math.random.
 * @returns {{ fighter: Fighter, potentialKey: string, potentialLabel: string }[]}
 */
export function generateAcademyPool({ playerState, rng = Math.random }) {
  const cfg = BALANCE.ACADEMY_DRAFT;
  const poolSize = cfg.POOL_SIZE_MIN + Math.floor(rng() * (cfg.POOL_SIZE_MAX - cfg.POOL_SIZE_MIN + 1));

  const reputationBonus = playerState.reputation * cfg.REPUTATION_SKILL_MEAN_BONUS_PER_POINT;
  const facilityBonus = playerState.equipLevel * cfg.FACILITY_LEVEL_SKILL_MEAN_BONUS;

  const pool = [];
  for (let i = 0; i < poolSize; i += 1) {
    const potential = rollPotentialTier(rng);
    const skillMean = cfg.BASE_SKILL_MEAN + reputationBonus + facilityBonus + potential.skillMeanBonus;

    const skills = Object.fromEntries(
      SKILL_KEYS.map((key) => [key, Math.round(skillMean + (rng() * 2 - 1) * cfg.SKILL_SPREAD)])
    );

    const fighter = new Fighter({
      identity: {
        name: `${pick(rng, FIRST_NAMES)} ${pick(rng, LAST_NAMES)}`,
        age: cfg.MIN_AGE + Math.floor(rng() * (cfg.MAX_AGE - cfg.MIN_AGE + 1)),
        style: pick(rng, ACADEMY_STYLES),
        weightClass: 'Poids Welter',
      },
      attributes: { skills },
      psychology: { personality: generatePersonality(rng) },
    });

    pool.push({ fighter, potentialKey: potential.key, potentialLabel: potential.label });
  }

  return pool;
}

/**
 * Whether the free Academy Draft pick is still available this year.
 * @param {Object} playerState - A PlayerState instance.
 * @param {number} year - The current WorldState.year.
 * @returns {boolean}
 */
export function isAcademyDraftAvailable(playerState, year) {
  return playerState.lastAcademyDraftYear !== year;
}

export default { generateAcademyPool, isAcademyDraftAvailable };
