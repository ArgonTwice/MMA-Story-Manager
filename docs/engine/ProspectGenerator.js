/**
 * engine/ProspectGenerator.js — Phase V2.7 ("Le Monde Vivant & Ecosysteme Global")
 * ---------------------------------------------------------------------------
 * Every BALANCE.PROSPECT_GENERATOR.WAVE_INTERVAL_YEARS years (3, by
 * default), the world produces a themed "Cuvee de Prospects" — a batch of
 * fresh fighters leaning into one skill archetype (Lutteurs/Strikers/
 * Grapplers, see data/balance.js's own THEMES) — distributed across rival
 * gym rosters, entirely independent of the player (see
 * engine/ProgressionEngine.js#advanceWeek's year-boundary hook).
 *
 * Every wave-generated fighter is stamped identity.origin =
 * `PROSPECT_WAVE:<theme>:<year>` — the same provenance convention
 * engine/TransferMarket.js uses for its own recruits — so
 * tools/SimRunner.js's Prospect Success Rate telemetry can trace a
 * fighter's eventual career back to how they entered the world, honestly,
 * without inventing a parallel tracking system.
 *
 * Like engine/TransferMarket.js, rival gym rosters are read/written as
 * plain Fighter#toJSON() shapes on WorldState — this module hydrates
 * nothing except the freshly-generated prospects themselves (which start
 * as real Fighter instances, then get serialized once assigned to a gym).
 * ---------------------------------------------------------------------------
 */

import BALANCE from '../data/balance.js';
import Fighter from '../models/Fighter.js';
import { resolveLeagueForReputation } from '../data/leagues.js';
import { generatePersonality, generateGenderedIdentity, generatePhysicalProfile } from './FighterGenerator.js';

/** Local flavor data for prospect names — see engine/TransferMarket.js's own header note on why each module keeps its own rather than cross-importing. Split by gender (V3.5), see engine/FighterGenerator.js#generateGenderedIdentity. */
const MALE_FIRST_NAMES = Object.freeze(['Theo', 'Amir', 'Luca', 'Bilal', 'Tomas', 'Erik', 'Kwame', 'Dante']);
const FEMALE_FIRST_NAMES = Object.freeze(['Ines', 'Nadia', 'Romy', 'Layla', 'Sofia', 'Mira', 'Aiko', 'Noor']);
const LAST_NAMES = Object.freeze([
  'Weber', 'Costa', 'Nilsson', 'Haddad', 'Rocha', 'Petrov', 'Adeyemi', 'Lund',
  'Moreno', 'Chikara', 'Baptiste', 'Serrano', 'Voss', 'Amara', 'Girard', 'Tanaka',
]);

const SKILL_KEYS = Object.freeze(['boxe', 'jambes', 'sol', 'soumission', 'cardio', 'intelligence']);

function pick(rng, list) {
  return list[Math.floor(rng() * list.length)];
}

/**
 * @param {Object} worldState - A WorldState instance.
 * @returns {boolean} True if a new wave is due this year (a WAVE_INTERVAL_YEARS
 *   boundary that hasn't already produced a wave — see WorldState#recordProspectWave).
 */
export function isProspectWaveDue(worldState) {
  const interval = BALANCE.PROSPECT_GENERATOR.WAVE_INTERVAL_YEARS;
  if (worldState.year % interval !== 0) return false;
  return worldState.lastProspectWaveYear !== worldState.year;
}

