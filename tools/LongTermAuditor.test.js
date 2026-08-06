/**
 * tools/LongTermAuditor.test.js
 * Run with: node --test tools/LongTermAuditor.test.js
 *
 * Covers the audit's own pure computation logic with synthetic data —
 * NOT a full multi-duration simulation run (that's what
 * `node tools/LongTermAuditor.js` itself is for, at real scale).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseArgs,
  computeFinancialDrift,
  summarizeDuration,
  computeCrossDurationInflationRatio,
  STYLE_WINRATE_SANITY_BAND,
  LEGENDARY_FIGHTER_RATE_BAND,
  FINANCIAL_INFLATION_RATIO_MAX,
} from './LongTermAuditor.js';

function makeSeasonalMetrics(avgMoneyValues) {
  return avgMoneyValues.map((avgMoney, index) => ({ season: index + 1, weeks: 13, avgMoney, totalFights: 0, dullWeeks: 0, dullWeekRate: 0, insolvencyWeeks: 0 }));
}

function makeSample(overrides = {}) {
  return {
    seasons: 1000,
    seed: 1,
    metaHealth: 96,
    deadWeekRate: 0.04,
    legendaryFighterRate: 0.045,
    hallOfFameCount: 5,
    totalRetired: 110,
    activeLegacyCoaches: 3,
    legacyCoachesHiredTotal: 3,
    financialDrift: { earlyAvg: 100000, lateAvg: 500000, withinRunRatio: 5, lateGameAvgMoney: 500000 },
    styleWinRates: { Boxe: 0.5, Lutte: 0.5 },
    ...overrides,
  };
}

test('parseArgs reads --flag=value and bare --flag pairs', () => {
  const args = parseArgs(['--seeds=10', '--auto', '--durations=100,500']);
  assert.equal(args.seeds, '10');
  assert.equal(args.auto, true);
  assert.equal(args.durations, '100,500');
});

test('computeFinancialDrift returns null for fewer than 10 seasonal samples (too short to slice meaningfully)', () => {
  const metrics = makeSeasonalMetrics([100, 200, 300]);
  assert.equal(computeFinancialDrift(metrics), null);
});

test('computeFinancialDrift computes the within-run early/late ratio and lateGameAvgMoney from the last/first 10%', () => {
  // 20 seasons, avgMoney = season * 50: 10% slice size = 2.
  // first 10% = seasons 1-2 (50, 100) -> avg 75; last 10% = seasons 19-20 (950, 1000) -> avg 975.
  const values = Array.from({ length: 20 }, (_, i) => (i + 1) * 50);
  const metrics = makeSeasonalMetrics(values);

  const drift = computeFinancialDrift(metrics);

  assert.equal(drift.earlyAvg, 75);
  assert.equal(drift.lateAvg, 975);
  assert.equal(drift.withinRunRatio, 975 / 75);
  assert.equal(drift.lateGameAvgMoney, 975);
});

test('computeFinancialDrift.withinRunRatio is null when the early average is exactly 0 (no division by zero)', () => {
  const metrics = makeSeasonalMetrics([0, 0, 0, 0, 0, 0, 0, 0, 0, 500]);
  const drift = computeFinancialDrift(metrics);
  assert.equal(drift.withinRunRatio, null);
  assert.equal(drift.lateGameAvgMoney, 500);
});

test('summarizeDuration pools the Legendary Fighter Rate across every sample (not an average of per-sample rates)', () => {
  const samples = [
    makeSample({ hallOfFameCount: 3, totalRetired: 100 }),
    makeSample({ hallOfFameCount: 1, totalRetired: 50 }),
  ];
  const summary = summarizeDuration(1000, samples);

  assert.equal(summary.totalHallOfFame, 4);
  assert.equal(summary.totalRetired, 150);
  assert.equal(summary.pooledLegendaryRate, 4 / 150);
});

test('summarizeDuration flags stagnantEverywhere only when EVERY sample shows zero coach turnover', () => {
  const allStagnant = summarizeDuration(1000, [
    makeSample({ legacyCoachesHiredTotal: 3, activeLegacyCoaches: 3 }),
    makeSample({ legacyCoachesHiredTotal: 3, activeLegacyCoaches: 3 }),
  ]);
  assert.equal(allStagnant.stagnantEverywhere, true);
  assert.equal(allStagnant.coachTurnoverSeeds, 0);

  const oneWithTurnover = summarizeDuration(1000, [
    makeSample({ legacyCoachesHiredTotal: 3, activeLegacyCoaches: 3 }),
    makeSample({ legacyCoachesHiredTotal: 5, activeLegacyCoaches: 3 }), // 5 hired, only 3 active now => real turnover happened
  ]);
  assert.equal(oneWithTurnover.stagnantEverywhere, false);
  assert.equal(oneWithTurnover.coachTurnoverSeeds, 1);
});

test('summarizeDuration flags a style whose averaged winrate falls outside the sanity band, and only that style', () => {
  const summary = summarizeDuration(1000, [
    makeSample({ styleWinRates: { Boxe: 0.5, Lutte: 0.9, Freestyle: 0.5 } }),
    makeSample({ styleWinRates: { Boxe: 0.52, Lutte: 0.85, Freestyle: 0.48 } }),
  ]);

  assert.deepEqual(summary.stylesOutOfBand, ['Lutte']);
  assert.ok(summary.styleWinRateAverages.Lutte > STYLE_WINRATE_SANITY_BAND.MAX);
  assert.ok(summary.styleWinRateAverages.Boxe >= STYLE_WINRATE_SANITY_BAND.MIN && summary.styleWinRateAverages.Boxe <= STYLE_WINRATE_SANITY_BAND.MAX);
});

test('computeCrossDurationInflationRatio compares the shortest and longest durations\' late-game treasury', () => {
  const summaries = [
    summarizeDuration(100, [makeSample({ financialDrift: { lateGameAvgMoney: 1_000_000 } })]),
    summarizeDuration(500, [makeSample({ financialDrift: { lateGameAvgMoney: 4_000_000 } })]),
    summarizeDuration(1000, [makeSample({ financialDrift: { lateGameAvgMoney: 8_000_000 } })]),
  ];

  assert.equal(computeCrossDurationInflationRatio(summaries), 8);
});

test('computeCrossDurationInflationRatio returns null with fewer than 2 durations carrying late-game data', () => {
  const summaries = [summarizeDuration(100, [makeSample({ financialDrift: { lateGameAvgMoney: 1_000_000 } })])];
  assert.equal(computeCrossDurationInflationRatio(summaries), null);
});

test('a stable economy (late-game treasury flat across durations) reads well under the inflation threshold', () => {
  const summaries = [
    summarizeDuration(100, [makeSample({ financialDrift: { lateGameAvgMoney: 500_000 } })]),
    summarizeDuration(1000, [makeSample({ financialDrift: { lateGameAvgMoney: 550_000 } })]),
  ];
  const ratio = computeCrossDurationInflationRatio(summaries);
  assert.ok(ratio < FINANCIAL_INFLATION_RATIO_MAX);
});

test('LEGENDARY_FIGHTER_RATE_BAND matches BALANCE.LEGACY_ENGINE\'s own spirit (a 3%-6% band)', () => {
  assert.equal(LEGENDARY_FIGHTER_RATE_BAND.MIN, 0.03);
  assert.equal(LEGENDARY_FIGHTER_RATE_BAND.MAX, 0.06);
});
