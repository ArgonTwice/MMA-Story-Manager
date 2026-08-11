/**
 * tools/BalanceBenchmark.js
 * ---------------------------------------------------------------------------
 * "Balance Benchmark" — a headless mathematical validator for the economy,
 * combat engine, and mercato, run across N independent, seeded careers
 * (default: 1000 careers x 520 weeks = 10 in-game years each) using the same
 * tools/SimRunner.js engine every other balance tool in this repo already
 * reuses (see that file's own header: real CombatEngine/ProgressionEngine/
 * EconomyEngine wiring, no fabricated shortcuts).
 *
 * Usage:
 *   node tools/BalanceBenchmark.js                     Default: 1000 careers x 520 weeks.
 *   npm run test:benchmark                              Same, via package.json.
 *   node tools/BalanceBenchmark.js --careers=100         Faster iteration.
 *   node tools/BalanceBenchmark.js --weeks=260           5-year careers instead of 10.
 *   node tools/BalanceBenchmark.js --no-adjust           Report only, never edit data/balance.js.
 *
 * METRICS (see buildReport()):
 *   ECONOMY — bankruptcy rate at year 2 and year 5 (any insolvent week
 *     within that horizon, same definition tools/BalanceSimulation.test.js
 *     already uses); pooled treasury percentiles (P10/P50/P90) at years
 *     1/3/5/10; millionaire rate at year 10.
 *   COMBAT — a winrate matrix bucketed by the Overall-rating gap between the
 *     two fighters (0-5, 6-10, 11-20, 21+): how often the higher-rated
 *     "favorite" wins, and the KO/TKO vs Submission vs Decision split, in
 *     each bucket (plus the global split across every fight).
 *   MERCATO — average Buyout-fee/annual-salary ratio (sampled from every
 *     fighter generated over every career, via engine/MercatoEngine.js's own
 *     computeBuyoutFee formula); the rate rival gyms poach a fighter off the
 *     player's own roster (engine/MercatoEngine.js#rollWeeklyPoaching, folded
 *     via SimRunner's processPoaching), per gym-year; the 3-year retention
 *     rate of "pepites" — see the KNOWN SIMPLIFICATIONS note below for what
 *     that means here.
 *
 * TARGET THRESHOLDS & AUTO-ADJUSTMENT:
 *   Two named thresholds are actively enforced — a gym economy where more
 *   than 35% of careers are millionaires by year 10 (BALANCE.ECONOMY
 *   .PASSIVE_INCOME is too generous), or a combat engine where the
 *   higher-rated fighter wins more than 92% of fights with a sub-20-point
 *   Overall gap (BALANCE.COMBAT.VARIANCE's upset envelope is too narrow).
 *   When --no-adjust is not passed and a threshold is breached, this script
 *   edits the relevant data/balance.js coefficients on disk itself (see
 *   applyPassiveIncomeNerf/applyCombatVarianceWiden), then re-runs the same
 *   benchmark in a fresh child process (so the edited file is re-imported
 *   cleanly) to verify the correction, and records BOTH passes in the
 *   report. This never loops more than once — a single corrective nudge per
 *   run, verified, not an unbounded auto-tuner.
 *
 * KNOWN SIMPLIFICATIONS (same spirit as tools/SimRunner.js's own header —
 * this measures the game as it actually behaves headlessly today, not an
 * idealized version of it):
 *   - "Ratio Rachat/Salaire" compares engine/MercatoEngine.js#computeBuyoutFee
 *     (a one-time lump sum) against a full YEAR of the fighter's weeklySalary
 *     (52 weeks) — a lump-sum-vs-weekly-wage ratio would be meaningless at
 *     face value, so this script's own deliberate choice is the annualized
 *     comparison, exactly like a real transfer fee is judged against a
 *     "cost of a season's wages" in practice.
 *   - "Taux de debauchage par les rivaux" only ever measures rivals poaching
 *     FROM the player (engine/MercatoEngine.js#rollWeeklyPoaching, the one
 *     mercato flow SimRunner's headless coach-AI already drives every week)
 *     — the player's own buyoutRivalFighter() is a manual UI action with no
 *     autonomous headless trigger, so it is not exercised or measured here.
 *   - "Pepites" (prospects) are operationalized as every roster-replacement
 *     fighter spawned mid-career (a retirement or poaching backfill) rather
 *     than the player's own engine/AcademyEngine.js Draft — that Draft is a
 *     discrete, once-a-year UI-driven pick with no autonomous headless
 *     trigger either (see V3.8's own fix: it now requires an explicit Hub
 *     click). Roster-replacement spawns are the closest existing headless
 *     analogue of "a new prospect entering the roster mid-career", and are
 *     tracked via SimRunner's new onFighterGenerated({isReplacement}) hook.
 * ---------------------------------------------------------------------------
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import BALANCE from '../data/balance.js';
import { runSimulation } from './SimRunner.js';
import { computeBuyoutFee } from '../engine/MercatoEngine.js';
import { FINISH_METHODS } from '../engine/CombatEngine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const BALANCE_FILE = path.join(REPO_ROOT, 'data', 'balance.js');
const REPORT_DIR = path.join(__dirname, 'reports');
const REPORT_FILE = path.join(REPORT_DIR, 'balance_report.json');

const WEEKS_PER_SEASON = BALANCE.CALENDAR.WEEKS_PER_SEASON;
const SEASONS_PER_YEAR = BALANCE.CALENDAR.SEASONS_PER_YEAR;
const WEEKS_PER_YEAR = WEEKS_PER_SEASON * SEASONS_PER_YEAR;
const DAYS_PER_YEAR = BALANCE.CALENDAR.DAYS_PER_WEEK * WEEKS_PER_YEAR;

const DEFAULTS = Object.freeze({
  careers: 1000,
  weeks: 520, // 10 in-game years (WEEKS_PER_YEAR=52).
  rosterSize: 8,
  seedOffset: 0,
});

const OVERALL_GAP_BRACKETS = Object.freeze([
  { id: '0-5', min: 0, max: 5 },
  { id: '6-10', min: 6, max: 10 },
  { id: '11-20', min: 11, max: 20 },
  { id: '21+', min: 21, max: Infinity },
]);
/** Brackets pooled for the "favori > 92% de winrate sur ecart <20" threshold — the 21+ bucket is deliberately excluded, per the user's own "<20" wording. */
const UNDER_20_BRACKET_IDS = Object.freeze(['0-5', '6-10', '11-20']);

