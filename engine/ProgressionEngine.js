/**
 * engine/ProgressionEngine.js
 * ---------------------------------------------------------------------------
 * The weekly "tick": advances the calendar, then drives every other weekly
 * business engine (Training, Economy, Narrative Events), ages fighters on
 * their in-world birthday, lets rival gyms drift and occasionally fight
 * each other headlessly, and announces the whole week's results in one
 * summary event.
 *
 * advanceWeek(gameState) is the single entry point a Render "Advance Week"
 * button (or an automated simulation loop) should call.
 * ---------------------------------------------------------------------------
 */

import EventBus from '../core/EventBus.js';
import BALANCE from '../data/balance.js';
import Fighter from '../models/Fighter.js';
import { CombatEngine } from './CombatEngine.js';
import { processWeeklyTraining } from './TrainingEngine.js';
import { processWeeklyExpenses } from './EconomyEngine.js';
import { evaluateWeeklyEvents } from './EventEngine.js';
import { generatePersonality } from './FighterGenerator.js';
import { processRetirement } from './LegacyEngine.js';

/** Event names published on EventBus by ProgressionEngine. Import instead of raw strings. */
export const PROGRESSION_EVENTS = Object.freeze({
  WEEK_ADVANCED: 'world:week_advanced',
  SEASON_ENDED: 'world:season_ended',
});

const WEEKS_PER_YEAR = BALANCE.CALENDAR.WEEKS_PER_SEASON * BALANCE.CALENDAR.SEASONS_PER_YEAR;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Deterministic FNV-1a style string hash, used only to spread each
 * fighter's birthday evenly across the in-world year from their (stable,
 * never-changing) id — avoids persisting a dedicated birth-date field on
 * the Fighter model for a mechanic this lightweight.
 * @param {string} value
 * @returns {number}
 */
function hashToUint32(value) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function getFighterBirthWeek(fighter) {
  return hashToUint32(fighter.identity.id) % WEEKS_PER_YEAR;
}

function getWeekOfYear(currentDay) {
  const weekIndex = Math.floor((currentDay - 1) / BALANCE.CALENDAR.DAYS_PER_WEEK);
  return weekIndex % WEEKS_PER_YEAR;
}

/**
 * Ages every roster fighter whose in-world birthday falls in the week that
 * was just entered. Skill decline itself is TrainingEngine's job (it reads
 * the fighter's current age every week) — this only bumps the age number.
 * Anyone who just hit forced retirement is fully resolved right here: a
 * FORCED_RETIREMENT global event, Phase 4.2's Legacy Engine (Hall of Fame
 * induction check + reconversion — see engine/LegacyEngine.js#processRetirement),
 * and removal from the roster. Prior to Phase 4.3 this only published the
 * event and left the fighter on the roster forever — a real gap, since it
 * meant retirement/Hall of Fame/reconversion only ever actually happened in
 * tools/SimRunner.js's own bespoke headless loop, never in a real game
 * session. tools/SimRunner.js now reads the `retirements` this returns
 * instead of independently detecting/reprocessing the same retirements
 * itself (see its own processRetirements, which only adds the headless-only
 * concern of spawning a replacement fighter).
 *
 * Replenishing the roster after a departure is deliberately NOT this
 * function's job — the real game has no scouting/recruitment system yet for
 * it to call, unlike tools/SimRunner.js's own headless-only coach-AI, which
 * spawns a synthetic replacement purely to keep its balance-testing roster
 * size constant across a run.
 *
 * @param {Object} playerState
 * @param {Object} worldState
 * @param {() => number} rng
 * @returns {{ birthdays: Object[], retirements: Object[] }}
 */
