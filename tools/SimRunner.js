/**
 * tools/SimRunner.js
 * ---------------------------------------------------------------------------
 * Headless Phase 3.0 balance simulator: runs a single continuous GameState
 * forward across N in-world BALANCE.CALENDAR "seasons" (WEEKS_PER_SEASON
 * weeks each) with no /render module ever imported, and no DOM/browser
 * dependency of any kind — safe to run under plain `node`.
 *
 * "N seasons" means one continuous timeline of N * WEEKS_PER_SEASON weeks
 * (matching how the game itself defines a season, see BALANCE.CALENDAR),
 * not N independent short playthroughs — this is what lets it produce
 * meaningful long-horizon signals (e.g. a fighter's age at forced
 * retirement) that a handful of 13-week trials never would, and it is why
 * statistics are recorded "a chaque saison et a chaque semaine": one weekly
 * sample per in-world week, plus a rolled-up snapshot at every season
 * boundary, both against that same single timeline.
 *
 * Every fight/training/economy/narrative tick reuses the real engines
 * (CombatEngine, ProgressionEngine.advanceWeek, and the full Pyramide
 * Emergente reactive stack) exactly as App.js wires them for a real
 * session — this file only adds the two things a real session gets from a
 * human player: a roster to start from, and a matchmaking/training
 * "coach AI" that decides what the roster does each week.
 *
 * Known, deliberate simplifications (see the report's own notes):
 *   - No title fights are auto-booked (BALANCE.AGE.RETIREMENT's *voluntary*
 *     retirement chance is not wired into any engine yet either — this
 *     tool measures the game as it actually behaves today, so every
 *     departure it observes is a forced retirement at
 *     BALANCE.AGE.RETIREMENT.FORCED_RETIREMENT_AGE, not a fabricated one).
 *   - Matchmaking is a simple weekly shuffle-and-pair over the
 *     non-injured roster, gated by a flat per-pair chance — there is no
 *     real matchmaking/booking engine in the game yet for this tool to
 *     reuse instead.
 * ---------------------------------------------------------------------------
 */

import EventBus from '../core/EventBus.js';
import BALANCE from '../data/balance.js';
import Fighter from '../models/Fighter.js';
import { GameState } from '../state/GameState.js';
import { CombatEngine, createSeededRng } from '../engine/CombatEngine.js';
import { advanceWeek } from '../engine/ProgressionEngine.js';
import { generatePersonality } from '../engine/FighterGenerator.js';
import { PersonalityEngine } from '../engine/PersonalityEngine.js';
import { RelationshipEngine } from '../engine/RelationshipEngine.js';
import { StoryEngine } from '../engine/StoryEngine.js';
import { NarrativeEngine, NARRATIVE_ENGINE_EVENTS } from '../engine/NarrativeEngine.js';
import { WorldMemory } from '../engine/WorldMemory.js';
import { SocialEngine } from '../engine/SocialEngine.js';

const WEEKS_PER_SEASON = BALANCE.CALENDAR.WEEKS_PER_SEASON;
const SKILL_KEYS = Object.freeze(['boxe', 'jambes', 'sol', 'soumission', 'cardio', 'intelligence']);

/** Fighting styles this tool generates fighters into — the exact set CombatEngine gives a bonus to (see BALANCE.COMBAT.STYLE_BONUSES), minus the catch-all DEFAULT. */
const STYLE_KEYS = Object.keys(BALANCE.COMBAT.STYLE_BONUSES).filter((key) => key !== 'DEFAULT');
/** Training country-bonus origins this tool generates fighters into (see BALANCE.TRAINING.COUNTRY_BONUSES), minus the catch-all DEFAULT. */
const ORIGIN_KEYS = Object.keys(BALANCE.TRAINING.COUNTRY_BONUSES).filter((key) => key !== 'DEFAULT');
/**
 * No canonical weight-class list exists in data/balance.js yet (Fighter
 * doesn't validate identity.weightClass) — this is local flavor for the
 * simulator, not a BALANCE-owned gameplay concept.
 */