function generateOneProspect(themeKey, theme, year, rng) {
  const cfg = BALANCE.PROSPECT_GENERATOR;

  const skills = Object.fromEntries(
    SKILL_KEYS.map((key) => {
      const themeBonus = theme.skills.includes(key) ? cfg.THEME_SKILL_BONUS : 0;
      return [key, Math.round(cfg.SKILL_MEAN_BASE + themeBonus + (rng() * 2 - 1) * cfg.SKILL_SPREAD)];
    })
  );

  const identity = generateGenderedIdentity(rng, MALE_FIRST_NAMES, FEMALE_FIRST_NAMES, LAST_NAMES);
  const physical = generatePhysicalProfile(rng, identity.gender);

  return new Fighter({
    identity: {
      name: identity.name,
      age: cfg.MIN_AGE + Math.floor(rng() * (cfg.MAX_AGE - cfg.MIN_AGE + 1)),
      style: pick(rng, theme.styles),
      weightClass: physical.weightClassLabel,
      gender: physical.gender,
      heightCm: physical.heightCm,
      weightKg: physical.weightKg,
      origin: `PROSPECT_WAVE:${themeKey}:${year}`,
    },
    attributes: { skills },
    psychology: { personality: generatePersonality(rng) },
  });
}

/**
 * Generates and distributes this year's prospect wave, if due — callers
 * should guard with isProspectWaveDue() first (see
 * engine/ProgressionEngine.js#advanceWeek), but calling this unconditionally
 * is harmless: it always generates a wave and marks the year regardless.
 *
 * Distribution is round-robin across every rival gym, skipping any gym
 * already at 2x BALANCE.TRANSFER_MARKET.ROSTER_TARGET_SIZE (a wave is
 * meant to flood the world with fresh blood, not grow rosters forever
 * across a long multi-century simulation) — a prospect that finds no room
 * anywhere is still reported in `prospects` but absent from `assignments`.
 *
 * @param {Object} worldState - A WorldState instance.
 * @param {Object} [options]
 * @param {() => number} [options.rng] - Random source in [0, 1). Defaults to Math.random.
 * @returns {{ theme: string, themeLabel: string, prospects: Fighter[], assignments: Object[] }}
 */
export function generateProspectWave(worldState, options = {}) {
  const rng = options.rng ?? Math.random;
  const cfg = BALANCE.PROSPECT_GENERATOR;

  const themeKeys = Object.keys(cfg.THEMES);
  const themeKey = pick(rng, themeKeys);
  const theme = cfg.THEMES[themeKey];

  const waveSize = cfg.WAVE_SIZE_MIN + Math.floor(rng() * (cfg.WAVE_SIZE_MAX - cfg.WAVE_SIZE_MIN + 1));
  const prospects = Array.from({ length: waveSize }, () => generateOneProspect(themeKey, theme, worldState.year, rng));

  const assignments = [];
  const gyms = worldState.rivalGyms;
  const maxRosterSize = BALANCE.TRANSFER_MARKET.ROSTER_TARGET_SIZE * 2;

  if (gyms.length > 0) {
    let gymCursor = 0;
    for (const prospect of prospects) {
      let placed = false;
      for (let attempt = 0; attempt < gyms.length; attempt += 1) {
        const gym = gyms[gymCursor % gyms.length];
        gymCursor += 1;
        const roster = gym.roster ?? [];
        if (roster.length >= maxRosterSize) continue;

        prospect.contracts.currentContract = {
          leagueId: resolveLeagueForReputation(gym.reputation ?? 0).id,
          gymId: gym.id,
          signedYear: worldState.year,
          expiresYear: worldState.year + BALANCE.TRANSFER_MARKET.NEW_CONTRACT_YEARS,
        };
        worldState.updateRivalGym(gym.id, { roster: [...roster, prospect.toJSON()] });
        assignments.push({ gymId: gym.id, fighterId: prospect.identity.id, fighterName: prospect.identity.name });
        placed = true;
        break;
      }
      if (!placed) break; // every gym is full — later prospects would fare no better.
    }
  }

  worldState.addGlobalEvent({
    type: 'PROSPECT_WAVE',
    theme: themeKey,
    themeLabel: theme.label,
    waveSize: prospects.length,
    placedCount: assignments.length,
    fighterIds: assignments.map((a) => a.fighterId),
  });
  worldState.recordProspectWave(worldState.year);

  return { theme: themeKey, themeLabel: theme.label, prospects, assignments };
}

export default { isProspectWaveDue, generateProspectWave };
