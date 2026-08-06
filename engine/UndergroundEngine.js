/**
 * engine/UndergroundEngine.js — "Underground Circuit, Special Rulesets &
 * Gym-Stipulation Matches"
 * ---------------------------------------------------------------------------
 * Orchestrates the Underground Circuit's alternative game modes
 * (VALE_TUDO/GAUNTLET/OPEN_WEIGHT) and special rulesets (SUBMISSION_ONLY/
 * KO_NO_JUDGES/STRIKING_STANDUP) on top of the SAME engine/CombatEngine.js
 * every other fight in this game already uses — see setupMatch()'s
 * optional 5th `rules` param and BALANCE.UNDERGROUND for the actual
 * mechanical implementation of each flag. This module's own job is just
 * translating a (mode, ruleset) pair into the right `rules` object and, for
 * Gauntlet Survival, orchestrating several sequential fights.
 *
 * Underground fights resolve via CombatEngine#simulateFullMatch() (the same
 * headless-instant-sim method tools/SimRunner.js and the "instant-sim" path
 * already use) rather than the manual round-by-round Fight Night flow
 * ui/FightNightView.js drives for normal bouts — Underground fights are
 * meant to read as fast, high-stakes, unregulated encounters, not another
 * per-round gameplan-picking session; see pickGameplan() below for the
 * simple style-driven AI both corners use instead.
 *
 * Gym-stipulation stakes (equipment, loyalty, contracts, sponsorships) are
 * a deliberately separate concern — see engine/GymStipulations.js, which
 * consumes this module's fight results but never the other way around.
 * ---------------------------------------------------------------------------
 */

import BALANCE from '../data/balance.js';
import { CombatEngine } from './CombatEngine.js';

/** The three alternative game-mode structures the Underground Circuit offers. */
export const UNDERGROUND_MODES = Object.freeze({
  VALE_TUDO: 'VALE_TUDO',
  GAUNTLET: 'GAUNTLET',
  OPEN_WEIGHT: 'OPEN_WEIGHT',
});

/** The three special win-condition rulesets, independently composable with any mode (or none). */
export const UNDERGROUND_RULESETS = Object.freeze({
  SUBMISSION_ONLY: 'SUBMISSION_ONLY',
  KO_NO_JUDGES: 'KO_NO_JUDGES',
  STRIKING_STANDUP: 'STRIKING_STANDUP',
});

/** orgId every Underground fight is booked under — deliberately outside data/leagues.js's 4 sanctioned promotions (this circuit is, by definition, not one of them). */
export const UNDERGROUND_ORG_ID = 'UNDERGROUND';

const TEMPO_KEYS = Object.freeze(['CONSERVATIVE', 'BALANCED', 'AGGRESSIVE']);

function pick(rng, list) {
  return list[Math.floor(rng() * list.length)];
}

function assertValidMode(mode, { allowGauntlet }) {
  if (mode === null || mode === undefined) return;
  if (!Object.values(UNDERGROUND_MODES).includes(mode)) {
    throw new TypeError(`UndergroundEngine: invalid mode "${mode}".`);
  }
  if (mode === UNDERGROUND_MODES.GAUNTLET && !allowGauntlet) {
    throw new TypeError('UndergroundEngine: GAUNTLET is not a single-fight mode — use runGauntlet() instead.');
  }
}

function assertValidRuleset(ruleset) {
  if (ruleset === null || ruleset === undefined) return;
  if (!Object.values(UNDERGROUND_RULESETS).includes(ruleset)) {
    throw new TypeError(`UndergroundEngine: invalid ruleset "${ruleset}".`);
  }
}

