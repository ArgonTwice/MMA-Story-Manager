/**
 * engine/TransferMarket.js — Phase V2.7 ("Le Monde Vivant & Ecosysteme Global")
 * ---------------------------------------------------------------------------
 * Autonomous rival-gym roster management: once per season (see
 * engine/ProgressionEngine.js#advanceWeek's season-boundary hook), every
 * rival gym independently recruits, extends, or releases fighters based on
 * its own Reputation and its roster's age/performance — with zero player
 * involvement, per the spec's "le monde evolue independamment du joueur."
 *
 * Activates two Fighter fields that existed but sat completely unused
 * until now (see models/Fighter.js's own header note on contracts):
 *   - contracts.currentContract: { leagueId, gymId, signedYear, expiresYear }
 *     — written by data/leagues.js#resolveLeagueForReputation against the
 *     signing gym's OWN Reputation, so a fighter's contract genuinely
 *     reflects which of the 4 leagues (data/leagues.js) that gym competes
 *     in right now.
 *   - identity.origin: stamped 'TRANSFER_MARKET' on every fresh recruit,
 *     giving tools/SimRunner.js's Prospect Success Rate telemetry (shared
 *     with engine/ProspectGenerator.js's own wave-sourced fighters) a real,
 *     honest way to trace a fighter back to how they entered the world.
 *
 * Like engine/AcademyEngine.js, rival gym rosters are stored as plain,
 * JSON-serializable Fighter#toJSON() shapes on WorldState (never live
 * Fighter instances — WorldState only ever holds plain data, see its own
 * header) — this module hydrates them into real Fighter instances only
 * transiently, to read/mutate age-driven decisions, then writes the
 * serialized result straight back via WorldState#updateRivalGym.
 * ---------------------------------------------------------------------------
 */

import BALANCE from '../data/balance.js';
import Fighter from '../models/Fighter.js';
import { resolveLeagueForReputation } from '../data/leagues.js';
import { generatePersonality, generateGenderedIdentity, generatePhysicalProfile } from './FighterGenerator.js';

/** Local flavor data for recruit names — not a BALANCE-owned gameplay concept, same precedent as engine/AcademyEngine.js's own FIRST_NAMES/LAST_NAMES (each module keeps its own rather than cross-importing, per this codebase's established convention). Split by gender (V3.5), see engine/FighterGenerator.js#generateGenderedIdentity. */
const MALE_FIRST_NAMES = Object.freeze(['Enzo', 'Leon', 'Mattia', 'Youssef', 'Elio', 'Milo', 'Adam', 'Ravi', 'Kofi', 'Dario']);
const FEMALE_FIRST_NAMES = Object.freeze(['Sana', 'Zoe', 'Chiara', 'Selin', 'Anya', 'Priya']);
const LAST_NAMES = Object.freeze([
  'Bianchi', 'Nowak', 'Fischer', 'Alves', 'Andersson', 'Kimura', 'Osei', 'Delgado',
  'Marchetti', 'Berg', 'Sato', 'Duarte', 'Kowal', 'Vidal', 'Lindqvist', 'Onyango',
]);

const RECRUIT_STYLES = Object.freeze(['Boxe', 'Muay Thai', 'Lutte', 'Jiu-Jitsu Bresilien', 'Freestyle', 'Kickboxing']);
const SKILL_KEYS = Object.freeze(['boxe', 'jambes', 'sol', 'soumission', 'cardio', 'intelligence']);

function pick(rng, list) {
  return list[Math.floor(rng() * list.length)];
}

/** Hydrates a rival gym's stored roster (plain JSON, or already-live Fighter instances) into real Fighter instances. */
function hydrateRoster(roster) {
  return (roster ?? []).map((entry) => (entry instanceof Fighter ? entry : Fighter.fromJSON(entry)));
}

/**
 * Generates one new recruit for a gym, skill-scaled by that gym's own
 * Reputation (mirrors engine/AcademyEngine.js's "State drives generation"
 * pattern) and signed to a contract under whichever league that Reputation
 * currently qualifies for.
 * @param {Object} gym - A rival gym record ({ id, name, reputation }).
 * @param {number} year - WorldState.year at signing time.
 * @param {() => number} rng
 * @returns {Fighter}
 */
