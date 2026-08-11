/**
 * tools/BalanceSimulation.test.js
 * ---------------------------------------------------------------------------
 * The "50 saisons automatiques" balance validator: runs 50 independent,
 * seeded, headless SimRunner games (via runSimulation) and checks two
 * things a healthy economy should satisfy:
 *
 *   1. No crash — including right at day 1 (a fresh newGame(), before any
 *      week has resolved, must never carry a negative or non-finite
 *      balance).
 *   2. A "sain" bankruptcy rate across a normal-length playthrough (8
 *      seasons = 2 in-game years). V3.8 deliberately fixed the "Local
 *      Modeste" starting tier's rent at exactly 500$/week (BALANCE.ECONOMY
 *      .BASE_WEEKLY_UPKEEP, down from 1700$) to soften the early-game
 *      economy — a healthy run now realistically never goes bankrupt over
 *      a mere 2 in-game years, so the floor of the tolerance band is 0%.
 *      The ceiling (30%) is the signal that still matters here: an economy
 *      that ALWAYS bankrupts a normal playthrough would be the real bug
 *      this guards against.
 *
 * SimRunner-spawned fighters don't go through engine/DraftEngine.js's
 * signing flow, so they carry no Fighter#weeklySalary by default (a
 * deliberate SimRunner simplification, unrelated to this validator). This
 * file assigns a realistic weekly wage to each spawned fighter — via
 * runSimulation's optional afterRosterSpawned hook — using the exact same
 * signing-cost formula engine/DraftEngine.js's Recruitment Market already
 * uses (BALANCE.RECRUITMENT_MARKET), so the simulated gym carries the same
 * payroll burden a real player's roster would.
 *
 * Run with: node --test tools/BalanceSimulation.test.js
 * or:       npm run test:balance
 * ---------------------------------------------------------------------------
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import BALANCE from '../data/balance.js';
import { runSimulation } from './SimRunner.js';

const RUN_COUNT = 50;
const SEASONS_PER_RUN = 8; // 2 in-game years (WEEKS_PER_SEASON=13, SEASONS_PER_YEAR=4) — a "partie normale".
const ROSTER_SIZE = 8;

const HEALTHY_BANKRUPTCY_RATE_MIN = 0;
const HEALTHY_BANKRUPTCY_RATE_MAX = 0.3;

/** Assigns each spawned fighter a realistic weekly wage, mirroring engine/DraftEngine.js's own signing-cost formula (cost = max(MIN_COST, COST_BASE * COST_GROWTH_PER_RATING_POINT ** rating); salary = cost * SALARY_RATIO_OF_COST) — see this file's header. */
function assignRealisticSalaries(playerState) {
  const cfg = BALANCE.RECRUITMENT_MARKET;
  for (const fighter of playerState.roster) {
    const rating = fighter.getOverallRating();
    const cost = Math.max(cfg.MIN_COST, Math.round(cfg.COST_BASE * cfg.COST_GROWTH_PER_RATING_POINT ** rating));
    fighter.weeklySalary = Math.round(cost * cfg.SALARY_RATIO_OF_COST);
  }
}

function runOneGame(seed) {
  return runSimulation({
    seasons: SEASONS_PER_RUN,
    rosterSize: ROSTER_SIZE,
    seed,
    afterRosterSpawned: assignRealisticSalaries,
  });
}

test('day 1: a fresh game never starts already insolvent, regardless of seed', () => {
  for (let seed = 0; seed < RUN_COUNT; seed += 1) {
    const result = runOneGame(seed);
    assert.ok(Number.isFinite(result.economy.maxBalanceEver), `seed ${seed}: maxBalanceEver should be finite`);
    assert.ok(result.economy.maxBalanceEver > 0, `seed ${seed}: the gym should hold positive funds at some point (day 1 starting funds)`);
  }
});

test('50 independent 2-year games (8 seasons each) never crash, across a spread of seeds', () => {
  const results = [];
  for (let seed = 0; seed < RUN_COUNT; seed += 1) {
    assert.doesNotThrow(() => {
      results.push(runOneGame(seed));
    }, `seed ${seed} crashed the simulation`);
  }
  assert.equal(results.length, RUN_COUNT);
});

test('the bankruptcy rate across 50 games stays within a healthy band (V3.8 softened economy: 0-30% tolerance, an always-bankrupt economy is the real regression this guards against)', () => {
  let bankruptRuns = 0;
  for (let seed = 0; seed < RUN_COUNT; seed += 1) {
    const result = runOneGame(seed);
    if (result.economy.insolvencyWeeks > 0) bankruptRuns += 1;
  }

  const rate = bankruptRuns / RUN_COUNT;
  // eslint-disable-next-line no-console
  console.log(`[test:balance] bankruptcy rate over ${RUN_COUNT} games (${SEASONS_PER_RUN} seasons each): ${bankruptRuns}/${RUN_COUNT} = ${(rate * 100).toFixed(1)}%`);

  assert.ok(
    rate >= HEALTHY_BANKRUPTCY_RATE_MIN && rate <= HEALTHY_BANKRUPTCY_RATE_MAX,
    `bankruptcy rate ${(rate * 100).toFixed(1)}% is outside the healthy [${HEALTHY_BANKRUPTCY_RATE_MIN * 100}-${HEALTHY_BANKRUPTCY_RATE_MAX * 100}]% band`
  );
});