/**
 * Picks a gameplan reflecting a fighter's own strengths — the same spirit
 * as tools/SimRunner.js's own gameplanForStyle() headless coach-AI, kept as
 * this module's own local (simplified, no clinch-chance roll) copy rather
 * than importing SimRunner's, matching this codebase's established
 * "small per-module AI/flavor helper" precedent (see
 * engine/TransferMarket.js/engine/ProspectGenerator.js's own name lists).
 *
 * Submission Only overrides both corners to GROUND regardless of style:
 * with no legal win except a submission, an AI that never attempted
 * takedowns would make the ruleset structurally unable to ever resolve.
 *
 * @param {Fighter} fighter
 * @param {string|null} ruleset
 * @param {() => number} rng
 * @returns {{ target: string, distance: string, tempo: string }}
 */
function pickGameplan(fighter, ruleset, rng) {
  if (ruleset === UNDERGROUND_RULESETS.SUBMISSION_ONLY) {
    return { target: 'BODY', distance: 'GROUND', tempo: pick(rng, TEMPO_KEYS) };
  }

  const styleBonus = BALANCE.COMBAT.STYLE_BONUSES[fighter.identity.style] ?? BALANCE.COMBAT.STYLE_BONUSES.DEFAULT;
  const distance = styleBonus.distance ?? 'STRIKING';
  let target = 'HEAD';
  if (styleBonus.targetMultipliers) {
    target = Object.keys(styleBonus.targetMultipliers).reduce((best, candidate) =>
      styleBonus.targetMultipliers[candidate] > (styleBonus.targetMultipliers[best] ?? 0) ? candidate : best
    );
  }
  return { target, distance, tempo: pick(rng, TEMPO_KEYS) };
}

/**
 * Translates a (mode, ruleset) pair into CombatEngine.setupMatch()'s
 * `rules` param. Modes and rulesets are independently composable (e.g. a
 * plain Underground bout can still be fought Submission Only).
 * @param {{ mode: string|null, ruleset: string|null }} options
 * @returns {Object}
 */
function buildCombatRules({ mode, ruleset }) {
  const rules = {};

  if (mode === UNDERGROUND_MODES.VALE_TUDO) {
    const cfg = BALANCE.UNDERGROUND.VALE_TUDO;
    rules.noRoundLimit = true;
    rules.valeTudo = true;
    rules.injuryRiskMultiplier = cfg.INJURY_RISK_MULTIPLIER;
    rules.purseMultiplier = cfg.PURSE_MULTIPLIER;
  }
  if (mode === UNDERGROUND_MODES.OPEN_WEIGHT) {
    rules.openWeight = true;
  }

  if (ruleset === UNDERGROUND_RULESETS.SUBMISSION_ONLY) rules.submissionOnly = true;
  if (ruleset === UNDERGROUND_RULESETS.KO_NO_JUDGES) rules.noDecision = true;
  if (ruleset === UNDERGROUND_RULESETS.STRIKING_STANDUP) rules.noTakedowns = true;

  return rules;
}

/**
 * Runs a single Underground Circuit fight to completion.
 *
 * @param {Object} options
 * @param {Fighter} options.fighterA
 * @param {Fighter} options.fighterB
 * @param {string|null} [options.mode] - One of UNDERGROUND_MODES (VALE_TUDO/OPEN_WEIGHT only — GAUNTLET is not a single-fight mode, see runGauntlet()), or null.
 * @param {string|null} [options.ruleset] - One of UNDERGROUND_RULESETS, or null for standard win conditions.
 * @param {Object|null} [options.playerState]
 * @param {Object|null} [options.worldState]
 * @param {() => number} [options.rng]
 * @returns {Object} The CombatEngine result (same shape as the 'combat:finished' event payload).
 */
export function runUndergroundFight({ fighterA, fighterB, mode = null, ruleset = null, playerState = null, worldState = null, rng = Math.random }) {
  assertValidMode(mode, { allowGauntlet: false });
  assertValidRuleset(ruleset);

  const rules = buildCombatRules({ mode, ruleset });
  const engine = new CombatEngine({ playerState, worldState, rng });
  engine.setupMatch(fighterA, fighterB, UNDERGROUND_ORG_ID, false, rules);
  engine.setGameplan('A', pickGameplan(engine.context.fighters.A, ruleset, rng));
  engine.setGameplan('B', pickGameplan(engine.context.fighters.B, ruleset, rng));
  return engine.simulateFullMatch();
}

