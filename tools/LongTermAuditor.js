/**
 * tools/LongTermAuditor.js — Phase 4.4 ("Playtests, Polish, Long-Term
 * Economics & Release Candidate")
 * ---------------------------------------------------------------------------
 * Every prior phase validated the game at a single duration (usually 1000
 * seasons). This audit instead runs 100, 500, AND 1000 seasons — each
 * length across several independent seeds — and compares them against each
 * other, to catch drift that only shows up as a TREND across durations, not
 * as a bad number at any one of them individually:
 *
 *   - Financial inflation: does average gym treasury keep climbing without
 *     bound as the run gets longer, rather than settling into a stable band?
 *     (compares late-game treasury — each duration's own last 10% of
 *     seasons — ACROSS durations; see computeFinancialDrift's own doc
 *     comment for why a single run's early/late ratio alone can't
 *     distinguish a healthy early ramp from genuine runaway growth).
 *   - Hall of Fame saturation/drought: does Legendary Fighter Rate (target
 *     3-6%, see BALANCE.LEGACY_ENGINE) hold steady across durations, or
 *     drift as more of the world's history accumulates?
 *   - Legacy coach stagnation: engine/LegacyEngine.js caps active coaches
 *     at BALANCE.LEGACY_ENGINE.MAX_LEGACY_COACHES — this checks whether
 *     legacyCoachesHiredTotal (cumulative hires) ever grows past that cap
 *     (real turnover) or freezes there forever once first reached (the
 *     first 3 coaches hired become permanently un-replaceable, silently
 *     locking out every later Hall-of-Famer who would have chosen
 *     COACH_IN_GYM — a real, honestly-reportable finding if it happens,
 *     not assumed away).
 *   - Style winrate drift: do per-style winrates stay inside a broad
 *     "nothing collapsed or ran away with the metagame" band across
 *     durations (see tools/BalanceReporter.js's own STYLE_NEUTRALITY_MIN/MAX
 *     precedent, reused here verbatim rather than inventing a second band).
 *
 * Usage:
 *   node tools/LongTermAuditor.js                  Default: seeds 1-5 x {100, 500, 1000} seasons.
 *   node tools/LongTermAuditor.js --seeds=10        More seeds per duration (slower, steadier).
 *   node tools/LongTermAuditor.js --durations=100,1000
 * ---------------------------------------------------------------------------
 */

import { runSimulation } from './SimRunner.js';

const DEFAULT_DURATIONS = [100, 500, 1000];
const DEFAULT_SEED_COUNT = 5;

/** Same broad "did anything actually collapse" sanity band tools/BalanceReporter.js's Phase 4.1 style-neutrality check uses — see that file's own doc comment for why it's this wide rather than centered tightly on 50%. */
const STYLE_WINRATE_SANITY_BAND = Object.freeze({ MIN: 0.25, MAX: 0.7 });
/** BALANCE.LEGACY_ENGINE's own target, reused here rather than redefined. */
const LEGENDARY_FIGHTER_RATE_BAND = Object.freeze({ MIN: 0.03, MAX: 0.06 });
/** A treasury more than this multiple higher in a run's own last 10% of seasons than its own first 10% is flagged as runaway inflation — this audit's own reasonable threshold, not a BALANCE-owned constant. */
const FINANCIAL_INFLATION_RATIO_MAX = 5;

function parseArgs(argv) {
  const args = {};
  for (const raw of argv) {
    const match = /^--([a-zA-Z][a-zA-Z0-9_]*)(?:=(.*))?$/.exec(raw);
    if (!match) continue;
    const [, key, value] = match;
    args[key] = value === undefined ? true : value;
  }
  return args;
}

function printUsage() {
  console.log(
    [
      'Usage: node tools/LongTermAuditor.js [--seeds=5] [--durations=100,500,1000]',
      '',
      '  --seeds       Nombre de graines independantes par duree (defaut: 5).',
      '  --durations   Liste de durees (en saisons) a auditer, separees par des virgules (defaut: 100,500,1000).',
    ].join('\n')
  );
}

