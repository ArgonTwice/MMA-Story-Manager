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
import { FIRST_NAMES, LAST_NAMES } from '../data/names.js';

/**
 * Draws a real "Prenom Nom" identity from data/names.js — the real-name
 * counterpart to the placeholder `${style} Prospect` names
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
 * @returns {{ name: string }}
 */
export function generateFighterIdentity(rng = Math.random) {
  const firstName = FIRST_NAMES[Math.floor(rng() * FIRST_NAMES.length)];
  const lastName = LAST_NAMES[Math.floor(rng() * LAST_NAMES.length)];
  return { name: `${firstName} ${lastName}` };
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