const YEAR_CHECKPOINTS = Object.freeze([1, 3, 5, 10]);
const BANKRUPTCY_CHECKPOINT_YEARS = Object.freeze([2, 5]);
const PROSPECT_RETENTION_YEARS = 3;
const MILLIONAIRE_THRESHOLD = 1_000_000;

const TARGETS = Object.freeze({
  MAX_MILLIONAIRE_RATE_AT_Y10: 0.35,
  MAX_FAVORITE_WINRATE_UNDER_GAP_20: 0.92,
});

// ---- small utilities --------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (const raw of argv) {
    const match = /^--([a-zA-Z][a-zA-Z0-9-]*)(?:=(.*))?$/.exec(raw);
    if (!match) continue;
    const [, key, value] = match;
    args[key] = value === undefined ? true : value;
  }
  return args;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roundTo(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Nearest-rank percentile over an ALREADY-SORTED-ASCENDING array. p in [0,1]. */
function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return null;
  const idx = clamp(Math.ceil(p * sortedArr.length) - 1, 0, sortedArr.length - 1);
  return sortedArr[idx];
}

function classifyMethod(method) {
  if (method === FINISH_METHODS.KO || method === FINISH_METHODS.TKO) return 'KO';
  if (method === FINISH_METHODS.SUBMISSION) return 'SUBMISSION';
  if (
    method === FINISH_METHODS.UNANIMOUS_DECISION ||
    method === FINISH_METHODS.SPLIT_DECISION ||
    method === FINISH_METHODS.MAJORITY_DECISION
  ) {
    return 'DECISION';
  }
  return 'OTHER'; // DOCTOR_STOPPAGE, DRAW
}

/** getOverallRating() carries one decimal of precision — floored to a whole-point gap first so e.g. a 5.5 gap still lands in a bracket (0-5/6-10/11-20/21+ are meant as whole-Overall-point buckets, not fractional ones). */
function gapBracketFor(gap) {
  const wholeGap = Math.floor(gap);
  return OVERALL_GAP_BRACKETS.find((bracket) => wholeGap >= bracket.min && wholeGap <= bracket.max);
}

function emptyMethodCounts() {
  return { KO: 0, SUBMISSION: 0, DECISION: 0, OTHER: 0 };
}