const WEIGHT_CLASSES = Object.freeze([
  'Poids Mouche',
  'Poids Coq',
  'Poids Plume',
  'Poids Leger',
  'Poids Welter',
  'Poids Moyen',
  'Poids Mi-Lourd',
  'Poids Lourd',
]);
const FIRST_NAMES = Object.freeze([
  'Alex', 'Sacha', 'Kylian', 'Noe', 'Malo', 'Ines', 'Yanis', 'Lena',
  'Rayan', 'Camille', 'Diego', 'Amina', 'Kenji', 'Nina', 'Bruno', 'Fatou',
]);
const LAST_NAMES = Object.freeze([
  'Moreau', 'Silva', 'Nakamura', 'Diallo', 'Kowalski', 'Rossi', 'Novak', 'Santos',
  'Petit', 'Ivanov', 'Costa', 'Haddad', 'Larsson', 'Okafor', 'Dubois', 'Reyes',
]);

/** Simulation-local matchmaking knobs — not core game balance, just this tool's "coach AI". */
const SIM_DEFAULTS = Object.freeze({
  SEASONS: 1000,
  ROSTER_SIZE: 8,
  FIGHT_CHANCE_PER_PAIR_PER_WEEK: 0.18,
  ORG_ID: 'WFC',
  HARD_TRAINING_CHANCE: 0.2,
});

function pick(rng, list) {
  return list[Math.floor(rng() * list.length)];
}

