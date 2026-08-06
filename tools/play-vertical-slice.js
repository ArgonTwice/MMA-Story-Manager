/**
 * tools/play-vertical-slice.js
 * ---------------------------------------------------------------------------
 * Phase 4.3 ("Player Experience & Vertical Slice") interactive CLI playtest:
 * plays one in-world year (52 weeks) step by step through the exact same
 * ui/ controllers a future real UI would use — GymHub, WeeklyFlowController,
 * FightNightView, WorldFeed, SeasonSummary — over a real GameState with
 * every reactive engine attached (the full Pyramide Emergente +
 * HistoryEngine), exactly like App.js wires a real browser session.
 *
 * Usage:
 *   node tools/play-vertical-slice.js                 Interactive (prompts on stdin).
 *   node tools/play-vertical-slice.js --auto           Non-interactive: auto-fills every
 *                                                       weekly plan, picks the first Drama
 *                                                       Engine choice offered, and simulates
 *                                                       every fight instantly. Runs unattended,
 *                                                       for validation/CI.
 *   node tools/play-vertical-slice.js --weeks=13       Shorter run (defaults to 52 = 1 year).
 *   node tools/play-vertical-slice.js --seed=42         Reproducible RNG. Omit for Math.random.
 *
 * Deliberate scope simplification, documented rather than hidden: there is
 * no opponent-gym/matchmaking system yet (see tools/SimRunner.js's own
 * documented limitation), so every demo fight is booked BETWEEN two of the
 * player's own roster fighters — CombatEngine#_isPlayerFighter credits both
 * corners with real reputation/hype/purse consequences either way, so every
 * mechanic is genuinely exercised, just without an external-opponent roster
 * to draw from.
 * ---------------------------------------------------------------------------
 */

import readline from 'node:readline/promises';

import BALANCE from '../data/balance.js';
import Fighter from '../models/Fighter.js';
import { GameState } from '../state/GameState.js';
import { CombatEngine, createSeededRng } from '../engine/CombatEngine.js';
import { PersonalityEngine } from '../engine/PersonalityEngine.js';
import { generatePersonality } from '../engine/FighterGenerator.js';
import { RelationshipEngine } from '../engine/RelationshipEngine.js';
import { StoryEngine } from '../engine/StoryEngine.js';
import { NarrativeEngine } from '../engine/NarrativeEngine.js';
import { WorldMemory } from '../engine/WorldMemory.js';
import { HistoryEngine } from '../engine/HistoryEngine.js';
import { SocialEngine } from '../engine/SocialEngine.js';

import { GymHub } from '../ui/GymHub.js';
import { WeeklyFlowController, WEEKLY_FLOW_PHASES } from '../ui/WeeklyFlowController.js';
import { FightNightView } from '../ui/FightNightView.js';
import { WorldFeed } from '../ui/WorldFeed.js';
import { SeasonSummary } from '../ui/SeasonSummary.js';
import { SessionTelemetry } from './SessionTelemetry.js';

const WEEKS_PER_YEAR = BALANCE.CALENDAR.WEEKS_PER_SEASON * BALANCE.CALENDAR.SEASONS_PER_YEAR;
const STARTING_ROSTER_STYLES = Object.freeze(['Boxe', 'Muay Thai', 'Lutte', 'Jiu-Jitsu Bresilien', 'Freestyle', 'Kickboxing']);

// ---- CLI argument parsing (same convention as tools/run-simulation.js) ------

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
      'Usage: node tools/play-vertical-slice.js [--weeks=52] [--seed=42] [--auto] [--telemetry]',
      '',
      '  --weeks       Nombre de semaines a jouer (defaut : 52, une annee complete).',
      '  --seed        Graine RNG pour un playtest reproductible (defaut : Math.random).',
      '  --auto        Mode non-interactif : plan hebdo auto-rempli, premier choix Drama Engine',
      '                toujours retenu, combats simules instantanement. Pour la validation/CI.',
      '  --telemetry   Persiste le resume de cette session dans tools/.telemetry/sessions.json',
      '                (gitignore) et affiche le taux de completion agrege sur toutes les',
      '                sessions deja enregistrees. Sans ce flag, la telemetrie de CETTE session',
      "                est quand meme calculee/affichee, juste pas ecrite sur disque.",
      '  --telemetry-file=chemin  Fichier de log alternatif pour --telemetry.',
    ].join('\n')
  );
}

// ---- roster bootstrap (a minimal, self-contained "new gym" — no onboarding UI exists yet) --

