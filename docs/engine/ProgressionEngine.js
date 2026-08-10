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
import { processTransferMarket } from './TransferMarket.js';
import { isProspectWaveDue, generateProspectWave } from './ProspectGenerator.js';
import { applyWeeklyStaffEffects, rollStaffConflict } from './StaffEngine.js';
import { degradeEquipmentWeekly } from './GymInfrastructure.js';
import { advanceWeeksAtGym } from './ScoutingEngine.js';
import { processWeeklyCommunityManagement } from './SocialFeedEngine.js';
import { rollWeeklyPoaching } from './MercatoEngine.js';
import { applyWeeklyCampOrientation } from './FightWeekEngine.js';

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
/**
 * Fisher-Yates shuffle over a COPY of `list` — never mutates the original
 * array/order (worldState.rivalGyms' own ordering is untouched; this is
 * purely a per-week matchmaking draw).
 */
function shuffledCopy(list, rng) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

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

  // Phase V2.7 ("Le Monde Vivant"): pairings are re-drawn every week rather
  // than fixed by roster order — with a FIXED pairing, the same two gyms
  // would fight each other exclusively for the entire simulation, and
  // RIVAL_GYM_FIGHT_REPUTATION_DELTA's asymmetric WIN/LOSS swing (a
  // pre-existing mechanic, not introduced here) turns that into an
  // unbounded "rich get richer" snowball within an isolated pair (see
  // tools/BalanceReporter.js's Gym Dominance Index, which measures exactly
  // this). Shuffling lets every gym eventually face every other gym,
  // spreading competition across the whole roster instead of a few sealed-
  // off rivalries.
  const shuffledGyms = shuffledCopy(gyms, rng);

  const fightResults = [];
  for (let i = 0; i + 1 < shuffledGyms.length; i += 2) {
    if (rng() >= w.RIVAL_GYM_FIGHT_CHANCE_PER_WEEK) continue;

    const gymA = shuffledGyms[i];
    const gymB = shuffledGyms[i + 1];
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
  const yearBefore = worldState.year;
  worldState.advanceDay(BALANCE.CALENDAR.DAYS_PER_WEEK);

  const trainingReport = processWeeklyTraining(playerState, worldState, { rng });
  const economyReport = processWeeklyExpenses(playerState);

  // V3.6 "Fight Week": while a Combat-tab fight is booked and it isn't
  // fight week yet, the booked fighter's chosen Training Camp orientation
  // applies instead of (on top of) their normal weekly training gains.
  const fightWeekReport = applyWeeklyCampOrientation(playerState, worldState);

  // Phase F ("Staff Engine, Fog of War, League Pyramid, Infrastructure"):
  // Head Coach's weekly morale bump, staff ego/relationship conflicts,
  // equipment wear, and the Fog of War's per-fighter weeksAtGym counter all
  // advance once per week, alongside the pre-existing training/economy
  // resolution above.
  const staffMoraleBonus = applyWeeklyStaffEffects(playerState);
  const staffConflicts = rollStaffConflict(playerState, rng);
  degradeEquipmentWeekly(playerState);
  advanceWeeksAtGym(playerState);
  const staffReport = { moraleBonus: staffMoraleBonus, conflicts: staffConflicts };

  // V3.5 "Community Manager": gym-wide subscriber growth, merchandising
  // income, and (if filming is on) the Introverti morale penalty.
  const communityManagerReport = processWeeklyCommunityManagement(playerState);

  const narrativeReport = evaluateWeeklyEvents(gameState, { rng });
  const { birthdays, retirements } = processBirthdaysAndRetirements(playerState, worldState, rng);
  const rivalGymReport = processRivalGyms(worldState, rng);

  // V3.5 "Mercato": rival gyms may poach the player's own low-Loyalty
  // fighters every week — the reverse risk of buyoutRivalFighter().
  const poachingReport = rollWeeklyPoaching(playerState, worldState, rng);

  // Phase V2.7 ("Le Monde Vivant"): the autonomous transfer market runs
  // once per season boundary — rival gyms recruit/extend/release entirely
  // on their own, independent of anything the player did this week.
  const transferMarketReport = worldState.season !== seasonBefore ? processTransferMarket(worldState, { rng }) : null;

  // A themed prospect wave only ever fires on a genuine year boundary, and
  // only if isProspectWaveDue() agrees this exact year hasn't already
  // produced one (guards against advanceWeek somehow running twice into
  // the same year-boundary week, and against re-firing on load).
  const prospectWaveReport =
    worldState.year !== yearBefore && isProspectWaveDue(worldState) ? generateProspectWave(worldState, { rng }) : null;

  const summary = {
    day: worldState.currentDay,
    season: worldState.season,
    year: worldState.year,
    trainingReport,
    economyReport,
    fightWeekReport,
    staffReport,
    communityManagerReport,
    narrativeReport,
    birthdays,
    retirements,
    rivalGymReport,
    poachingReport,
    transferMarketReport,
    prospectWaveReport,
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