function processBirthdaysAndRetirements(playerState, worldState, rng) {
  const weekOfYear = getWeekOfYear(worldState.currentDay);
  const birthdays = [];
  const retirements = [];

  // Snapshot first: removeFighter (below) splices playerState.roster, which
  // would otherwise shift indices out from under a live for..of over it.
  const rosterSnapshot = [...playerState.roster];

  for (const fighter of rosterSnapshot) {
    if (getFighterBirthWeek(fighter) !== weekOfYear) continue;

    const newAge = fighter.incrementAge();
    birthdays.push({ fighterId: fighter.identity.id, newAge });

    if (!fighter.isForcedRetirement()) continue;

    const reconversion = processRetirement(fighter, { playerState, worldState, rng });
    worldState.addGlobalEvent({
      type: 'FORCED_RETIREMENT',
      fighterId: fighter.identity.id,
      name: fighter.identity.name,
      age: newAge,
      // Phase 4.3: carries the Legacy Engine outcome on the SAME global
      // event rather than publishing a second one — ui/WorldFeed.js (and
      // any other WORLD_EVENTS.GLOBAL_EVENT_ADDED listener) reads this
      // straight off the event, no separate retirements[] lookup needed.
      isHallOfFamer: reconversion.isHallOfFamer,
      nickname: reconversion.nickname,
      reconversionOutcome: reconversion.outcome,
    });
    retirements.push({
      fighterId: fighter.identity.id,
      name: fighter.identity.name,
      age: newAge,
      archetype: fighter.psychology.personality.archetype,
      wins: fighter.career.wins,
      losses: fighter.career.losses,
      draws: fighter.career.draws,
      titles: fighter.career.titles.length,
      reconversion,
    });
    playerState.removeFighter(fighter.identity.id);
  }

  return { birthdays, retirements };
}

function uniformSkills(value) {
  return { boxe: value, jambes: value, sol: value, soumission: value, cardio: value, intelligence: value };
}

/**
 * Lets every rival gym's reputation/activity drift a little this week, and
 * has a chance of booking (and headlessly resolving, via a fresh
 * CombatEngine + two synthetic Fighter instances proportioned to each
 * gym's current reputation) a bout between adjacent pairs of rival gyms.
 * Real rival-gym rosters/matchmaking are a future engine's job — this is a
 * deliberately lightweight "the world feels alive" simulation.
 *
 * @returns {Object[]} Global-event records for any rival fights resolved this week.
 */