/**
 * Two distinct signals, deliberately not conflated:
 *   - withinRunRatio (last 10% of THIS run's own seasons vs its own first
 *     10%): mostly reflects the ordinary early-game ramp from a small
 *     starting treasury, not necessarily runaway drift — an early ramp-up
 *     naturally produces a big ratio at ANY duration, including a perfectly
 *     healthy one, so this alone cannot tell "starts poor, stabilizes" apart
 *     from "never stops growing." Kept only as a secondary diagnostic.
 *   - lateGameAvgMoney (average treasury over just the last 10% of THIS
 *     run's seasons): the number that actually answers "does the economy
 *     drift over LONGER horizons" — see summarizeDuration's
 *     crossDurationInflationRatio, which compares this figure ACROSS
 *     durations (100 vs 500 vs 1000 seasons). If the economy reaches a
 *     genuine steady state well before any of these durations end, this
 *     figure should land in a similar range regardless of duration; if it
 *     keeps climbing with duration, that IS runaway inflation, not an
 *     artifact of an early ramp.
 */
function computeFinancialDrift(seasonalMetrics) {
  if (seasonalMetrics.length < 10) return null;
  const sliceSize = Math.max(1, Math.floor(seasonalMetrics.length * 0.1));
  const early = seasonalMetrics.slice(0, sliceSize);
  const late = seasonalMetrics.slice(-sliceSize);
  const average = (entries) => entries.reduce((sum, e) => sum + e.avgMoney, 0) / entries.length;

  const earlyAvg = average(early);
  const lateAvg = average(late);
  return { earlyAvg, lateAvg, withinRunRatio: earlyAvg > 0 ? lateAvg / earlyAvg : null, lateGameAvgMoney: lateAvg };
}

/** Runs one (duration, seed) sample and extracts every metric this audit tracks. */
function auditOneRun(seasons, seed) {
  const result = runSimulation({ seasons, rosterSize: 8, seed });
  return {
    seasons,
    seed,
    metaHealth: result.metaHealth.overallIndex,
    deadWeekRate: result.fun.dullWeekRate,
    legendaryFighterRate: result.legacy.legendaryFighterRate,
    hallOfFameCount: result.hallOfFame.length,
    totalRetired: result.fighters.totalRetired,
    activeLegacyCoaches: result.activeLegacyCoaches,
    legacyCoachesHiredTotal: result.legacy.legacyCoachesHiredTotal,
    financialDrift: computeFinancialDrift(result.seasonalMetrics),
    styleWinRates: Object.fromEntries(Object.entries(result.styles).map(([style, bucket]) => [style, bucket.winRate])),
  };
}

function average(values) {
  const finite = values.filter((v) => v !== null && v !== undefined && Number.isFinite(v));
  return finite.length > 0 ? finite.reduce((sum, v) => sum + v, 0) / finite.length : null;
}

/** Aggregates every seed's sample for one duration into a single row, plus the raw per-seed samples for drill-down. */
function summarizeDuration(seasons, samples) {
  const metaHealthAvg = average(samples.map((s) => s.metaHealth));
  const deadWeekRateAvg = average(samples.map((s) => s.deadWeekRate));

  const totalHallOfFame = samples.reduce((sum, s) => sum + s.hallOfFameCount, 0);
  const totalRetired = samples.reduce((sum, s) => sum + s.totalRetired, 0);
  const pooledLegendaryRate = totalRetired > 0 ? totalHallOfFame / totalRetired : null;

  const withinRunRatios = samples.map((s) => s.financialDrift?.withinRunRatio).filter((v) => v !== null && v !== undefined);
  const worstWithinRunRatio = withinRunRatios.length > 0 ? Math.max(...withinRunRatios) : null;
  const lateGameAvgMoney = average(samples.map((s) => s.financialDrift?.lateGameAvgMoney));

  // Legacy coach stagnation: flagged only when EVERY sampled seed at this
  // duration froze at exactly its own active-coach cap with zero turnover
  // beyond the coaches that filled it — a single seed with real turnover
  // (hired > active) is enough evidence turnover CAN happen.
  const coachTurnoverSeeds = samples.filter((s) => s.legacyCoachesHiredTotal > s.activeLegacyCoaches).length;
  const stagnantEverywhere = samples.length > 0 && coachTurnoverSeeds === 0;

  const styleKeys = Object.keys(samples[0]?.styleWinRates ?? {});
  const styleWinRateAverages = Object.fromEntries(
    styleKeys.map((style) => [style, average(samples.map((s) => s.styleWinRates[style]))])
  );
  const stylesOutOfBand = styleKeys.filter((style) => {
    const rate = styleWinRateAverages[style];
    return rate !== null && (rate < STYLE_WINRATE_SANITY_BAND.MIN || rate > STYLE_WINRATE_SANITY_BAND.MAX);
  });

  return {
    seasons,
    samples,
    metaHealthAvg,
    deadWeekRateAvg,
    pooledLegendaryRate,
    totalHallOfFame,
    totalRetired,
    worstWithinRunRatio,
    lateGameAvgMoney,
    stagnantEverywhere,
    coachTurnoverSeeds,
    styleWinRateAverages,
    stylesOutOfBand,
  };
}