function shuffleInPlace(list, rng) {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function generateFighterName(rng) {
  return `${pick(rng, FIRST_NAMES)} ${pick(rng, LAST_NAMES)}`;
}

/**
 * A style's skill spread leans toward the skills its own preferred distance
 * favors (see BALANCE.COMBAT.GAMEPLAN.DISTANCE_SKILL_WEIGHTS) — without
 * this, style would be cosmetic-only flavor text uncorrelated with what a
 * fighter is actually good at, and "Dominance des Styles" would just be
 * measuring random noise instead of the style's own design.
 */
function generateSkills(rng, styleKey) {
  const base = BALANCE.PROGRESSION.DEFAULT_STARTING_SKILL_VALUE;
  const spread = 15;
  const specialistBonus = 10;
  const styleBonus = BALANCE.COMBAT.STYLE_BONUSES[styleKey] ?? BALANCE.COMBAT.STYLE_BONUSES.DEFAULT;
  const distanceWeights = styleBonus.distance ? BALANCE.COMBAT.GAMEPLAN.DISTANCE_SKILL_WEIGHTS[styleBonus.distance] : null;

  return Object.fromEntries(
    SKILL_KEYS.map((key) => {
      const lean = (distanceWeights?.[key] ?? 0) * specialistBonus;
      return [key, Math.round(base + (rng() * 2 - 1) * spread + lean)];
    })
  );
}

/**
 * Picks the target/distance a fighter's own style is designed to exploit
 * (see BALANCE.COMBAT.STYLE_BONUSES), so every simulated fight actually
 * lets each style benefit from its bonus instead of everyone defaulting to
 * CombatEngine's plain HEAD/STRIKING/BALANCED gameplan — which would silence
 * every style bonus that isn't already HEAD/STRIKING (e.g. Muay Thai's
 * LEGS/BODY targeting, or Lutte/Jiu-Jitsu Bresilien's GROUND distance) and
 * make "Dominance des Styles" measure gameplan defaults, not style design.
 */
function gameplanForStyle(styleKey) {
  const styleBonus = BALANCE.COMBAT.STYLE_BONUSES[styleKey] ?? BALANCE.COMBAT.STYLE_BONUSES.DEFAULT;
  const distance = styleBonus.distance ?? 'STRIKING';

  let target = 'HEAD';
  if (styleBonus.targetMultipliers) {
    target = Object.keys(styleBonus.targetMultipliers).reduce((best, candidate) =>
      styleBonus.targetMultipliers[candidate] > (styleBonus.targetMultipliers[best] ?? 0) ? candidate : best
    );
  }

  return { target, distance, tempo: 'BALANCED' };
}

/**
 * Spreads ego/discipline/motivation around their BALANCE starting values
 * instead of leaving every generated fighter flat at the same default —
 * without this, e.g. StoryEngine's CONFLICT_POTENTIAL detector (which
 * requires psychology.ego >= BALANCE.STORY.CONFLICT_POTENTIAL.MIN_LOSER_EGO)
 * could never fire for a single simulator-generated fighter.
 */
function generatePsychologyStats(rng) {
  const { MIN, MAX, STARTING_VALUES } = BALANCE.PSYCHOLOGY;
  const spread = 30;
  const roll = (starting) => Math.round(Math.min(MAX, Math.max(MIN, starting + (rng() * 2 - 1) * spread)));
  return {
    ego: roll(STARTING_VALUES.ego),
    discipline: roll(STARTING_VALUES.discipline),
    motivation: roll(STARTING_VALUES.motivation),
  };
}

/**
 * Deterministic id source for generated fighters. Fighter's own default id
 * (models/Fighter.js#generateId) mixes in Date.now(), and ProgressionEngine
 * hashes that id to schedule each fighter's in-world birthday — so leaving
 * it to the default would make two runs with the same seed age (and
 * therefore forced-retire) fighters differently, breaking reproducibility
 * for no gameplay reason. Supplying our own sequential id sidesteps that
 * entirely, without touching Fighter.js.
 */
function createFighterIdSequencer() {
  let n = 0;
  return () => {
    n += 1;
    return `sim_fighter_${n}`;
  };
}

/** Generates one fresh, fully-valid Fighter for the sim's roster (initial fill or a forced-retirement replacement). */
function generateFighter(rng, nextFighterId) {
  const { DEBUT_MIN_AGE, DEBUT_MAX_AGE } = BALANCE.AGE;
  const age = DEBUT_MIN_AGE + Math.floor(rng() * (DEBUT_MAX_AGE - DEBUT_MIN_AGE + 1));
  const style = pick(rng, STYLE_KEYS);

  return new Fighter({
    identity: {
      id: nextFighterId(),
      name: generateFighterName(rng),
      age,
      style,
      weightClass: pick(rng, WEIGHT_CLASSES),
      origin: pick(rng, ORIGIN_KEYS),
    },
    attributes: { skills: generateSkills(rng, style) },
    psychology: { personality: generatePersonality(rng), ...generatePsychologyStats(rng) },
  });
}

/** Bumps equipLevel (facility level) just enough for the roster to fit, capped at the real facility level ceiling. */
function ensureRosterCapacity(playerState, desiredSize) {
  const maxLevel = BALANCE.ECONOMY.FACILITY_UPGRADE.MAX_LEVEL;
  while (playerState.getRosterCapacity() < desiredSize && playerState.equipLevel < maxLevel) {
    playerState.equipLevel += 1;
  }
  return Math.min(desiredSize, playerState.getRosterCapacity());
}

// ---- stats accumulator -----------------------------------------------------

function emptyArchetypeBucket() {
  return { wins: 0, losses: 0, draws: 0, fighterCount: 0, retirements: [] };
}

function emptyStyleBucket() {
  return { wins: 0, losses: 0, draws: 0 };
}

function createStatsAccumulator() {
  const archetypes = {};
  for (const key of Object.keys(BALANCE.PERSONALITY.ARCHETYPES)) archetypes[key] = emptyArchetypeBucket();

  const styles = {};
  for (const key of STYLE_KEYS) styles[key] = emptyStyleBucket();

  return {
    economy: {
      weeksSimulated: 0,
      balanceSum: 0,
      minBalanceEver: Infinity,
      maxBalanceEver: -Infinity,
      totalIncome: 0,
      totalExpenses: 0,
      insolvencyWeeks: 0,
    },
    archetypes,
    styles,
    health: {
      totalInjuries: 0,
      bySource: { COMBAT: 0, TRAINING: 0, SPARRING: 0 },
      bySeverity: {},
    },
    fights: { total: 0, byMethod: {} },
    fighters: { totalGenerated: 0, totalRetired: 0 },
    fun: { totalWeeks: 0, dullWeeks: 0 },
    narrative: { totalBeats: 0, byTone: {} },
    weeklyMetrics: [],
    seasonalMetrics: [],
  };
}

/**
 * Recorded from two shapes: a full injury record (severity + occurred/until
 * days, from a fight or an overtraining roll) or just `{ severity }` (from
 * EventEngine's SPARRING_INJURY weekly event, whose returned record doesn't
 * carry the day fields). Either way, recovery length is looked up straight
 * from BALANCE.INJURIES.RECOVERY_DAYS rather than diffed from those fields,
 * since that table is what actually determined it in the first place.
 */
function recordInjury(stats, injury, source) {
  if (!injury) return;
  stats.health.totalInjuries += 1;
  stats.health.bySource[source] = (stats.health.bySource[source] ?? 0) + 1;

  const bucket =
    stats.health.bySeverity[injury.severity] ?? (stats.health.bySeverity[injury.severity] = { count: 0, totalRecoveryDays: 0 });
  bucket.count += 1;
  bucket.totalRecoveryDays += BALANCE.INJURIES.RECOVERY_DAYS[injury.severity] ?? 0;
}

/** Books this week's fights over the non-injured roster (shuffle + adjacent pairing), and folds every result into `stats`. */
function bookWeeklyFights({ playerState, worldState, combatEngine, rng, stats, fightChancePerPair, orgId }) {
  const available = shuffleInPlace(
    playerState.roster.filter((fighter) => !fighter.isInjured(worldState.currentDay)),
    rng
  );

  let fightsBooked = 0;
  for (let i = 0; i + 1 < available.length; i += 2) {
    if (rng() >= fightChancePerPair) continue;

    const fighterA = available[i];
    const fighterB = available[i + 1];
    combatEngine.setupMatch(fighterA, fighterB, orgId, false);
    combatEngine.setGameplan('A', gameplanForStyle(fighterA.identity.style));
    combatEngine.setGameplan('B', gameplanForStyle(fighterB.identity.style));
    const result = combatEngine.simulateFullMatch();
    fightsBooked += 1;

    stats.fights.total += 1;
    stats.fights.byMethod[result.method] = (stats.fights.byMethod[result.method] ?? 0) + 1;

    const isDraw = result.winner === null;
    for (const [key, fighter] of [['A', fighterA], ['B', fighterB]]) {
      const outcome = isDraw ? 'draws' : result.winner === key ? 'wins' : 'losses';
      stats.archetypes[fighter.psychology.personality.archetype][outcome] += 1;
      stats.styles[fighter.identity.style][outcome] += 1;
      recordInjury(stats, result.injuries?.[key], 'COMBAT');
    }
  }

  return fightsBooked;
}

/** Sets this week's training plan for every non-injured fighter: focus their weakest skill, rest when form is too low to train safely. */
function assignTrainingPlans(playerState, worldState, rng) {
  const restFormeFloor = BALANCE.TRAINING.OVERTRAINING.FORME_THRESHOLD_PERCENT * BALANCE.FORM.MAX;

  for (const fighter of playerState.roster) {
    if (fighter.isInjured(worldState.currentDay)) {
      fighter.setTrainingPlan({ focus: null, intensity: 'REST' });
      continue;
    }

    const skills = fighter.attributes.skills;
    const weakest = SKILL_KEYS.reduce((min, key) => (skills[key] < skills[min] ? key : min), SKILL_KEYS[0]);
    const intensity =
      fighter.attributes.forme < restFormeFloor ? 'REST' : rng() < SIM_DEFAULTS.HARD_TRAINING_CHANCE ? 'HARD' : 'NORMAL';

    fighter.setTrainingPlan({ focus: weakest, intensity });
  }
}

/** Removes every fighter who hit forced retirement this week (per ProgressionEngine's birthday pass), recording career stats, and replaces them so roster size stays constant. */
function processRetirements({ summary, playerState, rng, stats, nextFighterId }) {
  for (const { fighterId } of summary.birthdays) {
    const fighter = playerState.getFighter(fighterId);
    if (!fighter || !fighter.isForcedRetirement()) continue;

    const bucket = stats.archetypes[fighter.psychology.personality.archetype];
    bucket.retirements.push({
      age: fighter.identity.age,
      wins: fighter.career.wins,
      losses: fighter.career.losses,
      draws: fighter.career.draws,
      titles: fighter.career.titles.length,
    });
    stats.fighters.totalRetired += 1;

    playerState.removeFighter(fighterId);
    playerState.addFighter(generateFighter(rng, nextFighterId));
    stats.fighters.totalGenerated += 1;
  }
}

function recordWeeklyEconomy(stats, playerState, economyReport) {
  const econ = stats.economy;
  econ.weeksSimulated += 1;
  econ.balanceSum += playerState.money;
  econ.minBalanceEver = Math.min(econ.minBalanceEver, playerState.money);
  econ.maxBalanceEver = Math.max(econ.maxBalanceEver, playerState.money);
  econ.totalIncome += economyReport.passiveIncome;
  econ.totalExpenses += economyReport.rent + economyReport.coachPayroll + economyReport.equipmentMaintenance;
  if (economyReport.insolvent) econ.insolvencyWeeks += 1;
}

/**
 * "Dull week" (semaine creuse): nothing happened worth telling a player
 * about — no fight, no narrative beat (weekly random event OR a
 * fight-triggered StoryEngine/NarrativeEngine beat), no financial crisis.
 */
function isDullWeek({ fightsThisWeek, economyReport, narrativeReport, narrativeBeatsThisWeek }) {
  const noNarrative = narrativeReport.triggered.length === 0 && narrativeBeatsThisWeek === 0;
  const noProgression = fightsThisWeek === 0;
  const noFinancialTension = !economyReport.insolvent;
  return noNarrative && noProgression && noFinancialTension;
}

// ---- reactive engine lifecycle ----------------------------------------------

function createReactiveEngines() {
  return {
    personalityEngine: new PersonalityEngine(),
    relationshipEngine: new RelationshipEngine(),
    storyEngine: new StoryEngine(),
    narrativeEngine: new NarrativeEngine(),
    worldMemory: new WorldMemory(),
    socialEngine: new SocialEngine(),
  };
}

function attachReactiveEngines(engines, playerState, worldState) {
  engines.personalityEngine.attach(playerState);
  engines.relationshipEngine.attach(worldState);
  engines.storyEngine.attach(playerState, worldState);
  engines.narrativeEngine.attach(playerState, worldState);
  engines.worldMemory.attach(worldState);
  engines.socialEngine.attach(playerState);
}

function detachReactiveEngines(engines) {
  engines.personalityEngine.detach();
  engines.relationshipEngine.detach();
  engines.storyEngine.detach();
  engines.narrativeEngine.detach();
  engines.worldMemory.detach();
  engines.socialEngine.detach();
}

// ---- public entry point ------------------------------------------------------

/**
 * Runs the headless balance simulation.
 *
 * @param {Object} [options]
 * @param {number} [options.seasons=1000] - Number of BALANCE.CALENDAR seasons
 *   (WEEKS_PER_SEASON weeks each) to simulate, as one continuous timeline.
 * @param {number} [options.rosterSize=8] - Roster size the sim maintains
 *   throughout the run (clamped to what facility upgrades can hold).
 * @param {number} [options.fightChancePerPair] - Chance, per shuffled
 *   adjacent pair of non-injured roster fighters, that they're booked to
 *   fight in a given week. Defaults to SIM_DEFAULTS.FIGHT_CHANCE_PER_PAIR_PER_WEEK.
 * @param {number} [options.seed] - Seeds a reproducible RNG (mulberry32) via
 *   CombatEngine.createSeededRng. Ignored if `rng` is provided. Omit both for
 *   Math.random.
 * @param {() => number} [options.rng] - Explicit random source override.
 * @param {(seasonIndex: number, totalSeasons: number) => void} [options.onSeasonComplete]
 *   - Optional progress callback, invoked once per completed season.
 * @returns {Object} A finalized, report-ready statistics object.
 */
export function runSimulation(options = {}) {
  const seasons = options.seasons ?? SIM_DEFAULTS.SEASONS;
  const rosterSize = options.rosterSize ?? SIM_DEFAULTS.ROSTER_SIZE;
  const fightChancePerPair = options.fightChancePerPair ?? SIM_DEFAULTS.FIGHT_CHANCE_PER_PAIR_PER_WEEK;
  const orgId = options.orgId ?? SIM_DEFAULTS.ORG_ID;
  const rng = options.rng ?? (options.seed !== undefined ? createSeededRng(options.seed) : Math.random);

  if (!Number.isInteger(seasons) || seasons <= 0) {
    throw new TypeError(`runSimulation: seasons must be a positive integer, got ${seasons}.`);
  }
  if (!Number.isInteger(rosterSize) || rosterSize <= 0) {
    throw new TypeError(`runSimulation: rosterSize must be a positive integer, got ${rosterSize}.`);
  }

  const totalWeeks = seasons * WEEKS_PER_SEASON;

  const gameState = new GameState();
  gameState.newGame({ gymName: 'Simulation Headless', country: 'SIM' });
  const { playerState, worldState } = gameState;

  const nextFighterId = createFighterIdSequencer();
  const actualRosterSize = ensureRosterCapacity(playerState, rosterSize);
  for (let i = 0; i < actualRosterSize; i += 1) {
    playerState.addFighter(generateFighter(rng, nextFighterId));
  }

  const combatEngine = new CombatEngine({ playerState, worldState, rng });
  const engines = createReactiveEngines();
  attachReactiveEngines(engines, playerState, worldState);

  const stats = createStatsAccumulator();
  stats.fighters.totalGenerated += actualRosterSize;

  let narrativeBeatsThisWeek = 0;
  const unsubscribeNarrative = EventBus.subscribe(NARRATIVE_ENGINE_EVENTS.PUBLISHED, (beat) => {
    narrativeBeatsThisWeek += 1;
    stats.narrative.totalBeats += 1;
    stats.narrative.byTone[beat.tone] = (stats.narrative.byTone[beat.tone] ?? 0) + 1;
  });

  let seasonAcc = createSeasonAccumulator();
  const startedAt = Date.now();

  try {
    for (let weekIndex = 0; weekIndex < totalWeeks; weekIndex += 1) {
      narrativeBeatsThisWeek = 0;

      assignTrainingPlans(playerState, worldState, rng);

      const summary = advanceWeek(gameState, { rng });

      for (const injury of summary.trainingReport.injuries) recordInjury(stats, injury, 'TRAINING');
      for (const event of summary.narrativeReport.triggered) {
        if (event.category === 'SPARRING_INJURY') {
          recordInjury(stats, { severity: event.severity }, 'SPARRING');
        }
      }

      const fightsThisWeek = bookWeeklyFights({
        playerState,
        worldState,
        combatEngine,
        rng,
        stats,
        fightChancePerPair,
        orgId,
      });

      processRetirements({ summary, playerState, rng, stats, nextFighterId });

      recordWeeklyEconomy(stats, playerState, summary.economyReport);

      const dull = isDullWeek({
        fightsThisWeek,
        economyReport: summary.economyReport,
        narrativeReport: summary.narrativeReport,
        narrativeBeatsThisWeek,
      });
      stats.fun.totalWeeks += 1;
      if (dull) stats.fun.dullWeeks += 1;

      stats.weeklyMetrics.push({
        week: weekIndex + 1,
        day: worldState.currentDay,
        season: worldState.season,
        year: worldState.year,
        money: playerState.money,
        reputation: playerState.reputation,
        hype: playerState.hype,
        fights: fightsThisWeek,
        dull: dull ? 1 : 0,
      });

      accumulateIntoSeason(seasonAcc, {
        money: playerState.money,
        fights: fightsThisWeek,
        dull,
        insolvent: summary.economyReport.insolvent,
      });

      const isSeasonBoundary = (weekIndex + 1) % WEEKS_PER_SEASON === 0;
      if (isSeasonBoundary) {
        const seasonIndex = (weekIndex + 1) / WEEKS_PER_SEASON;
        stats.seasonalMetrics.push(finalizeSeasonAccumulator(seasonAcc, seasonIndex));
        seasonAcc = createSeasonAccumulator();
        options.onSeasonComplete?.(seasonIndex, seasons);
      }
    }
  } catch (error) {
    error.message = `[SimRunner] ${error.message} (week ${stats.weeklyMetrics.length + 1} of ${totalWeeks})`;
    throw error;
  } finally {
    unsubscribeNarrative();
    detachReactiveEngines(engines);
  }

  const durationMs = Date.now() - startedAt;
  return finalizeStats(stats, { seasons, weeksPerSeason: WEEKS_PER_SEASON, totalWeeks, rosterSize: actualRosterSize, fightChancePerPair, orgId, seed: options.seed }, durationMs);
}

// ---- season rollups ------------------------------------------------------------

function createSeasonAccumulator() {
  return { weeks: 0, moneySum: 0, fights: 0, dullWeeks: 0, insolvencyWeeks: 0 };
}

function accumulateIntoSeason(acc, { money, fights, dull, insolvent }) {
  acc.weeks += 1;
  acc.moneySum += money;
  acc.fights += fights;
  if (dull) acc.dullWeeks += 1;
  if (insolvent) acc.insolvencyWeeks += 1;
}

function finalizeSeasonAccumulator(acc, seasonIndex) {
  return {
    season: seasonIndex,
    weeks: acc.weeks,
    avgMoney: acc.weeks > 0 ? acc.moneySum / acc.weeks : 0,
    totalFights: acc.fights,
    dullWeeks: acc.dullWeeks,
    dullWeekRate: acc.weeks > 0 ? acc.dullWeeks / acc.weeks : 0,
    insolvencyWeeks: acc.insolvencyWeeks,
  };
}

// ---- final report shape -----------------------------------------------------

function winRate(bucket) {
  const total = bucket.wins + bucket.losses + bucket.draws;
  return total > 0 ? bucket.wins / total : null;
}

function average(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function finalizeStats(stats, config, durationMs) {
  const archetypes = Object.fromEntries(
    Object.entries(stats.archetypes).map(([key, bucket]) => [
      key,
      {
        wins: bucket.wins,
        losses: bucket.losses,
        draws: bucket.draws,
        winRate: winRate(bucket),
        retirementCount: bucket.retirements.length,
        avgRetirementAge: average(bucket.retirements.map((r) => r.age)),
        avgWinsAtRetirement: average(bucket.retirements.map((r) => r.wins)),
        avgLossesAtRetirement: average(bucket.retirements.map((r) => r.losses)),
      },
    ])
  );

  const styles = Object.fromEntries(
    Object.entries(stats.styles).map(([key, bucket]) => [
      key,
      { wins: bucket.wins, losses: bucket.losses, draws: bucket.draws, winRate: winRate(bucket) },
    ])
  );

  const bySeverity = Object.fromEntries(
    Object.entries(stats.health.bySeverity).map(([severity, bucket]) => [
      severity,
      { count: bucket.count, avgRecoveryDays: bucket.count > 0 ? bucket.totalRecoveryDays / bucket.count : null },
    ])
  );

  const econ = stats.economy;

  return {
    config,
    durationMs,
    economy: {
      weeksSimulated: econ.weeksSimulated,
      avgBalance: econ.weeksSimulated > 0 ? econ.balanceSum / econ.weeksSimulated : null,
      minBalanceEver: Number.isFinite(econ.minBalanceEver) ? econ.minBalanceEver : null,
      maxBalanceEver: Number.isFinite(econ.maxBalanceEver) ? econ.maxBalanceEver : null,
      avgWeeklyIncome: econ.weeksSimulated > 0 ? econ.totalIncome / econ.weeksSimulated : null,
      avgWeeklyExpenses: econ.weeksSimulated > 0 ? econ.totalExpenses / econ.weeksSimulated : null,
      insolvencyWeeks: econ.insolvencyWeeks,
      insolvencyRate: econ.weeksSimulated > 0 ? econ.insolvencyWeeks / econ.weeksSimulated : null,
    },
    archetypes,
    styles,
    health: {
      totalInjuries: stats.health.totalInjuries,
      bySource: stats.health.bySource,
      bySeverity,
    },
    fights: stats.fights,
    fighters: stats.fighters,
    fun: {
      totalWeeks: stats.fun.totalWeeks,
      dullWeeks: stats.fun.dullWeeks,
      dullWeekRate: stats.fun.totalWeeks > 0 ? stats.fun.dullWeeks / stats.fun.totalWeeks : null,
    },
    narrative: stats.narrative,
    weeklyMetrics: stats.weeklyMetrics,
    seasonalMetrics: stats.seasonalMetrics,
  };
}

export { SIM_DEFAULTS };