function processRivalGyms(worldState, rng) {
  const w = BALANCE.WORLD;
  const gyms = worldState.rivalGyms;

  for (const gym of gyms) {
    const reputationDrift =
      w.RIVAL_GYM_REPUTATION_DRIFT.MIN + rng() * (w.RIVAL_GYM_REPUTATION_DRIFT.MAX - w.RIVAL_GYM_REPUTATION_DRIFT.MIN);
    const activityDrift =
      w.RIVAL_GYM_ACTIVITY.WEEKLY_DRIFT_MIN +
      rng() * (w.RIVAL_GYM_ACTIVITY.WEEKLY_DRIFT_MAX - w.RIVAL_GYM_ACTIVITY.WEEKLY_DRIFT_MIN);
    const currentReputation = gym.reputation ?? BALANCE.GYM.STARTING_REPUTATION;
    const currentActivity = gym.activity ?? w.RIVAL_GYM_ACTIVITY.STARTING_VALUE;

    worldState.updateRivalGym(gym.id, {
      reputation: clamp(currentReputation + reputationDrift, 0, BALANCE.GYM.MAX_REPUTATION),
      activity: clamp(currentActivity + activityDrift, w.RIVAL_GYM_ACTIVITY.MIN, w.RIVAL_GYM_ACTIVITY.MAX),
    });
  }

  const fightResults = [];
  for (let i = 0; i + 1 < gyms.length; i += 2) {
    if (rng() >= w.RIVAL_GYM_FIGHT_CHANCE_PER_WEEK) continue;

    const gymA = gyms[i];
    const gymB = gyms[i + 1];
    const skillA = clamp(
      gymA.reputation ?? BALANCE.GYM.STARTING_REPUTATION,
      BALANCE.PROGRESSION.SKILL_MIN,
      BALANCE.PROGRESSION.SKILL_MAX
    );
    const skillB = clamp(
      gymB.reputation ?? BALANCE.GYM.STARTING_REPUTATION,
      BALANCE.PROGRESSION.SKILL_MIN,
      BALANCE.PROGRESSION.SKILL_MAX
    );

    const fighterA = new Fighter({
      identity: { name: `${gymA.name ?? gymA.id} Prospect` },
      attributes: { skills: uniformSkills(skillA) },
      psychology: { personality: generatePersonality(rng) },
    });
    const fighterB = new Fighter({
      identity: { name: `${gymB.name ?? gymB.id} Prospect` },
      attributes: { skills: uniformSkills(skillB) },
      psychology: { personality: generatePersonality(rng) },
    });

    const headlessEngine = new CombatEngine({ rng });
    headlessEngine.setupMatch(fighterA, fighterB, 'WORLD_SIM', false);
    const result = headlessEngine.simulateFullMatch();

    const winnerGym = result.winner === 'A' ? gymA : result.winner === 'B' ? gymB : null;
    const loserGym = result.winner === 'A' ? gymB : result.winner === 'B' ? gymA : null;

    if (winnerGym) {
      worldState.updateRivalGym(winnerGym.id, {
        reputation: clamp(
          (winnerGym.reputation ?? BALANCE.GYM.STARTING_REPUTATION) + w.RIVAL_GYM_FIGHT_REPUTATION_DELTA.WIN,
          0,
          BALANCE.GYM.MAX_REPUTATION
        ),
      });
    }
    if (loserGym) {
      worldState.updateRivalGym(loserGym.id, {
        reputation: clamp(
          (loserGym.reputation ?? BALANCE.GYM.STARTING_REPUTATION) + w.RIVAL_GYM_FIGHT_REPUTATION_DELTA.LOSS,
          0,
          BALANCE.GYM.MAX_REPUTATION
        ),
      });
    }

    fightResults.push(
      worldState.addGlobalEvent({
        type: 'RIVAL_FIGHT_RESULT',
        gymAId: gymA.id,
        gymBId: gymB.id,
        winnerGymId: winnerGym?.id ?? null,
        method: result.method,
      })
    );
  }

  return fightResults;
}

/**
 * Advances the game world by one week: calendar, training, economy,
 * birthdays, and rival-gym activity — then publishes a single summary
 * event (plus a season-boundary event when applicable).
 *
 * @param {Object} gameState - A GameState instance (uses .worldState and .playerState).
 * @param {Object} [options]
 * @param {() => number} [options.rng] - Random source in [0, 1). Defaults to Math.random.
 * @returns {Object} The weekly summary (also published as PROGRESSION_EVENTS.WEEK_ADVANCED).
 */
export function advanceWeek(gameState, options = {}) {
  const rng = options.rng ?? Math.random;
  const { worldState, playerState } = gameState;

  const seasonBefore = worldState.season;
  worldState.advanceDay(BALANCE.CALENDAR.DAYS_PER_WEEK);

  const trainingReport = processWeeklyTraining(playerState, worldState, { rng });
  const economyReport = processWeeklyExpenses(playerState);
  const narrativeReport = evaluateWeeklyEvents(gameState, { rng });
  const { birthdays, retirements } = processBirthdaysAndRetirements(playerState, worldState, rng);
  const rivalGymReport = processRivalGyms(worldState, rng);

  const summary = {
    day: worldState.currentDay,
    season: worldState.season,
    year: worldState.year,
    trainingReport,
    economyReport,
    narrativeReport,
    birthdays,
    retirements,
    rivalGymReport,
  };

  EventBus.publish(PROGRESSION_EVENTS.WEEK_ADVANCED, summary);

  if (worldState.season !== seasonBefore) {
    EventBus.publish(PROGRESSION_EVENTS.SEASON_ENDED, {
      endedSeason: seasonBefore,
      newSeason: worldState.season,
      year: worldState.year,
    });
  }

  return summary;
}