function emptyGapBucket() {
  return { fights: 0, favoriteWins: 0, underdogWins: 0, draws: 0, methodCounts: emptyMethodCounts() };
}

/** Mirrors engine/DraftEngine.js's own signing-cost formula (see BALANCE.RECRUITMENT_MARKET) — same helper tools/BalanceSimulation.test.js already uses, applied here to every generated fighter (initial roster AND every replacement), not just the initial roster. */
function assignRealisticSalary(fighter) {
  const cfg = BALANCE.RECRUITMENT_MARKET;
  const rating = fighter.getOverallRating();
  const cost = Math.max(cfg.MIN_COST, Math.round(cfg.COST_BASE * cfg.COST_GROWTH_PER_RATING_POINT ** rating));
  fighter.weeklySalary = Math.round(cost * cfg.SALARY_RATIO_OF_COST);
}

// ---- one career -------------------------------------------------------------

/**
 * Runs one seeded career and reduces it to exactly the figures the
 * benchmark's final aggregation needs (never retains the full per-week
 * runSimulation() result — 1000 of those held at once would be wasteful).
 */
function runOneCareer(seed, { weeks, rosterSize }) {
  const seasons = Math.ceil(weeks / WEEKS_PER_SEASON);
  const threeYearDays = PROSPECT_RETENTION_YEARS * DAYS_PER_YEAR;

  const gapMatrix = {};
  for (const bracket of OVERALL_GAP_BRACKETS) gapMatrix[bracket.id] = emptyGapBucket();
  const methodCounts = emptyMethodCounts();
  let totalFights = 0;

  let buyoutRatioSum = 0;
  let buyoutRatioCount = 0;
  let poachingEvents = 0;

  const pendingProspects = []; // { fighterId, spawnDay }
  let prospectsEligible = 0;
  let prospectsRetained = 0;
  let lastPlayerState = null;
  let lastDay = 0;

  /** Resolves every pending prospect whose 3-in-game-year mark has arrived — folded into prospectsEligible/prospectsRetained, then dropped from the pending list either way (finalSweep also drops the ones that never reached 3 years, excluding them from the cohort). */
  function resolvePendingProspects(playerState, currentDay, { finalSweep = false } = {}) {
    for (let i = pendingProspects.length - 1; i >= 0; i -= 1) {
      const prospect = pendingProspects[i];
      const age = currentDay - prospect.spawnDay;
      if (age >= threeYearDays) {
        prospectsEligible += 1;
        if (playerState.getFighter(prospect.fighterId)) prospectsRetained += 1;
        pendingProspects.splice(i, 1);
      } else if (finalSweep) {
        pendingProspects.splice(i, 1);
      }
    }
  }

  const result = runSimulation({
    seasons,
    rosterSize,
    seed,
    afterRosterSpawned: (playerState) => {
      for (const fighter of playerState.roster) assignRealisticSalary(fighter);
    },
    onFighterGenerated: (fighter, { day, isReplacement }) => {
      if (!fighter.weeklySalary) assignRealisticSalary(fighter);
      const fee = computeBuyoutFee(fighter);
      const annualSalary = fighter.weeklySalary * WEEKS_PER_YEAR;
      if (annualSalary > 0) {
        buyoutRatioSum += fee / annualSalary;
        buyoutRatioCount += 1;
      }
      if (isReplacement) pendingProspects.push({ fighterId: fighter.identity.id, spawnDay: day });
    },
    onFightResolved: (fighterA, fighterB, matchResult) => {
      const ratingA = fighterA.getOverallRating();
      const ratingB = fighterB.getOverallRating();
      const gap = Math.abs(ratingA - ratingB);
      const method = classifyMethod(matchResult.method);

      totalFights += 1;
      methodCounts[method] += 1;

      const bucket = gapMatrix[gapBracketFor(gap).id];
      bucket.fights += 1;
      bucket.methodCounts[method] += 1;
      if (matchResult.winner === null) {
        bucket.draws += 1;
      } else {
        const favoriteKey = ratingA >= ratingB ? 'A' : 'B';
        if (matchResult.winner === favoriteKey) bucket.favoriteWins += 1;
        else bucket.underdogWins += 1;
      }
    },
    onWeekComplete: ({ day, playerState, poachingReport }) => {
      poachingEvents += poachingReport.length;
      resolvePendingProspects(playerState, day);
      lastPlayerState = playerState;
      lastDay = day;
    },
  });

  if (lastPlayerState) resolvePendingProspects(lastPlayerState, lastDay, { finalSweep: true });

  const moneyByYear = {};
  for (const year of YEAR_CHECKPOINTS) {
    const weekIndex = clamp(year * WEEKS_PER_YEAR, 1, result.weeklyMetrics.length) - 1;
    moneyByYear[year] = result.weeklyMetrics[weekIndex]?.money ?? null;
  }

  const bankruptAtYear = {};
  for (const year of BANKRUPTCY_CHECKPOINT_YEARS) {
    const seasonCount = year * SEASONS_PER_YEAR;
    bankruptAtYear[year] = result.seasonalMetrics
      .slice(0, seasonCount)
      .some((season) => season.insolvencyWeeks > 0);
  }

  const finalMoney = result.weeklyMetrics[result.weeklyMetrics.length - 1]?.money ?? null;

  return {
    seed,
    moneyByYear,
    bankruptAtYear,
    finalMoney,
    gapMatrix,
    methodCounts,
    totalFights,
    buyoutRatioSum,
    buyoutRatioCount,
    poachingEvents,
    gymYears: result.economy.weeksSimulated / WEEKS_PER_YEAR,
    prospectsEligible,
    prospectsRetained,
  };
}

