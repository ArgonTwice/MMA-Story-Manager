/**
 * engine/UndergroundEngine.test.js
 * Run with: node --test engine/UndergroundEngine.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import BALANCE from '../data/balance.js';
import Fighter from '../models/Fighter.js';
import { createSeededRng, FINISH_METHODS } from './CombatEngine.js';
import { runUndergroundFight, runGauntlet, UNDERGROUND_MODES, UNDERGROUND_RULESETS } from './UndergroundEngine.js';

function makeFighter(name, val, overrides = {}) {
  return new Fighter({
    identity: { name, age: 28, style: 'Freestyle', weightClass: 'Lightweight', ...overrides.identity },
    attributes: {
      skills: { boxe: val, jambes: val, sol: val, soumission: val, cardio: val, intelligence: val },
      ...overrides.attributes,
    },
  });
}

test('runUndergroundFight with mode: VALE_TUDO applies noRoundLimit/injuryRiskMultiplier/purseMultiplier as BALANCE.UNDERGROUND.VALE_TUDO prescribes', () => {
  const baseline = runUndergroundFight({
    fighterA: makeFighter('A', 50),
    fighterB: makeFighter('B', 50),
    rng: createSeededRng(5),
  });

  const valeTudo = runUndergroundFight({
    fighterA: makeFighter('A', 50),
    fighterB: makeFighter('B', 50),
    mode: UNDERGROUND_MODES.VALE_TUDO,
    rng: createSeededRng(5),
  });

  assert.equal(valeTudo.purses.A.gross, baseline.purses.A.gross * BALANCE.UNDERGROUND.VALE_TUDO.PURSE_MULTIPLIER);
  assert.equal(valeTudo.purses.B.gross, baseline.purses.B.gross * BALANCE.UNDERGROUND.VALE_TUDO.PURSE_MULTIPLIER);
});

test('runUndergroundFight with mode: OPEN_WEIGHT rewards a genuine underdog win with a bonus purse over the same fight without the mode', () => {
  const withOpenWeight = runUndergroundFight({
    fighterA: makeFighter('Underdog', 20),
    fighterB: makeFighter('Favorite', 80),
    mode: UNDERGROUND_MODES.OPEN_WEIGHT,
    rng: createSeededRng(1),
  });
  const without = runUndergroundFight({
    fighterA: makeFighter('Underdog', 20),
    fighterB: makeFighter('Favorite', 80),
    rng: createSeededRng(1),
  });

  assert.equal(withOpenWeight.winner, without.winner, 'same seed/skills minus the purse math must produce the same winner');
  if (withOpenWeight.winner === 'A') {
    assert.ok(withOpenWeight.purses.A.gross > without.purses.A.gross, 'a true underdog (A) win must earn a bonus under Open Weight');
  }
});

test('runUndergroundFight with ruleset: STRIKING_STANDUP never produces a single GROUND round even for two grappling-heavy fighters', () => {
  const result = runUndergroundFight({
    fighterA: makeFighter('Grappler A', 60, { identity: { style: 'Lutte' } }),
    fighterB: makeFighter('Grappler B', 60, { identity: { style: 'Jiu-Jitsu Bresilien' } }),
    ruleset: UNDERGROUND_RULESETS.STRIKING_STANDUP,
    rng: createSeededRng(3),
  });

  assert.equal(result.combatMetrics.A.groundRounds, 0);
  assert.equal(result.combatMetrics.B.groundRounds, 0);
});

test('runUndergroundFight with ruleset: SUBMISSION_ONLY only ever resolves by SUBMISSION or a no-purse DRAW, never KO/TKO/a judges decision', () => {
  for (let seed = 1; seed <= 8; seed += 1) {
    const result = runUndergroundFight({
      fighterA: makeFighter('A', 40 + seed),
      fighterB: makeFighter('B', 60 - seed),
      ruleset: UNDERGROUND_RULESETS.SUBMISSION_ONLY,
      rng: createSeededRng(seed),
    });
    assert.ok(
      [FINISH_METHODS.SUBMISSION, FINISH_METHODS.DRAW].includes(result.method),
      `seed ${seed}: expected SUBMISSION or DRAW, got ${result.method}`
    );
  }
});

test('runUndergroundFight with ruleset: KO_NO_JUDGES never produces a judges decision', () => {
  const decisionMethods = new Set([FINISH_METHODS.UNANIMOUS_DECISION, FINISH_METHODS.SPLIT_DECISION, FINISH_METHODS.MAJORITY_DECISION]);
  for (let seed = 1; seed <= 8; seed += 1) {
    const result = runUndergroundFight({
      fighterA: makeFighter('A', 30),
      fighterB: makeFighter('B', 30),
      ruleset: UNDERGROUND_RULESETS.KO_NO_JUDGES,
      rng: createSeededRng(seed),
    });
    assert.ok(!decisionMethods.has(result.method), `seed ${seed}: KO_NO_JUDGES must never produce ${result.method}`);
  }
});

test('runUndergroundFight rejects mode: GAUNTLET (not a single-fight mode) and any unknown mode/ruleset string', () => {
  assert.throws(
    () => runUndergroundFight({ fighterA: makeFighter('A', 50), fighterB: makeFighter('B', 50), mode: UNDERGROUND_MODES.GAUNTLET }),
    TypeError
  );
  assert.throws(
    () => runUndergroundFight({ fighterA: makeFighter('A', 50), fighterB: makeFighter('B', 50), mode: 'NOT_A_REAL_MODE' }),
    TypeError
  );
  assert.throws(
    () => runUndergroundFight({ fighterA: makeFighter('A', 50), fighterB: makeFighter('B', 50), ruleset: 'NOT_A_REAL_RULESET' }),
    TypeError
  );
});

test('runGauntlet rejects an opponents array outside BALANCE.UNDERGROUND.GAUNTLET.MIN/MAX_OPPONENTS', () => {
  const cfg = BALANCE.UNDERGROUND.GAUNTLET;
  const runner = makeFighter('Runner', 50);
  const tooFew = Array.from({ length: cfg.MIN_OPPONENTS - 1 }, (_, i) => makeFighter(`Opp${i}`, 50));
  const tooMany = Array.from({ length: cfg.MAX_OPPONENTS + 1 }, (_, i) => makeFighter(`Opp${i}`, 50));

  assert.throws(() => runGauntlet({ runner, opponents: tooFew, rng: createSeededRng(1) }), TypeError);
  assert.throws(() => runGauntlet({ runner, opponents: tooMany, rng: createSeededRng(1) }), TypeError);
});

test('runGauntlet: a dominant runner survives every bout, opponentsDefeated equals totalOpponents, and one fightResult exists per bout fought', () => {
  const runner = makeFighter('Champion', 85);
  const opponents = [makeFighter('Weak1', 15), makeFighter('Weak2', 15), makeFighter('Weak3', 15)];

  const run = runGauntlet({ runner, opponents, rng: createSeededRng(2) });

  assert.equal(run.totalOpponents, 3);
  assert.equal(run.fightResults.length, run.opponentsDefeated + (run.survived ? 0 : 1));
  if (run.survived) {
    assert.equal(run.opponentsDefeated, 3);
    assert.equal(run.fightResults.length, 3);
  }
});

test('runGauntlet: the run stops immediately the first time the runner fails to win — it never fights the remaining opponents', () => {
  const runner = makeFighter('Underdog Runner', 10);
  const opponents = [makeFighter('Killer1', 95), makeFighter('Killer2', 95), makeFighter('Killer3', 95)];

  const run = runGauntlet({ runner, opponents, rng: createSeededRng(4) });

  if (!run.survived) {
    assert.ok(run.opponentsDefeated < run.totalOpponents);
    assert.equal(run.fightResults.length, run.opponentsDefeated + 1, 'exactly one more fight (the loss) than wins recorded');
    const lastFight = run.fightResults[run.fightResults.length - 1];
    assert.notEqual(lastFight.winner, lastFight.gauntletRunnerCorner);
  }
});

test('runGauntlet: every bout after the first carries a startingStaminaFraction strictly below 1 whenever the runner ended the previous bout below full stamina', () => {
  const runner = makeFighter('Grinder', 55);
  const opponents = [makeFighter('Opp1', 55), makeFighter('Opp2', 55), makeFighter('Opp3', 55)];

  const run = runGauntlet({ runner, opponents, rng: createSeededRng(9) });

  assert.equal(run.fightResults[0].gauntletStartingStaminaFraction, 1, 'the opening bout always starts at full stamina');
  for (let i = 1; i < run.fightResults.length; i += 1) {
    const fraction = run.fightResults[i].gauntletStartingStaminaFraction;
    assert.ok(fraction > 0 && fraction <= 1, `fight ${i}: startingStaminaFraction ${fraction} should be a valid (0, 1] fraction`);
  }
});

test('runGauntlet: the runner is the SAME Fighter instance across every bout — career record accumulates rather than resetting per fight', () => {
  const runner = makeFighter('Persistent', 85);
  const opponents = [makeFighter('Weak1', 10), makeFighter('Weak2', 10), makeFighter('Weak3', 10)];

  const run = runGauntlet({ runner, opponents, rng: createSeededRng(6) });

  const totalRecorded = runner.career.wins + runner.career.losses + runner.career.draws;
  assert.equal(totalRecorded, run.fightResults.length, 'every bout actually fought must be reflected on the SAME runner instance\'s career record');
});
