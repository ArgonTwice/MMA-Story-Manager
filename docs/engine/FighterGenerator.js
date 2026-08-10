/**
 * engine/FighterGenerator.js — Pyramide Emergente support utility
 * ---------------------------------------------------------------------------
 * Randomly assigns a valid Personality (archetype + traits) to a newly
 * generated fighter, entirely from BALANCE.PERSONALITY — never from
 * models/Fighter.js, which is explicitly RNG-free by design (see its file
 * header: "Randomness... belong[s] to Engine"). Any code path that
 * programmatically creates a Fighter — today that's
 * ProgressionEngine's headless rival-gym prospects, tomorrow a full
 * recruitment pool — should call generatePersonality() instead of leaving
 * new fighters on Fighter's flat default (DEFAULT_ARCHETYPE, no traits),
 * so the personality system actually produces narrative variety across the
 * roster of fighters the player never hand-built themselves.
 *
 * Absolute decoupling: imports only data/balance.js. No EventBus needed —
 * this is a pure(-ish, RNG-injected) generator, not a reactive engine.
 * ---------------------------------------------------------------------------
 */

import BALANCE from '../data/balance.js';
import { MALE_FIRST_NAMES, FEMALE_FIRST_NAMES, LAST_NAMES } from '../data/names.js';

function pick(rng, list) {
  return list[Math.floor(rng() * list.length)];
}

/**
 * Rolls a gender (BALANCE.PHYSICAL.GENDERS, ~50/50) then a matching first
 * name from whichever gendered pool the caller supplies — the shared logic
 * behind generateFighterIdentity() (data/names.js, the player's own
 * Recruitment Market) and every rival-gym-facing generator's own local
 * name pool (AcademyEngine/ProspectGenerator/TransferMarket keep separate
 * small pools by this codebase's established convention — only the
 * gender+pick LOGIC is shared here, not the pools themselves).
 *
 * @param {() => number} rng
 * @param {string[]} maleFirstNames
 * @param {string[]} femaleFirstNames
 * @param {string[]} lastNames
 * @returns {{ name: string, gender: 'M'|'F' }}
 */
export function generateGenderedIdentity(rng, maleFirstNames, femaleFirstNames, lastNames) {
  const gender = rng() < 0.5 ? 'M' : 'F';
  const firstName = pick(rng, gender === 'M' ? maleFirstNames : femaleFirstNames);
  const lastName = pick(rng, lastNames);
  return { name: `${firstName} ${lastName}`, gender };
}

/**
 * Draws a real "Prenom Nom" identity (+ gender) from data/names.js — the
 * real-name counterpart to the placeholder `${style} Prospect` names
 * web/app.js#bootstrapRoster used to stamp on every brand-new gym's
 * starting roster. Deliberately does NOT assign a nickname: Fighter#identity.nickname
 * is an emergent, career-earned field (see data/nicknames.js/
 * Fighter#evaluateNickname, "Surnoms Emergents") that recordFightResult()
 * recomputes and overwrites from career deeds on every fight — a nickname
 * handed out here at generation would just get silently clobbered (or
 * worse, sit unexplained on a fighter with zero fights), so nicknames stay
 * earned, never randomly assigned at birth.
 *
 * @param {() => number} [rng] - Random source in [0, 1). Defaults to Math.random.
 * @returns {{ name: string, gender: 'M'|'F' }}
 */
export function generateFighterIdentity(rng = Math.random) {
  return generateGenderedIdentity(rng, MALE_FIRST_NAMES, FEMALE_FIRST_NAMES, LAST_NAMES);
}

/**
 * Rolls a full physical profile consistent with the given gender: a
 * gendered weight class (BALANCE.PHYSICAL.WEIGHT_CLASSES), a realistic
 * weigh-in weightKg a few kg under that class's cap, and an independent
 * heightCm within the gender's realistic range (real fighters of the same
 * weight class vary widely in height — tying height to weight class would
 * be LESS realistic, not more).
 *
 * @param {() => number} [rng] - Random source in [0, 1). Defaults to Math.random.
 * @param {'M'|'F'} [gender] - Defaults to a fresh 50/50 roll if omitted.
 * @returns {{ gender: 'M'|'F', weightClassId: string, weightClassLabel: string, heightCm: number, weightKg: number }}
 */
export function generatePhysicalProfile(rng = Math.random, gender = null) {
  const cfg = BALANCE.PHYSICAL;
  const resolvedGender = gender ?? (rng() < 0.5 ? 'M' : 'F');

  const weightClass = pick(rng, cfg.WEIGHT_CLASSES[resolvedGender]);
  const classIndex = cfg.WEIGHT_CLASSES[resolvedGender].indexOf(weightClass);
  const previousMaxKg = classIndex > 0 ? cfg.WEIGHT_CLASSES[resolvedGender][classIndex - 1].maxKg : weightClass.maxKg - cfg.WEIGHT_UNDER_CAP_KG * 2;
  const weightFloorKg = Math.max(previousMaxKg, weightClass.maxKg - cfg.WEIGHT_UNDER_CAP_KG);
  const weightKg = Math.round((weightFloorKg + rng() * (weightClass.maxKg - weightFloorKg)) * 10) / 10;

  const heightRange = cfg.HEIGHT_CM[resolvedGender];
  const heightCm = Math.round(heightRange.MIN + rng() * (heightRange.MAX - heightRange.MIN));

  return {
    gender: resolvedGender,
    weightClassId: weightClass.id,
    weightClassLabel: weightClass.label,
    heightCm,
    weightKg,
  };
}

/**
 * @param {() => number} [rng] - Random source in [0, 1). Defaults to Math.random.
 * @returns {{ archetype: string, traits: string[] }} A valid personality,
 *   ready to pass as `new Fighter({ psychology: { personality } })`.
 */
export function generatePersonality(rng = Math.random) {
  const cfg = BALANCE.PERSONALITY.GENERATION;

  const archetypeKeys = Object.keys(BALANCE.PERSONALITY.ARCHETYPES);
  const archetype = archetypeKeys[Math.floor(rng() * archetypeKeys.length)];

  const remainingTraits = Object.keys(BALANCE.PERSONALITY.TRAITS);
  const traitCount = cfg.MIN_TRAITS + Math.floor(rng() * (cfg.MAX_TRAITS - cfg.MIN_TRAITS + 1));

  const traits = [];
  for (let i = 0; i < traitCount && remainingTraits.length > 0; i += 1) {
    const index = Math.floor(rng() * remainingTraits.length);
    traits.push(remainingTraits.splice(index, 1)[0]);
  }

  return { archetype, traits };
}