// ---- aggregation across every career -----------------------------------------

function winRateOf(bucket) {
  const total = bucket.favoriteWins + bucket.underdogWins + bucket.draws;
  return total > 0 ? bucket.favoriteWins / total : null;
}

function methodShareOf(counts) {
  const total = counts.KO + counts.SUBMISSION + counts.DECISION + counts.OTHER;
  if (total === 0) return { KO: null, SUBMISSION: null, DECISION: null, OTHER: null };
  return {
    KO: counts.KO / total,
    SUBMISSION: counts.SUBMISSION / total,
    DECISION: counts.DECISION / total,
    OTHER: counts.OTHER / total,
  };
}

function buildReport(careerResults, config) {
  const moneyByYearArrays = {};
  for (const year of YEAR_CHECKPOINTS) moneyByYearArrays[year] = [];

  let bankruptcyCounts = {};
  for (const year of BANKRUPTCY_CHECKPOINT_YEARS) bankruptcyCounts[year] = 0;
  let millionairesAtYear10 = 0;

  const gapAgg = {};
  for (const bracket of OVERALL_GAP_BRACKETS) gapAgg[bracket.id] = emptyGapBucket();
  const methodAgg = emptyMethodCounts();
  let totalFights = 0;

  let buyoutRatioSum = 0;
  let buyoutRatioCount = 0;
  let poachingEventsTotal = 0;
  let gymYearsTotal = 0;
  let prospectsEligibleTotal = 0;
  let prospectsRetainedTotal = 0;

  for (const career of careerResults) {
    for (const year of YEAR_CHECKPOINTS) {
      if (career.moneyByYear[year] !== null) moneyByYearArrays[year].push(career.moneyByYear[year]);
    }
    for (const year of BANKRUPTCY_CHECKPOINT_YEARS) {
      if (career.bankruptAtYear[year]) bankruptcyCounts[year] += 1;
    }
    if (career.finalMoney !== null && career.finalMoney >= MILLIONAIRE_THRESHOLD) millionairesAtYear10 += 1;

    for (const bracket of OVERALL_GAP_BRACKETS) {
      const src = career.gapMatrix[bracket.id];
      const dst = gapAgg[bracket.id];
      dst.fights += src.fights;
      dst.favoriteWins += src.favoriteWins;
      dst.underdogWins += src.underdogWins;
      dst.draws += src.draws;
      for (const key of Object.keys(methodAgg)) dst.methodCounts[key] += src.methodCounts[key];
    }
    for (const key of Object.keys(methodAgg)) methodAgg[key] += career.methodCounts[key];
    totalFights += career.totalFights;

    buyoutRatioSum += career.buyoutRatioSum;
    buyoutRatioCount += career.buyoutRatioCount;
    poachingEventsTotal += career.poachingEvents;
    gymYearsTotal += career.gymYears;
    prospectsEligibleTotal += career.prospectsEligible;
    prospectsRetainedTotal += career.prospectsRetained;
  }

  const careerCount = careerResults.length;
  const cashPercentiles = {};
  for (const year of YEAR_CHECKPOINTS) {
    const sorted = [...moneyByYearArrays[year]].sort((a, b) => a - b);
    cashPercentiles[year] = { p10: percentile(sorted, 0.1), p50: percentile(sorted, 0.5), p90: percentile(sorted, 0.9) };
  }

  const overallGapMatrix = {};
  for (const bracket of OVERALL_GAP_BRACKETS) {
    const bucket = gapAgg[bracket.id];
    overallGapMatrix[bracket.id] = {
      fights: bucket.fights,
      favoriteWinRate: winRateOf(bucket),
      underdogWinRate: bucket.fights > 0 ? bucket.underdogWins / bucket.fights : null,
      drawRate: bucket.fights > 0 ? bucket.draws / bucket.fights : null,
      methodShare: methodShareOf(bucket.methodCounts),
    };
  }

  const under20Bucket = emptyGapBucket();
  for (const id of UNDER_20_BRACKET_IDS) {
    under20Bucket.fights += gapAgg[id].fights;
    under20Bucket.favoriteWins += gapAgg[id].favoriteWins;
    under20Bucket.underdogWins += gapAgg[id].underdogWins;
    under20Bucket.draws += gapAgg[id].draws;
  }
  const favoriteWinRateUnderGap20 = winRateOf(under20Bucket);

  const millionaireRateAtYear10 = careerCount > 0 ? millionairesAtYear10 / careerCount : null;

  return {
    meta: {
      careers: careerCount,
      weeksPerCareer: config.weeks,
      rosterSize: config.rosterSize,
      seedRange: [config.seedOffset, config.seedOffset + careerCount - 1],
    },
    economy: {
      bankruptcyRate: Object.fromEntries(
        BANKRUPTCY_CHECKPOINT_YEARS.map((year) => [`year${year}`, careerCount > 0 ? bankruptcyCounts[year] / careerCount : null])
      ),
      cashPercentiles: Object.fromEntries(YEAR_CHECKPOINTS.map((year) => [`year${year}`, cashPercentiles[year]])),
      millionaireRateAtYear10,
    },
    combat: {
      overallGapMatrix,
      overallMethodShare: methodShareOf(methodAgg),
      totalFights,
      favoriteWinRateUnderGap20,
    },
    mercato: {
      avgBuyoutToSalaryRatio: buyoutRatioCount > 0 ? buyoutRatioSum / buyoutRatioCount : null,
      buyoutSampleSize: buyoutRatioCount,
      poachingRatePerGymYear: gymYearsTotal > 0 ? poachingEventsTotal / gymYearsTotal : null,
      prospectRetentionAt3Years: prospectsEligibleTotal > 0 ? prospectsRetainedTotal / prospectsEligibleTotal : null,
      prospectsEligibleTotal,
    },
    targets: {
      maxMillionaireRateAtYear10: {
        limit: TARGETS.MAX_MILLIONAIRE_RATE_AT_Y10,
        observed: millionaireRateAtYear10,
        pass: millionaireRateAtYear10 === null ? null : millionaireRateAtYear10 <= TARGETS.MAX_MILLIONAIRE_RATE_AT_Y10,
      },
      maxFavoriteWinrateUnderGap20: {
        limit: TARGETS.MAX_FAVORITE_WINRATE_UNDER_GAP_20,
        observed: favoriteWinRateUnderGap20,
        pass:
          favoriteWinRateUnderGap20 === null ? null : favoriteWinRateUnderGap20 <= TARGETS.MAX_FAVORITE_WINRATE_UNDER_GAP_20,
      },
    },
  };
}