/**
 * Runs a Gauntlet Survival: `runner` fights each of `opponents` in order,
 * recovering only BALANCE.UNDERGROUND.GAUNTLET.STAMINA_RECOVERY_FRACTION of
 * their stamina DEFICIT between bouts (see CombatEngine's
 * rules.startingStaminaOverride), stopping the instant the runner fails to
 * win one bout (a survival test, not a points competition — a draw ends
 * the run exactly like a loss does).
 *
 * `runner` is the SAME Fighter instance across every bout in the run — its
 * moral/injuries/career record naturally carry over via CombatEngine's own
 * normal per-fight mutations (recordFightResult/adjustMorale/applyInjury),
 * with no extra plumbing needed here.
 *
 * @param {Object} options
 * @param {Fighter} options.runner - The player's fighter making the run.
 * @param {Fighter[]} options.opponents - BALANCE.UNDERGROUND.GAUNTLET.MIN_OPPONENTS-MAX_OPPONENTS opponents, fought in array order.
 * @param {string|null} [options.ruleset] - One of UNDERGROUND_RULESETS, applied to every bout in the run.
 * @param {Object|null} [options.playerState]
 * @param {Object|null} [options.worldState]
 * @param {() => number} [options.rng]
 * @returns {{ survived: boolean, opponentsDefeated: number, totalOpponents: number, fightResults: Object[] }}
 */
export function runGauntlet({ runner, opponents, ruleset = null, playerState = null, worldState = null, rng = Math.random }) {
  assertValidRuleset(ruleset);
  const cfg = BALANCE.UNDERGROUND.GAUNTLET;
  if (opponents.length < cfg.MIN_OPPONENTS || opponents.length > cfg.MAX_OPPONENTS) {
    throw new TypeError(`runGauntlet: expected ${cfg.MIN_OPPONENTS}-${cfg.MAX_OPPONENTS} opponents, got ${opponents.length}.`);
  }

  const rules = buildCombatRules({ mode: null, ruleset });
  const fightResults = [];
  let runnerStaminaFraction = null; // null = full stamina (first fight); afterwards, a carried-over fraction.
  let survived = true;
  let opponentsDefeated = 0;

  for (const opponent of opponents) {
    const engine = new CombatEngine({ playerState, worldState, rng });
    engine.setupMatch(runner, opponent, UNDERGROUND_ORG_ID, false, rules);

    const runnerKey = engine.context.fighters.A.identity.id === runner.identity.id ? 'A' : 'B';
    const startingStaminaFraction =
      runnerStaminaFraction === null ? 1 : runnerStaminaFraction + cfg.STAMINA_RECOVERY_FRACTION * (1 - runnerStaminaFraction);
    if (runnerStaminaFraction !== null) {
      engine.context.rules.startingStaminaOverride[runnerKey] = startingStaminaFraction;
    }

    engine.setGameplan('A', pickGameplan(engine.context.fighters.A, ruleset, rng));
    engine.setGameplan('B', pickGameplan(engine.context.fighters.B, ruleset, rng));
    const result = engine.simulateFullMatch();
    // Enrich the raw CombatEngine result with gauntlet-specific context —
    // which corner was the runner, and what stamina fraction they actually
    // started this bout at (1 for the opener, a carried-over fraction for
    // every bout after) — useful for both narration and testing.
    fightResults.push({ ...result, gauntletRunnerCorner: runnerKey, gauntletStartingStaminaFraction: startingStaminaFraction });

    runnerStaminaFraction = engine.context.live[runnerKey].stamina / engine.context.live[runnerKey].staminaMax;

    if (result.winner === runnerKey) {
      opponentsDefeated += 1;
    } else {
      survived = false;
      break;
    }
  }

  return { survived, opponentsDefeated, totalOpponents: opponents.length, fightResults };
}
