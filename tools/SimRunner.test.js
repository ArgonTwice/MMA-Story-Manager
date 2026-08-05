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
  ]) {
    assert.ok(report.includes(heading), `report should include a "${heading}" section`);
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

test('runSimulation rejects an invalid seasons argument instead of silently misbehaving', () => {
  assert.throws(() => runSimulation({ seasons: 0 }), TypeError);
  assert.throws(() => runSimulation({ seasons: -5 }), TypeError);
  assert.throws(() => runSimulation({ rosterSize: 0 }), TypeError);
});