function runBenchmark(config) {
  const careerResults = [];
  const startedAt = Date.now();
  for (let i = 0; i < config.careers; i += 1) {
    careerResults.push(runOneCareer(config.seedOffset + i, config));
    if ((i + 1) % 100 === 0 || i + 1 === config.careers) {
      const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.error(`[BalanceBenchmark] ${i + 1}/${config.careers} careers simulated (${elapsedS}s elapsed)`);
    }
  }
  const report = buildReport(careerResults, config);
  report.meta.durationMs = Date.now() - startedAt;
  return report;
}

// ---- auto-adjustment ----------------------------------------------------------

/** Widens the "underdog upset" envelope so the favorite's dominance at low Overall gaps eases off — see BALANCE.COMBAT.VARIANCE's own doc comment ("randomness envelope applied to every roll"). */
function applyCombatVarianceWiden(observedRate) {
  const raw = fs.readFileSync(BALANCE_FILE, 'utf8');
  const match = raw.match(/^(\s*)UPSET_EVENT_CHANCE:\s*([\d.]+),/m);
  if (!match) throw new Error('BalanceBenchmark: could not locate BALANCE.COMBAT.VARIANCE.UPSET_EVENT_CHANCE to adjust.');

  const before = Number(match[2]);
  const after = roundTo(Math.min(0.25, before + 0.03), 3);
  const updated = raw.replace(/^(\s*)UPSET_EVENT_CHANCE:\s*[\d.]+,/m, `$1UPSET_EVENT_CHANCE: ${after},`);
  fs.writeFileSync(BALANCE_FILE, updated);

  return {
    reason: `favorite winrate on gap <20 (${(observedRate * 100).toFixed(1)}%) exceeded the ${(TARGETS.MAX_FAVORITE_WINRATE_UNDER_GAP_20 * 100).toFixed(0)}% target`,
    path: 'BALANCE.COMBAT.VARIANCE',
    changes: [{ field: 'UPSET_EVENT_CHANCE', before, after }],
  };
}