function formatPercent(value, digits = 1) {
  return value === null || value === undefined ? 'N/A' : `${(value * 100).toFixed(digits)}%`;
}

function renderDurationRow(summary) {
  const lines = [];
  lines.push(`\n--- ${summary.seasons} saisons (${summary.samples.length} graine(s)) ---`);
  lines.push(`Meta Health Index (moyenne)        : ${summary.metaHealthAvg === null ? 'N/A' : summary.metaHealthAvg.toFixed(1)}/100`);
  lines.push(`Dead Week Rate (moyenne)            : ${formatPercent(summary.deadWeekRateAvg)}`);
  lines.push(
    `Legendary Fighter Rate (poolee)     : ${formatPercent(summary.pooledLegendaryRate)} ` +
      `(${summary.totalHallOfFame} HOF / ${summary.totalRetired} retraites, cible ${formatPercent(LEGENDARY_FIGHTER_RATE_BAND.MIN, 0)}-${formatPercent(LEGENDARY_FIGHTER_RATE_BAND.MAX, 0)}) : ` +
      `${
        summary.pooledLegendaryRate !== null &&
        summary.pooledLegendaryRate >= LEGENDARY_FIGHTER_RATE_BAND.MIN &&
        summary.pooledLegendaryRate <= LEGENDARY_FIGHTER_RATE_BAND.MAX
          ? 'DANS LA CIBLE'
          : 'HORS CIBLE'
      }`
  );
  lines.push(
    `Tresorerie moyenne (derniers 10% du run) : ${summary.lateGameAvgMoney === null ? 'N/A' : `${Math.round(summary.lateGameAvgMoney).toLocaleString('fr-FR')}$`}` +
      ` (voir la section TENDANCES INTER-DUREES pour le vrai signal d'inflation — la comparaison inter-durees, pas ce chiffre seul)`
  );
  lines.push(
    `  Ratio de rampe interne au run (derniers 10% / premiers 10%) : ${summary.worstWithinRunRatio === null ? 'N/A' : `x${summary.worstWithinRunRatio.toFixed(2)}`}` +
      ` (diagnostic secondaire seulement — un ratio eleve ici reflete surtout la montee en puissance normale de debut de partie)`
  );
  lines.push(
    `Stagnation des coachs Legacy         : ${summary.stagnantEverywhere ? `OUI (0/${summary.samples.length} graines avec turnover)` : `NON (${summary.coachTurnoverSeeds}/${summary.samples.length} graines avec turnover)`}`
  );
  if (summary.stylesOutOfBand.length > 0) {
    lines.push(
      `Styles hors bande de neutralite [${formatPercent(STYLE_WINRATE_SANITY_BAND.MIN, 0)}, ${formatPercent(STYLE_WINRATE_SANITY_BAND.MAX, 0)}] : ` +
        summary.stylesOutOfBand.map((style) => `${style}=${formatPercent(summary.styleWinRateAverages[style])}`).join(', ')
    );
  } else {
    lines.push(`Styles hors bande de neutralite      : aucun`);
  }
  return lines.join('\n');
}

/**
 * The actual cross-duration inflation signal: compares lateGameAvgMoney
 * (average treasury over just each duration's OWN last 10% of seasons)
 * between the shortest and longest audited duration. If the economy
 * reaches a genuine steady state well before either ends, this should sit
 * near x1; if it keeps compounding with no ceiling, this ratio itself
 * grows with duration — which is exactly what distinguishes "healthy early
 * ramp that plateaus" from "runaway inflation with no late-game money sink."
 */
function computeCrossDurationInflationRatio(summaries) {
  const withLateGame = summaries.filter((s) => s.lateGameAvgMoney !== null && s.lateGameAvgMoney > 0);
  if (withLateGame.length < 2) return null;
  const shortest = withLateGame[0];
  const longest = withLateGame[withLateGame.length - 1];
  return longest.lateGameAvgMoney / shortest.lateGameAvgMoney;
}