function bootstrapRoster(playerState, rng) {
  const skillDefault = BALANCE.PROGRESSION.DEFAULT_STARTING_SKILL_VALUE;
  for (const style of STARTING_ROSTER_STYLES) {
    const spread = 15;
    const skills = Object.fromEntries(
      ['boxe', 'jambes', 'sol', 'soumission', 'cardio', 'intelligence'].map((key) => [
        key,
        Math.round(skillDefault + (rng() * 2 - 1) * spread),
      ])
    );
    const fighter = new Fighter({
      identity: {
        name: `${style} Prospect`,
        age: BALANCE.AGE.DEBUT_MIN_AGE + Math.floor(rng() * 8),
        style,
        weightClass: 'Poids Welter',
      },
      attributes: { skills },
      psychology: { personality: generatePersonality(rng) },
    });
    playerState.addFighter(fighter);
  }
}

// ---- reactive engine lifecycle (mirrors App.js's _attachReactiveEngines) ----

function createReactiveEngines() {
  return {
    personalityEngine: new PersonalityEngine(),
    relationshipEngine: new RelationshipEngine(),
    storyEngine: new StoryEngine(),
    narrativeEngine: new NarrativeEngine(),
    worldMemory: new WorldMemory(),
    historyEngine: new HistoryEngine(),
    socialEngine: new SocialEngine(),
  };
}

function attachReactiveEngines(engines, playerState, worldState) {
  engines.personalityEngine.attach(playerState);
  engines.relationshipEngine.attach(worldState);
  engines.storyEngine.attach(playerState, worldState);
  engines.narrativeEngine.attach(playerState, worldState);
  engines.worldMemory.attach(worldState);
  engines.historyEngine.attach(worldState);
  engines.socialEngine.attach(playerState);
}

function detachReactiveEngines(engines) {
  Object.values(engines).forEach((engine) => engine.detach());
}

// ---- interactive prompting (no-ops in --auto mode) --------------------------

function makePrompter(auto, rl) {
  return async function prompt(question, choices) {
    if (auto || !rl) return choices[0];
    console.log(`${question} [${choices.join(' / ')}]`);
    const answer = (await rl.question('> ')).trim();
    return choices.includes(answer) ? answer : choices[0];
  };
}

// ---- one week ----------------------------------------------------------------

async function playOneWeek({ weekIndex, gameState, rng, auto, prompt, gymHub, telemetry }) {
  telemetry.startWeek();
  console.log('\n' + gymHub.toText());

  const flow = new WeeklyFlowController({ gameState, rng });

  if (auto) {
    flow.autoFillPlan();
  } else {
    console.log(`\n--- Semaine ${weekIndex}: planning (3 creneaux/combattant) ---`);
    for (const option of flow.getPlanningOptions()) {
      if (option.injured) continue;
      for (let slot = 0; slot < BALANCE.WEEKLY_PLANNING.SLOTS_PER_WEEK; slot += 1) {
        const activity = await prompt(`  ${option.name} — creneau ${slot + 1}`, option.activityKeys);
        flow.setSlot(option.fighterId, slot, activity);
      }
    }
  }

  let stepResult = flow.resolveWeek();

  if (stepResult.phase === WEEKLY_FLOW_PHASES.DRAMA_CHOICE) {
    const dramaPrompt = stepResult.dramaPrompt;
    gymHub.setPendingDramaChoice({ event: { id: dramaPrompt.eventId, category: dramaPrompt.category, choices: dramaPrompt.choices }, fighter: { identity: { id: dramaPrompt.fighterId, name: dramaPrompt.fighterName } } });
    console.log(`\nEVENEMENT (${dramaPrompt.fighterName}) : ${dramaPrompt.eventId}`);
    const choiceId = await prompt(
      '  Choix',
      dramaPrompt.choices.map((c) => c.id)
    );
    stepResult = flow.resolveDramaChoice(choiceId);
    gymHub.clearPendingDramaChoice();
    telemetry.recordDramaChoice(dramaPrompt.eventId, choiceId);
  }

  const summary = stepResult.weekSummary;
  if (summary.retirements.length > 0) {
    for (const retirement of summary.retirements) {
      const hofTag = retirement.reconversion.isHallOfFamer ? ' [HALL OF FAME]' : '';
      console.log(`\nRETRAITE : ${retirement.name} (${retirement.age} ans)${hofTag} -> ${retirement.reconversion.outcome}`);
    }
  }

  return stepResult;
}

// ---- one demo fight (intra-roster — see this file's header) -----------------

