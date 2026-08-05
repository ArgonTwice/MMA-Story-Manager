/**
 * tools/SimRunner.test.js
 * Run with: node --test tools/SimRunner.test.js
 *
 * Fast smoke coverage for the headless balance simulator: a handful of
 * seasons is enough to exercise every code path (fights, training,
 * injuries, retirements/replacements, narrative beats, EventBus cleanup)
 * without slowing down the suite, while the CLI itself is what actually
 * gets run at 1000-10000 seasons for real balance analysis.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import EventBus from '../core/EventBus.js';
import { runSimulation } from './SimRunner.js';
import { formatReport } from './BalanceReporter.js';

test('runSimulation completes a small multi-season run without throwing and returns a well-shaped report', () => {
  const result = runSimulation({ seasons: 8, rosterSize: 6, seed: 1234 });

  assert.equal(result.config.seasons, 8);
  assert.equal(result.config.totalWeeks, 8 * result.config.weeksPerSeason);
  assert.equal(result.economy.weeksSimulated, result.config.totalWeeks);
  assert.equal(result.weeklyMetrics.length, result.config.totalWeeks);
  assert.ok(result.seasonalMetrics.length === 8);
  assert.ok(result.fighters.totalGenerated >= 6);
  assert.ok(result.fun.totalWeeks === result.config.totalWeeks);
  assert.ok(result.fun.dullWeekRate === null || (result.fun.dullWeekRate >= 0 && result.fun.dullWeekRate <= 1));

  for (const bucket of Object.values(result.archetypes)) {
    assert.ok(bucket.wins >= 0 && bucket.losses >= 0 && bucket.draws >= 0);
  }
  for (const bucket of Object.values(result.styles)) {
    assert.ok(bucket.wins >= 0 && bucket.losses >= 0 && bucket.draws >= 0);
  }
});

test('runSimulation with a fixed seed is reproducible in its fight/economy totals', () => {
  const a = runSimulation({ seasons: 5, rosterSize: 6, seed: 42 });
  const b = runSimulation({ seasons: 5, rosterSize: 6, seed: 42 });

  assert.equal(a.fights.total, b.fights.total);
  assert.deepEqual(a.fights.byMethod, b.fights.byMethod);
  assert.equal(a.economy.avgBalance, b.economy.avgBalance);
});

test('runSimulation never leaks its EventBus subscriptions past the run', () => {
  const before = EventBus.listenerCount('narrative:published');
  runSimulation({ seasons: 4, rosterSize: 6, seed: 5 });
  const after = EventBus.listenerCount('narrative:published');

  assert.equal(after, before, 'no narrative:published subscription should survive runSimulation()');
});

test('a long run (roughly a career-length span) eventually observes at least one forced retirement', () => {
  const result = runSimulation({ seasons: 60, rosterSize: 6, seed: 77 });

  assert.ok(result.fighters.totalRetired > 0, 'expected at least one forced retirement over ~60 seasons');
  const withRetirements = Object.values(result.archetypes).find((a) => a.retirementCount > 0);
  assert.ok(withRetirements, 'expected at least one archetype bucket to have recorded a retirement');
  assert.equal(withRetirements.avgRetirementAge, 45, 'only forced retirement exists today, so age is always FORCED_RETIREMENT_AGE');
});

test('formatReport renders every required section as plain text without throwing', () => {
  const result = runSimulation({ seasons: 6, rosterSize: 6, seed: 3 });
  const report = formatReport(result);

  for (const heading of [
    'ECONOMIE',
    'ROSTER & ARCHETYPES',
    'DOMINANCE DES STYLES',
    'METRIQUES DE SANTE',
    'FUN DETECTOR',
    'COMBAT METRICS (TELEMETRY)',
    'TAKEDOWNS & CONTROLE',
    'REPARTITION DU TEMPS DE COMBAT',
    'SOUMISSIONS & CONTRES',
    "BIAIS D'EVALUATION DES JUGES",
    'MATRICE DE MATCHUP PAR STYLE',
    'META HEALTH DASHBOARD',
    'VERSION HISTORY TRACKER',
  ]) {
    assert.ok(report.includes(heading), `report should include a "${heading}" section`);
  }
});

test('Version History Tracker: the current run\'s row reflects live results, and deltas vs the recorded v0.30/v0.31 entries are internally consistent', () => {
  const result = runSimulation({ seasons: 60, rosterSize: 8, seed: 99 });
  const report = formatReport(result);

  assert.ok(report.includes('v0.30'));
  assert.ok(report.includes('v0.31'));
  assert.ok(report.includes('v0.32'));
  assert.ok(report.includes('Baseline'));
  assert.ok(report.includes('Test A1'));
  assert.ok(report.includes('Test A2'));
  assert.ok(report.includes('TEST A2 — CONDITIONS DE VALIDATION'));

  // Fun Detector's delta is reported against the immediately preceding
  // entry (v0.31, funScore=69); Meta Health Index's delta is reported
  // against the fixed baseline (v0.30, metaHealthIndex=86) — see
  // renderVersionHistorySection.
  const funDelta = result.metaHealth.funScore - 69;
  const metaDelta = result.metaHealth.overallIndex - 86;
  const formatSigned = (n) => (n > 0 ? `+${n}` : `${n}`);
  assert.ok(report.includes(`${formatSigned(funDelta)} vs v0.31`));
  assert.ok(report.includes(`${formatSigned(metaDelta)} vs baseline v0.30`));
});

test('Test A2 validation checklist reports exactly 4 conditions, each with a PASS or FAIL verdict and a "Bilan : n / 4" summary', () => {
  const result = runSimulation({ seasons: 60, rosterSize: 8, seed: 99 });
  const report = formatReport(result);

  for (const label of [
    '1. Winrate Grappling',
    '2. Meta Health Index',
    '3. Winrate min par style',
    '4. Victoires Grappling par soumission',
  ]) {
    assert.ok(report.includes(label), `expected the validation checklist to include "${label}"`);
  }

  const verdictCount = (report.match(/\bPASS\b/g) ?? []).length + (report.match(/\bFAIL\b/g) ?? []).length;
  assert.equal(verdictCount, 4, 'expected exactly 4 PASS/FAIL verdicts (one per condition)');

  assert.ok(!report.includes('NaN'), 'the validation checklist should never render NaN (regression: worst-style reduce had a mismatched accumulator shape)');
  const worstStyleLine = report.split('\n').find((line) => line.includes('Winrate min par style'));
  const actualWorst = Object.entries(result.styles).reduce(
    (min, [style, s]) => (s.winRate !== null && s.winRate < min[1] ? [style, s.winRate] : min),
    [null, Infinity]
  );
  assert.ok(worstStyleLine.includes(actualWorst[0]), `expected the worst-style line to name ${actualWorst[0]}, got: ${worstStyleLine}`);

  const bilanMatch = report.match(/Bilan : (\d) \/ 4 conditions validees\./);
  assert.ok(bilanMatch, 'expected a "Bilan : n / 4 conditions validees." summary line');
  const passCount = (report.match(/\bPASS\b/g) ?? []).length;
  assert.equal(Number(bilanMatch[1]), passCount);
});

test('Average Round EV Ratio is reported and, when both EVs are known, the printed ratio matches EV Sol / EV Debout', () => {
  const result = runSimulation({ seasons: 60, rosterSize: 8, seed: 99 });
  const report = formatReport(result);

  assert.ok(report.includes('Average Round EV Ratio'));
  assert.ok(report.includes('EV Debout'));
  assert.ok(report.includes('EV Sol'));

  const a = result.combat.actionMetrics;
  const standingBuckets = [a.HEAD_STRIKE, a.BODY_STRIKE, a.LEG_STRIKE];
  const standingAttempts = standingBuckets.reduce((sum, b) => sum + b.attempts, 0);
  if (standingAttempts > 0 && a.TAKEDOWN.avgScorePoints !== null) {
    const evStanding = standingBuckets.reduce((sum, b) => sum + b.attempts * (b.avgScorePoints ?? 0), 0) / standingAttempts;
    const expectedRatio = a.TAKEDOWN.avgScorePoints / evStanding;
    assert.ok(report.includes(`x${expectedRatio.toFixed(2)}`), `expected the report to include the computed ratio x${expectedRatio.toFixed(2)}`);
  }
});

test('combat telemetry is faithfully aggregated from every fight\'s CombatEngine result', () => {
  const result = runSimulation({ seasons: 60, rosterSize: 8, seed: 99 });
  const c = result.combat;

  assert.ok(result.fights.total > 0, 'sanity: this run should have produced fights to aggregate');
  assert.equal(c.fightsWithMetrics, result.fights.total, 'one combatMetrics fold per simulated fight');

  // In the current CombatEngine, choosing GROUND distance always attempts
  // (and, since there's no contest, always "succeeds" at) exactly one
  // takedown and one submission per round — see CombatEngine's
  // _recordFighterCombatMetrics and this run's own methodology notes.
  assert.equal(c.takedownAttempts, c.groundRounds);
  assert.equal(c.takedownSuccess, c.takedownAttempts);
  assert.equal(c.takedownDefended, 0, 'no takedown-defense mechanic exists yet');
  assert.equal(c.submissionAttempts, c.groundRounds);
  assert.ok(c.submissionSuccess <= c.submissionAttempts);
  assert.equal(
    c.countersTriggered,
    c.submissionAttempts - c.submissionSuccess,
    'every failed submission attempt is exactly one counted counter opportunity for the opponent'
  );
  assert.ok(c.standingRounds + c.clinchRounds + c.groundRounds === c.totalRounds);
  assert.ok(c.decisionFights <= result.fights.total);
  assert.ok(c.groundDominantDecisionFights <= c.decisionFights);

  for (const rate of [
    c.takedownSuccessRate,
    c.takedownDefenseRate,
    c.submissionSuccessRate,
    c.counterOpportunityRate,
    c.standingTimeShare,
    c.clinchTimeShare,
    c.groundTimeShare,
    c.groundDominantWinRate,
  ]) {
    assert.ok(rate === null || (rate >= 0 && rate <= 1), `rate ${rate} should be null or within [0, 1]`);
  }
});

test('the style matchup matrix mirrors correctly (row-vs-col wins equal col-vs-row losses) and totals match the fight count', () => {
  const result = runSimulation({ seasons: 60, rosterSize: 8, seed: 99 });
  const matrix = result.styleMatchups;
  const styleKeys = Object.keys(matrix);

  let totalRecordedOutcomes = 0;
  for (const rowStyle of styleKeys) {
    for (const colStyle of styleKeys) {
      const cell = matrix[rowStyle][colStyle];
      const mirror = matrix[colStyle][rowStyle];
      assert.equal(cell.wins, mirror.losses, `${rowStyle} wins vs ${colStyle} should equal ${colStyle} losses vs ${rowStyle}`);
      assert.equal(cell.draws, mirror.draws, `${rowStyle} draws vs ${colStyle} should equal ${colStyle} draws vs ${rowStyle}`);
      totalRecordedOutcomes += cell.wins + cell.losses + cell.draws;
    }
  }

  // Every fight contributes exactly two mirrored cell updates (one per corner's style).
  assert.equal(totalRecordedOutcomes, result.fights.total * 2);
});

test('Win Condition Report: each style\'s win-method breakdown sums back to that style\'s own win count', () => {
  const result = runSimulation({ seasons: 60, rosterSize: 8, seed: 99 });

  for (const [style, entry] of Object.entries(result.styleWinMethods)) {
    assert.equal(entry.totalWins, result.styles[style].wins);
    const summedFromMethods = Object.values(entry.byMethod).reduce((sum, m) => sum + m.count, 0);
    assert.equal(summedFromMethods, entry.totalWins);
    for (const { count, share } of Object.values(entry.byMethod)) {
      assert.ok(share === null || (share >= 0 && share <= 1));
      if (entry.totalWins > 0) assert.ok(Math.abs(share - count / entry.totalWins) < 1e-9);
    }
  }
});

test('actionMetrics/tempoMetrics rates stay within valid bounds, and tempo rounds sum to the same total as distance rounds', () => {
  const result = runSimulation({ seasons: 60, rosterSize: 8, seed: 99 });
  const c = result.combat;

  for (const bucket of Object.values(c.actionMetrics)) {
    for (const rate of [bucket.successRate, bucket.controlRate]) {
      assert.ok(rate === null || (rate >= 0 && rate <= 1));
    }
    assert.ok(bucket.avgDamage === null || bucket.avgDamage >= 0);
  }

  const tempoRoundsTotal = Object.values(c.tempoMetrics).reduce((sum, t) => sum + t.rounds, 0);
  assert.equal(tempoRoundsTotal, c.totalRounds, 'every round has exactly one tempo, same as it has exactly one distance');
});

test('styleIdentity scores stay within [0, 100], and diversity shares sum to 1 across all generated fighters', () => {
  const result = runSimulation({ seasons: 60, rosterSize: 8, seed: 99 });

  for (const score of Object.values(result.styleIdentity)) {
    assert.ok(score === null || (score >= 0 && score <= 100));
  }

  const shareSum = Object.values(result.diversity.byStyle).reduce((sum, s) => sum + (s.share ?? 0), 0);
  assert.ok(Math.abs(shareSum - 1) < 1e-9);
  const countSum = Object.values(result.diversity.byStyle).reduce((sum, s) => sum + s.count, 0);
  assert.equal(countSum, result.fighters.totalGenerated);
});

test('Meta Health Index is the rounded average of its four component scores, all within [0, 100]', () => {
  const result = runSimulation({ seasons: 60, rosterSize: 8, seed: 99 });
  const m = result.metaHealth;

  for (const score of [m.diversityScore, m.balanceScore, m.financialHealthScore, m.funScore, m.overallIndex]) {
    assert.ok(score === null || (score >= 0 && score <= 100));
  }

  const components = [m.diversityScore, m.balanceScore, m.financialHealthScore, m.funScore].filter((v) => v !== null);
  const expected = components.length > 0 ? Math.round(components.reduce((a, b) => a + b, 0) / components.length) : null;
  assert.equal(m.overallIndex, expected);
});

test('grappling aggregate combines exactly the GROUND-affinity styles and matches their combined per-style totals', () => {
  const result = runSimulation({ seasons: 60, rosterSize: 8, seed: 99 });
  const g = result.grappling;

  assert.deepEqual(new Set(g.styles), new Set(['Lutte', 'Jiu-Jitsu Bresilien']));
  const expectedWins = g.styles.reduce((sum, style) => sum + result.styles[style].wins, 0);
  const expectedLosses = g.styles.reduce((sum, style) => sum + result.styles[style].losses, 0);
  const expectedDraws = g.styles.reduce((sum, style) => sum + result.styles[style].draws, 0);
  assert.equal(g.wins, expectedWins);
  assert.equal(g.losses, expectedLosses);
  assert.equal(g.draws, expectedDraws);
  assert.ok(g.winRate === null || (g.winRate >= 0 && g.winRate <= 1));
});

test('runSimulation rejects an invalid seasons argument instead of silently misbehaving', () => {
  assert.throws(() => runSimulation({ seasons: 0 }), TypeError);
  assert.throws(() => runSimulation({ seasons: -5 }), TypeError);
  assert.throws(() => runSimulation({ rosterSize: 0 }), TypeError);
});