function renderTrendSection(summaries) {
  const lines = ['\n=== TENDANCES INTER-DUREES (100 -> 500 -> 1000 saisons) ==='];
  const header = ['Duree', 'Meta Health', 'Dead Week', 'Legendary Rate', 'Tresorerie fin de run', 'Coachs stagnants'];
  lines.push(header.join('\t'));
  for (const summary of summaries) {
    lines.push(
      [
        `${summary.seasons}`,
        summary.metaHealthAvg === null ? 'N/A' : summary.metaHealthAvg.toFixed(1),
        formatPercent(summary.deadWeekRateAvg),
        formatPercent(summary.pooledLegendaryRate),
        summary.lateGameAvgMoney === null ? 'N/A' : `${Math.round(summary.lateGameAvgMoney).toLocaleString('fr-FR')}$`,
        summary.stagnantEverywhere ? 'OUI' : 'NON',
      ].join('\t')
    );
  }

  const crossDurationRatio = computeCrossDurationInflationRatio(summaries);
  lines.push('');
  lines.push(
    `Ratio de tresorerie fin-de-run (duree la plus longue / duree la plus courte) : ` +
      `${crossDurationRatio === null ? 'N/A' : `x${crossDurationRatio.toFixed(2)}`} ` +
      `(seuil x${FINANCIAL_INFLATION_RATIO_MAX}) : ${
        crossDurationRatio !== null && crossDurationRatio > FINANCIAL_INFLATION_RATIO_MAX ? 'INFLATION CONFIRMEE (pas de plateau)' : 'STABLE (plateau atteint)'
      }`
  );
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    printUsage();
    return;
  }

  const seedCount = args.seeds !== undefined ? Number(args.seeds) : DEFAULT_SEED_COUNT;
  if (!Number.isInteger(seedCount) || seedCount <= 0) {
    throw new TypeError(`--seeds must be a positive integer, got "${args.seeds}".`);
  }
  const durations = args.durations
    ? String(args.durations)
        .split(',')
        .map((v) => Number(v.trim()))
    : DEFAULT_DURATIONS;
  for (const seasons of durations) {
    if (!Number.isInteger(seasons) || seasons <= 0) {
      throw new TypeError(`--durations must be a comma-separated list of positive integers, got "${args.durations}".`);
    }
  }

  console.log(`Audit long terme : durees ${durations.join(', ')} saisons, ${seedCount} graine(s) chacune...`);

  const summaries = [];
  for (const seasons of durations) {
    const samples = [];
    for (let seed = 1; seed <= seedCount; seed += 1) {
      samples.push(auditOneRun(seasons, seed));
    }
    const summary = summarizeDuration(seasons, samples);
    summaries.push(summary);
    console.log(renderDurationRow(summary));
  }

  console.log(renderTrendSection(summaries));

  const crossDurationRatio = computeCrossDurationInflationRatio(summaries);
  const anyInflation = crossDurationRatio !== null && crossDurationRatio > FINANCIAL_INFLATION_RATIO_MAX;
  const anyStagnation = summaries.some((s) => s.stagnantEverywhere);
  const anyOffTargetLegendaryRate = summaries.some(
    (s) => s.pooledLegendaryRate !== null && (s.pooledLegendaryRate < LEGENDARY_FIGHTER_RATE_BAND.MIN || s.pooledLegendaryRate > LEGENDARY_FIGHTER_RATE_BAND.MAX)
  );
  const anyStyleDrift = summaries.some((s) => s.stylesOutOfBand.length > 0);

  console.log('\n=== BILAN RELEASE CANDIDATE ===');
  console.log(`Inflation financiere suspectee a une duree ou plus     : ${anyInflation ? 'OUI' : 'NON'}`);
  console.log(`Stagnation des coachs Legacy a une duree ou plus        : ${anyStagnation ? 'OUI' : 'NON'}`);
  console.log(`Legendary Fighter Rate hors cible a une duree ou plus   : ${anyOffTargetLegendaryRate ? 'OUI' : 'NON'}`);
  console.log(`Derive de winrate de style a une duree ou plus          : ${anyStyleDrift ? 'OUI' : 'NON'}`);
}

// Guarded so this file can be imported for its pure functions (see exports
// below) — e.g. by tools/LongTermAuditor.test.js — without triggering a
// full multi-duration simulation run as a side effect of import.
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error("L'audit long terme a echoue :", error.message);
    console.error(error.stack);
    process.exitCode = 1;
  }
}

export {
  parseArgs,
  computeFinancialDrift,
  summarizeDuration,
  computeCrossDurationInflationRatio,
  STYLE_WINRATE_SANITY_BAND,
  LEGENDARY_FIGHTER_RATE_BAND,
  FINANCIAL_INFLATION_RATIO_MAX,
};