async function playOneFight({ gameState, combatEngine, rng, auto, prompt, telemetry }) {
  const available = gameState.playerState.roster.filter((f) => !f.isInjured(gameState.worldState.currentDay));
  if (available.length < 2) return null;

  const fighterA = available[Math.floor(rng() * available.length)];
  let fighterB = available[Math.floor(rng() * available.length)];
  if (fighterB.identity.id === fighterA.identity.id) {
    fighterB = available.find((f) => f.identity.id !== fighterA.identity.id);
  }
  if (!fighterB) return null;

  const view = new FightNightView({ combatEngine });
  view.presentMatchup(fighterA, fighterB, 'WFC', false);
  view.setGameplans();
  console.log('\n' + view.toCardText());

  if (auto) {
    view.simulateToCompletion();
  } else {
    let step;
    do {
      step = view.advanceOneRound();
      if (!step.finished) {
        console.log(`  Round ${step.round.round} — degats A ${step.round.damageDealt.A} / B ${step.round.damageDealt.B}`);
        console.log(`    Vie     A ${step.round.healthBar.A}   B ${step.round.healthBar.B}`);
        console.log(`    Stamina A ${step.round.staminaBar.A}   B ${step.round.staminaBar.B}`);
        await prompt('  Round suivant', ['ok']);
      }
    } while (!step.finished);
  }

  console.log(view.toResultText());
  const result = combatEngine.getSnapshot().result;
  telemetry.recordFightResult(result);
  return result;
}

// ---- main ---------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    printUsage();
    return;
  }

  const weeks = args.weeks !== undefined ? Number(args.weeks) : WEEKS_PER_YEAR;
  if (!Number.isInteger(weeks) || weeks <= 0) {
    throw new TypeError(`--weeks must be a positive integer, got "${args.weeks}".`);
  }
  const auto = Boolean(args.auto);
  const rng = args.seed !== undefined ? createSeededRng(Number(args.seed)) : Math.random;

  const gameState = new GameState();
  gameState.newGame({ gymName: 'Vertical Slice Gym', country: 'FR' });
  bootstrapRoster(gameState.playerState, rng);
  gameState.worldState.addRivalGym({ name: 'Iron Fist Academy', reputation: 55 });
  gameState.worldState.addRivalGym({ name: 'Apex MMA', reputation: 45 });

  const engines = createReactiveEngines();
  attachReactiveEngines(engines, gameState.playerState, gameState.worldState);

  const combatEngine = new CombatEngine({ playerState: gameState.playerState, worldState: gameState.worldState, rng });
  const gymHub = new GymHub({ playerState: gameState.playerState, worldState: gameState.worldState });
  const worldFeed = new WorldFeed({ playerState: gameState.playerState, worldState: gameState.worldState }).attach();

  const rl = auto ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
  const prompt = makePrompter(auto, rl);

  const telemetry = new SessionTelemetry(args['telemetry-file'] ? { filePath: String(args['telemetry-file']) } : {});
  const persistTelemetry = Boolean(args.telemetry || args['telemetry-file']);

  const startMoney = gameState.playerState.money;
  const startDay = gameState.worldState.currentDay;
  const weeklyResults = [];
  const fightResults = [];
  let weeksCompleted = 0;

  console.log(`\n### PHASE 4.3 — VERTICAL SLICE (${weeks} semaine(s), mode ${auto ? 'AUTO' : 'INTERACTIF'}) ###`);

  try {
    for (let week = 1; week <= weeks; week += 1) {
      const stepResult = await playOneWeek({ weekIndex: week, gameState, rng, auto, prompt, gymHub, telemetry });
      weeklyResults.push(stepResult);

      if (week % 4 === 0) {
        const fightResult = await playOneFight({ gameState, combatEngine, rng, auto, prompt, telemetry });
        if (fightResult) fightResults.push(fightResult);
      }

      const feedText = worldFeed.toText(3);
      if (feedText) {
        console.log('\nFIL DU MONDE (recent) :');
        console.log(feedText);
      }

      weeksCompleted = week;
    }

    const seasonSummary = new SeasonSummary({ playerState: gameState.playerState, worldState: gameState.worldState });
    const summary = seasonSummary.build({ weeklyResults, fightResults, startMoney, startDay });
    console.log('\n' + seasonSummary.toText(summary));
  } finally {
    telemetry.finalize(weeks, weeksCompleted);
    console.log('\n' + telemetry.toText());
    if (persistTelemetry) {
      const aggregate = telemetry.persist();
      console.log(
        `Taux de completion agrege (toutes sessions --telemetry) : ${aggregate.completedSessions} / ${aggregate.totalSessions}` +
          ` (${aggregate.completionRate === null ? 'N/A' : `${(aggregate.completionRate * 100).toFixed(1)}%`})`
      );
    }

    rl?.close();
    worldFeed.detach();
    detachReactiveEngines(engines);
  }
}

main().catch((error) => {
  console.error('Le playtest a echoue :', error.message);
  console.error(error.stack);
  process.exitCode = 1;
});