/** Scales down passive-income growth so treasuries stop snowballing into millionaire territory by year 10 — see BALANCE.ECONOMY.PASSIVE_INCOME's own doc comment. */
function applyPassiveIncomeNerf(observedRate) {
  const raw = fs.readFileSync(BALANCE_FILE, 'utf8');
  const repMatch = raw.match(/^(\s*)PER_REPUTATION_POINT:\s*([\d.]+),/m);
  const hypeMatch = raw.match(/^(\s*)PER_HYPE_POINT:\s*([\d.]+),/m);
  if (!repMatch || !hypeMatch) {
    throw new Error('BalanceBenchmark: could not locate BALANCE.ECONOMY.PASSIVE_INCOME fields to adjust.');
  }

  const scale = clamp(TARGETS.MAX_MILLIONAIRE_RATE_AT_Y10 / observedRate, 0.5, 0.95);
  const repBefore = Number(repMatch[2]);
  const hypeBefore = Number(hypeMatch[2]);
  const repAfter = roundTo(repBefore * scale, 3);
  const hypeAfter = roundTo(hypeBefore * scale, 3);

  let updated = raw.replace(/^(\s*)PER_REPUTATION_POINT:\s*[\d.]+,/m, `$1PER_REPUTATION_POINT: ${repAfter},`);
  updated = updated.replace(/^(\s*)PER_HYPE_POINT:\s*[\d.]+,/m, `$1PER_HYPE_POINT: ${hypeAfter},`);
  fs.writeFileSync(BALANCE_FILE, updated);

  return {
    reason: `millionaire rate at year 10 (${(observedRate * 100).toFixed(1)}%) exceeded the ${(TARGETS.MAX_MILLIONAIRE_RATE_AT_Y10 * 100).toFixed(0)}% target`,
    path: 'BALANCE.ECONOMY.PASSIVE_INCOME',
    changes: [
      { field: 'PER_REPUTATION_POINT', before: repBefore, after: repAfter },
      { field: 'PER_HYPE_POINT', before: hypeBefore, after: hypeAfter },
    ],
  };
}

/** Detects breaches against the two named target thresholds and applies (at most one) corrective edit per breached target — never a loop, a single verified nudge. */
function evaluateAndApplyAdjustments(report) {
  const adjustments = [];
  if (report.targets.maxMillionaireRateAtYear10.pass === false) {
    adjustments.push(applyPassiveIncomeNerf(report.targets.maxMillionaireRateAtYear10.observed));
  }
  if (report.targets.maxFavoriteWinrateUnderGap20.pass === false) {
    adjustments.push(applyCombatVarianceWiden(report.targets.maxFavoriteWinrateUnderGap20.observed));
  }
  return adjustments;
}

// ---- console summary -----------------------------------------------------------