function generateRecruit(gym, year, rng) {
  const cfg = BALANCE.TRANSFER_MARKET;
  const league = resolveLeagueForReputation(gym.reputation ?? 0);
  const skillMean = cfg.RECRUIT_SKILL_MEAN_BASE + (gym.reputation ?? 0) * cfg.RECRUIT_REPUTATION_SKILL_MEAN_BONUS_PER_POINT;

  const skills = Object.fromEntries(
    SKILL_KEYS.map((key) => [key, Math.round(skillMean + (rng() * 2 - 1) * cfg.RECRUIT_SKILL_SPREAD)])
  );

  const identity = generateGenderedIdentity(rng, MALE_FIRST_NAMES, FEMALE_FIRST_NAMES, LAST_NAMES);
  const physical = generatePhysicalProfile(rng, identity.gender);

  const fighter = new Fighter({
    identity: {
      name: identity.name,
      age: cfg.RECRUIT_MIN_AGE + Math.floor(rng() * (cfg.RECRUIT_MAX_AGE - cfg.RECRUIT_MIN_AGE + 1)),
      style: pick(rng, RECRUIT_STYLES),
      weightClass: physical.weightClassLabel,
      gender: physical.gender,
      heightCm: physical.heightCm,
      weightKg: physical.weightKg,
      origin: 'TRANSFER_MARKET',
    },
    attributes: { skills },
    psychology: { personality: generatePersonality(rng) },
    contracts: {
      currentContract: { leagueId: league.id, gymId: gym.id, signedYear: year, expiresYear: year + cfg.NEW_CONTRACT_YEARS },
    },
  });

  return fighter;
}

/**
 * @param {Fighter} fighter
 * @param {() => number} rng
 * @returns {boolean} True if this fighter's expiring contract should be released rather than extended.
 */
function rollRelease(fighter, rng) {
  const cfg = BALANCE.TRANSFER_MARKET;
  let chance = cfg.BASE_RELEASE_CHANCE;
  if (fighter.identity.age > BALANCE.AGE.DECLINE_START_AGE) chance += cfg.AGE_DECLINE_RELEASE_BONUS;
  if (fighter.getOverallRating() < cfg.LOW_RATING_THRESHOLD) chance += cfg.LOW_RATING_RELEASE_BONUS;
  return rng() < chance;
}

/**
 * Runs one season's worth of autonomous transfer-market activity across
 * every rival gym: existing fighters whose contract has expired are
 * extended or released, then a gym under its roster target may recruit one
 * new fighter. Publishes a RIVAL_SIGNING/RIVAL_EXTENSION/RIVAL_RELEASE
 * global event per action (see WorldState#addGlobalEvent) so
 * ui/WorldFeed.js can surface it.
 *
 * @param {Object} worldState - A WorldState instance.
 * @param {Object} [options]
 * @param {() => number} [options.rng] - Random source in [0, 1). Defaults to Math.random.
 * @returns {{ signings: Object[], extensions: Object[], releases: Object[] }}
 */
export function processTransferMarket(worldState, options = {}) {
  const rng = options.rng ?? Math.random;
  const cfg = BALANCE.TRANSFER_MARKET;
  const year = worldState.year;

  const report = { signings: [], extensions: [], releases: [] };

  for (const gym of worldState.rivalGyms) {
    const roster = hydrateRoster(gym.roster);
    const kept = [];

    for (const fighter of roster) {
      const contract = fighter.contracts.currentContract;
      if (contract && year < contract.expiresYear) {
        kept.push(fighter);
        continue;
      }

      if (contract && !rollRelease(fighter, rng)) {
        contract.expiresYear = year + cfg.EXTEND_CONTRACT_YEARS;
        kept.push(fighter);
        report.extensions.push(
          worldState.addGlobalEvent({
            type: 'RIVAL_EXTENSION',
            gymId: gym.id,
            gymName: gym.name ?? gym.id,
            fighterId: fighter.identity.id,
            fighterName: fighter.identity.name,
          })
        );
      } else {
        report.releases.push(
          worldState.addGlobalEvent({
            type: 'RIVAL_RELEASE',
            gymId: gym.id,
            gymName: gym.name ?? gym.id,
            fighterId: fighter.identity.id,
            fighterName: fighter.identity.name,
          })
        );
      }
    }

    if (kept.length < cfg.ROSTER_TARGET_SIZE && rng() < cfg.RECRUIT_CHANCE) {
      const recruit = generateRecruit(gym, year, rng);
      kept.push(recruit);
      report.signings.push(
        worldState.addGlobalEvent({
          type: 'RIVAL_SIGNING',
          gymId: gym.id,
          gymName: gym.name ?? gym.id,
          fighterId: recruit.identity.id,
          fighterName: recruit.identity.name,
          leagueId: recruit.contracts.currentContract.leagueId,
        })
      );
    }

    worldState.updateRivalGym(gym.id, { roster: kept.map((fighter) => fighter.toJSON()) });
  }

  return report;
}

export default { processTransferMarket };
