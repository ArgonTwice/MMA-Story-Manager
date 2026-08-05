/**
 * tools/run-simulation.js
 * ---------------------------------------------------------------------------
 * CLI entry point for the Phase 3.0 headless balance simulator.
 *
 * Usage:
 *   node tools/run-simulation.js --seasons=1000
 *   node tools/run-simulation.js --seasons=10000 --rosterSize=10 --seed=42
 *
 * Flags (all optional):
 *   --seasons=N          Number of BALANCE.CALENDAR seasons to simulate (default 1000).
 *   --rosterSize=N        Roster size the sim maintains throughout the run (default 8).
 *   --fightChance=0.18    Chance, per shuffled roster pair per week, of a booked fight.
 *   --seed=N              Seeds a reproducible RNG. Omit for Math.random.
 * ---------------------------------------------------------------------------
 */

import { runSimulation } from './SimRunner.js';
import { printReport } from './BalanceReporter.js';

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

function parsePositiveNumber(raw, flagName) {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`--${flagName} must be a positive number, got "${raw}".`);
  }
  return value;
}

function printUsage() {
  console.log(
    [
      'Usage: node tools/run-simulation.js [--seasons=1000] [--rosterSize=8] [--fightChance=0.18] [--seed=42]',
      '',
      '  --seasons     Nombre de saisons BALANCE.CALENDAR a simuler (defaut: 1000, recommande: 1000 a 10000).',
      '  --rosterSize  Taille de roster maintenue tout au long du run (defaut: 8).',
      '  --fightChance Chance, par paire de combattants disponibles et par semaine, qu\'un combat soit programme (defaut: 0.18).',
      '  --seed        Graine RNG pour un run reproductible (par defaut: Math.random, non reproductible).',
    ].join('\n')
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || args.h) {
    printUsage();
    return;
  }

  const seasons = parsePositiveNumber(args.seasons, 'seasons') ?? 1000;
  const rosterSize = parsePositiveNumber(args.rosterSize, 'rosterSize') ?? 8;
  const fightChancePerPair = parsePositiveNumber(args.fightChance, 'fightChance');
  const seed = args.seed !== undefined ? Number(args.seed) : undefined;

  if (!Number.isInteger(seasons)) throw new TypeError(`--seasons must be an integer, got "${args.seasons}".`);
  if (!Number.isInteger(rosterSize)) throw new TypeError(`--rosterSize must be an integer, got "${args.rosterSize}".`);

  console.log(`Lancement de la simulation headless : ${seasons} saison(s), roster de ${rosterSize}...`);

  const progressEvery = Math.max(1, Math.round(seasons / 20));
  const result = runSimulation({
    seasons,
    rosterSize,
    fightChancePerPair,
    seed,
    onSeasonComplete: (seasonIndex, totalSeasons) => {
      if (seasonIndex % progressEvery === 0 || seasonIndex === totalSeasons) {
        console.log(`  ... saison ${seasonIndex} / ${totalSeasons}`);
      }
    },
  });

  printReport(result);
}

try {
  main();
} catch (error) {
  console.error('La simulation a echoue :', error.message);
  console.error(error.stack);
  process.exitCode = 1;
}