function formatPct(value) {
  return value === null || value === undefined ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function formatMoney(value) {
  return value === null || value === undefined ? 'n/a' : `$${Math.round(value).toLocaleString('en-US')}`;
}

function printSummary(label, report) {
  console.error(`\n=== ${label} (${report.meta.careers} careers x ${report.meta.weeksPerCareer} weeks) ===`);
  console.error(
    `Bankruptcy rate: year2=${formatPct(report.economy.bankruptcyRate.year2)} year5=${formatPct(report.economy.bankruptcyRate.year5)}`
  );
  console.error(`Millionaire rate @ year10: ${formatPct(report.economy.millionaireRateAtYear10)} (target <= ${formatPct(TARGETS.MAX_MILLIONAIRE_RATE_AT_Y10)})`);
  for (const year of YEAR_CHECKPOINTS) {
    const p = report.economy.cashPercentiles[`year${year}`];
    console.error(`  cash @ year${year}: P10=${formatMoney(p.p10)} P50=${formatMoney(p.p50)} P90=${formatMoney(p.p90)}`);
  }
  console.error(
    `Favorite winrate (gap <20): ${formatPct(report.combat.favoriteWinRateUnderGap20)} (target <= ${formatPct(TARGETS.MAX_FAVORITE_WINRATE_UNDER_GAP_20)}) over ${report.combat.totalFights} fights`
  );
  for (const bracket of OVERALL_GAP_BRACKETS) {
    const cell = report.combat.overallGapMatrix[bracket.id];
    console.error(
      `  gap ${bracket.id}: n=${cell.fights} favoriteWin=${formatPct(cell.favoriteWinRate)} KO=${formatPct(cell.methodShare.KO)} Sub=${formatPct(cell.methodShare.SUBMISSION)} Dec=${formatPct(cell.methodShare.DECISION)}`
    );
  }
  console.error(
    `Mercato: buyout/salary=${report.mercato.avgBuyoutToSalaryRatio?.toFixed(2) ?? 'n/a'}x  poaching=${report.mercato.poachingRatePerGymYear?.toFixed(2) ?? 'n/a'}/gym-year  prospect retention@3y=${formatPct(report.mercato.prospectRetentionAt3Years)} (n=${report.mercato.prospectsEligibleTotal})`
  );
}

// ---- entrypoint -----------------------------------------------------------------

function isMainModule() {
  return path.resolve(process.argv[1] ?? '') === __filename;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = {
    careers: args.careers ? parseInt(args.careers, 10) : DEFAULTS.careers,
    weeks: args.weeks ? parseInt(args.weeks, 10) : DEFAULTS.weeks,
    rosterSize: args.rosterSize ? parseInt(args.rosterSize, 10) : DEFAULTS.rosterSize,
    seedOffset: args.seedOffset ? parseInt(args.seedOffset, 10) : DEFAULTS.seedOffset,
  };

  if (args['adjusted-pass']) {
    // Child-process verification pass: run once, write straight to --out, no adjustment logic (avoids recursive re-exec).
    const report = runBenchmark(config);
    printSummary('Verification pass (post-adjustment)', report);
    fs.writeFileSync(args.out, JSON.stringify(report, null, 2));
    return;
  }

  console.error(`[BalanceBenchmark] Running ${config.careers} careers x ${config.weeks} weeks...`);
  const pass1 = runBenchmark(config);
  printSummary('Pass 1', pass1);

  const finalReport = { pass1, adjustments: [], pass2: null };
  const noAdjust = Boolean(args['no-adjust']);

  if (!noAdjust) {
    const adjustments = evaluateAndApplyAdjustments(pass1);
    if (adjustments.length > 0) {
      finalReport.adjustments = adjustments;
      for (const adjustment of adjustments) {
        console.error(`[BalanceBenchmark] Adjustment applied — ${adjustment.path}: ${adjustment.reason}`);
        for (const change of adjustment.changes) {
          console.error(`  ${change.field}: ${change.before} -> ${change.after}`);
        }
      }

      const outPath = path.join(REPORT_DIR, '.verification_pass.json');
      fs.mkdirSync(REPORT_DIR, { recursive: true });
      console.error('[BalanceBenchmark] Re-running in a fresh process to verify against the edited data/balance.js...');
      execFileSync(
        process.execPath,
        [
          __filename,
          `--careers=${config.careers}`,
          `--weeks=${config.weeks}`,
          `--rosterSize=${config.rosterSize}`,
          `--seedOffset=${config.seedOffset}`,
          '--adjusted-pass',
          `--out=${outPath}`,
        ],
        { stdio: 'inherit' }
      );
      finalReport.pass2 = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      fs.rmSync(outPath, { force: true });
    }
  }

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(REPORT_FILE, JSON.stringify(finalReport, null, 2));
  console.error(`[BalanceBenchmark] Report written to ${path.relative(REPO_ROOT, REPORT_FILE)}`);
}

if (isMainModule()) {
  main();
}

export { runBenchmark, buildReport, runOneCareer, TARGETS };
