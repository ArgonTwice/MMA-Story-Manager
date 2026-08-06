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
import { CombatEngine, createSeededRng, FINISH_METHODS } from '../engine/CombatEngine.js';
import { advanceWeek } from '../engine/ProgressionEngine.js';
import { processWeeklyPlan } from '../engine/WeeklyPlanningEngine.js';
import { processWeeklyDrama } from '../engine/DramaEngine.js';
import { DRAMA_EVENTS } from '../data/events.js';
import { generatePersonality } from '../engine/FighterGenerator.js';
import { PersonalityEngine, computeActivityWeights } from '../engine/PersonalityEngine.js';
import { RelationshipEngine } from '../engine/RelationshipEngine.js';
import { StoryEngine } from '../engine/StoryEngine.js';
import { NarrativeEngine, NARRATIVE_ENGINE_EVENTS } from '../engine/NarrativeEngine.js';
import { WorldMemory } from '../engine/WorldMemory.js';
import { SocialEngine } from '../engine/SocialEngine.js';

/** Not exported by CombatEngine.js (its own copy is module-private) — same set, mirrored the way engine/SocialEngine.js already does from FINISH_METHODS. */
const DECISION_METHODS = Object.freeze([
  FINISH_METHODS.UNANIMOUS_DECISION,
  FINISH_METHODS.SPLIT_DECISION,
  FINISH_METHODS.MAJORITY_DECISION,
]);

const WEEKS_PER_SEASON = BALANCE.CALENDAR.WEEKS_PER_SEASON;
const SKILL_KEYS = Object.freeze(['boxe', 'jambes', 'sol', 'soumission', 'cardio', 'intelligence']);

/** Fighting styles this tool generates fighters into — the exact set CombatEngine gives a bonus to (see BALANCE.COMBAT.STYLE_BONUSES), minus the catch-all DEFAULT. */
const STYLE_KEYS = Object.keys(BALANCE.COMBAT.STYLE_BONUSES).filter((key) => key !== 'DEFAULT');
/** Training country-bonus origins this tool generates fighters into (see BALANCE.TRAINING.COUNTRY_BONUSES), minus the catch-all DEFAULT. */
const ORIGIN_KEYS = Object.keys(BALANCE.TRAINING.COUNTRY_BONUSES).filter((key) => key !== 'DEFAULT');
/** Valid gameplan tempo choices (see BALANCE.COMBAT.GAMEPLAN.TEMPO_MODIFIERS) — CONSERVATIVE/BALANCED/AGGRESSIVE. */
const TEMPO_KEYS = Object.freeze(Object.keys(BALANCE.COMBAT.GAMEPLAN.TEMPO_MODIFIERS));
/** Styles whose native distance is GROUND (see BALANCE.COMBAT.STYLE_BONUSES) — the "grappling" aggregate reported alongside the Version History Tracker. */
const GRAPPLING_STYLE_KEYS = Object.freeze(STYLE_KEYS.filter((key) => BALANCE.COMBAT.STYLE_BONUSES[key]?.distance === 'GROUND'));
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
 *
 * Tempo is picked at random (uniformly across CONSERVATIVE/BALANCED/
 * AGGRESSIVE) rather than hardcoded — a fixed BALANCED tempo would leave
 * the "aggressiveness" telemetry (tempoMetrics) with nothing to compare,
 * since only one bucket would ever collect data.
 */
function gameplanForStyle(styleKey, rng) {
  const styleBonus = BALANCE.COMBAT.STYLE_BONUSES[styleKey] ?? BALANCE.COMBAT.STYLE_BONUSES.DEFAULT;
  const distance = styleBonus.distance ?? 'STRIKING';

  let target = 'HEAD';
  if (styleBonus.targetMultipliers) {
    target = Object.keys(styleBonus.targetMultipliers).reduce((best, candidate) =>
      styleBonus.targetMultipliers[candidate] > (styleBonus.targetMultipliers[best] ?? 0) ? candidate : best
    );
  }

  return { target, distance, tempo: pick(rng, TEMPO_KEYS) };
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

/** Generates a fighter, adds it to the roster, and records it in the run's population/diversity stats (initial fill and every retirement replacement funnel through here). */
function spawnFighter(playerState, stats, rng, nextFighterId) {
  const fighter = generateFighter(rng, nextFighterId);
  playerState.addFighter(fighter);
  stats.fighters.totalGenerated += 1;
  stats.fighterCountsByStyle[fighter.identity.style] += 1;
  return fighter;
}

/** Bumps equipLevel (facility level) just enough for the roster to fit, capped at the real facility level ceiling. */
function ensureRosterCapacity(playerState, desiredSize) {
  const maxLevel = BALANCE.ECONOMY.FACILITY_UPGRADE.MAX_LEVEL;
  while (playerState.getRosterCapacity() < desiredSize && playerState.equipLevel < maxLevel) {
    playerState.equipLevel += 1;
  }
  return Math.min(desiredSize, playerState.getRosterCapacity());
}

/**
 * Phase 3.2: seeds BALANCE.DRAMA.SEEDED_RIVAL_GYM_COUNT synthetic rival
 * gyms so RIVALRIES-category drama events (and the pre-existing but
 * previously-dormant engine/ProgressionEngine.js#processRivalGyms weekly
 * drift/fights, never fed any data before this headless simulator ever
 * called WorldState#addRivalGym) have something real to read.
 */
function seedRivalGyms(worldState, rng) {
  const w = BALANCE.WORLD;
  for (let i = 0; i < BALANCE.DRAMA.SEEDED_RIVAL_GYM_COUNT; i += 1) {
    worldState.addRivalGym({
      name: `Rival Gym ${i + 1}`,
      reputation: BALANCE.GYM.STARTING_REPUTATION + Math.round((rng() - 0.5) * 20),
      activity: w.RIVAL_GYM_ACTIVITY.STARTING_VALUE,
    });
  }
}

// ---- stats accumulator -----------------------------------------------------

function emptyArchetypeBucket() {
  return { wins: 0, losses: 0, draws: 0, fighterCount: 0, retirements: [] };
}

function emptyStyleBucket() {
  return { wins: 0, losses: 0, draws: 0 };
}

function emptyMatchupCell() {
  return { wins: 0, losses: 0, draws: 0 };
}

/** NxN matrix: matrix[rowStyle][columnStyle] is the row style's record against the column style. */
function createStyleMatchupMatrix() {
  const matrix = {};
  for (const rowStyle of STYLE_KEYS) {
    matrix[rowStyle] = {};
    for (const colStyle of STYLE_KEYS) matrix[rowStyle][colStyle] = emptyMatchupCell();
  }
  return matrix;
}

/** Mirrors CombatEngine's _createEmptyActionMetric() shape — see engine/CombatEngine.js's actionMetrics doc comment. */
function emptyActionMetricBucket() {
  return {
    attempts: 0,
    successes: 0,
    totalDamage: 0,
    totalScorePoints: 0,
    totalControlRounds: 0,
    totalDamageTaken: 0,
    totalStaminaPenalty: 0,
    totalMomentumPenalty: 0,
  };
}

/** Same 6 buckets CombatEngine's _resolveActionBucket() ever produces. */
const ACTION_BUCKET_KEYS = Object.freeze([
  'HEAD_STRIKE',
  'BODY_STRIKE',
  'LEG_STRIKE',
  'CLINCH',
  'TAKEDOWN',
  'SUBMISSION_ATTEMPT',
]);

function createActionMetricsAccumulator() {
  const buckets = {};
  for (const key of ACTION_BUCKET_KEYS) buckets[key] = emptyActionMetricBucket();
  return buckets;
}

function createTempoMetricsAccumulator() {
  const buckets = {};
  for (const key of TEMPO_KEYS) buckets[key] = { rounds: 0, totalDamage: 0, totalScorePoints: 0 };
  return buckets;
}

function emptyCombatMetricsAccumulator() {
  return {
    fightsWithMetrics: 0,
    takedownAttempts: 0,
    takedownSuccess: 0,
    takedownDefended: 0,
    standingRounds: 0,
    clinchRounds: 0,
    groundRounds: 0,
    standingDamageDealt: 0,
    groundDamageDealt: 0,
    submissionAttempts: 0,
    submissionSuccess: 0,
    countersTriggered: 0,
    judgePointsFromDamage: 0,
    judgePointsFromGroundControl: 0,
    decisionFights: 0,
    groundDominantDecisionFights: 0,
    groundDominantWins: 0,
    actionMetrics: createActionMetricsAccumulator(),
    tempoMetrics: createTempoMetricsAccumulator(),
  };
}

/** style -> { [FINISH_METHODS value]: winCount } — how each style's wins break down by method. */
function createStyleWinMethodsAccumulator() {
  const byStyle = {};
  for (const style of STYLE_KEYS) {
    byStyle[style] = {};
    for (const method of Object.values(FINISH_METHODS)) byStyle[style][method] = 0;
  }
  return byStyle;
}

function createStatsAccumulator() {
  const archetypes = {};
  for (const key of Object.keys(BALANCE.PERSONALITY.ARCHETYPES)) archetypes[key] = emptyArchetypeBucket();

  const styles = {};
  const styleIdentity = {};
  const fighterCountsByStyle = {};
  for (const key of STYLE_KEYS) {
    styles[key] = emptyStyleBucket();
    styleIdentity[key] = { totalScore: 0, samples: 0 };
    fighterCountsByStyle[key] = 0;
  }

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
    styleMatchups: createStyleMatchupMatrix(),
    styleWinMethods: createStyleWinMethodsAccumulator(),
    styleIdentity,
    fighterCountsByStyle,
    combat: emptyCombatMetricsAccumulator(),
    health: {
      totalInjuries: 0,
      bySource: { COMBAT: 0, TRAINING: 0, SPARRING: 0 },
      bySeverity: {},
    },
    fights: { total: 0, byMethod: {} },
    fighters: { totalGenerated: 0, totalRetired: 0 },
    fun: { totalWeeks: 0, dullWeeks: 0 },
    narrative: { totalBeats: 0, byTone: {} },
    weeklyPlanning: createWeeklyPlanningAccumulator(),
    drama: createDramaAccumulator(),
    weeklyMetrics: [],
    seasonalMetrics: [],
  };
}

/** Phase 3.2 telemetry accumulator: per-event Event Choice Distribution ("aucun choix ne depasse 70%"), and total events resolved (to verify the "0.8 a 1.2 evenement/semaine" target). */
function createDramaAccumulator() {
  const byEvent = {};
  for (const event of DRAMA_EVENTS) {
    const choiceCounts = {};
    for (const choice of event.choices) choiceCounts[choice.id] = 0;
    byEvent[event.id] = { category: event.category, totalCount: 0, choiceCounts };
  }
  return { totalEventsResolved: 0, weeksSimulated: 0, byEvent };
}

function recordDramaTelemetry(stats, dramaReport) {
  const drama = stats.drama;
  drama.weeksSimulated += 1;
  for (const event of dramaReport.events) {
    drama.totalEventsResolved += 1;
    const bucket = drama.byEvent[event.eventId];
    if (!bucket) continue;
    bucket.totalCount += 1;
    bucket.choiceCounts[event.choiceId] = (bucket.choiceCounts[event.choiceId] ?? 0) + 1;
  }
}

function emptyActivityUsageCount() {
  const usage = {};
  for (const key of Object.keys(BALANCE.WEEKLY_PLANNING.ACTIVITIES)) usage[key] = 0;
  return usage;
}

/** Phase 3.1 v1/v2 telemetry accumulator: Training Diversity Index, Average Readiness on fight day, Mental vs Physical Fatigue, and per-archetype "Decision Quality"/Activity Distribution inputs. */
function createWeeklyPlanningAccumulator() {
  const byArchetype = {};
  for (const archetype of Object.keys(BALANCE.PERSONALITY.ARCHETYPES)) {
    byArchetype[archetype] = { fighterWeeks: 0, overheatWeeks: 0, activityUsageCount: emptyActivityUsageCount() };
  }

  return {
    activityUsageCount: emptyActivityUsageCount(),
    totalSlotsResolved: 0,
    readinessOnFightDaySum: 0,
    readinessOnFightDaySamples: 0,
    physicalFatigueSum: 0,
    mentalFatigueSum: 0,
    fatigueSamples: 0,
    byArchetype,
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

/** Records both directions of one fight's style-vs-style outcome into the NxN matrix (see createStyleMatchupMatrix). */
function recordStyleMatchup(stats, styleA, styleB, result) {
  const cellAvsB = stats.styleMatchups[styleA][styleB];
  const cellBvsA = stats.styleMatchups[styleB][styleA];

  if (result.winner === null) {
    cellAvsB.draws += 1;
    cellBvsA.draws += 1;
  } else if (result.winner === 'A') {
    cellAvsB.wins += 1;
    cellBvsA.losses += 1;
  } else {
    cellBvsA.wins += 1;
    cellAvsB.losses += 1;
  }
}

/**
 * Folds one fight's result.combatMetrics (see CombatEngine's
 * _createEmptyCombatMetrics) into the run-wide combat telemetry totals, plus
 * the judges' ground-control bias signal: for fights actually decided by
 * judges (draws excluded — there's no single winner to check dominance
 * against), was the fighter with more ground-control-derived points the one
 * who won?
 */
function recordCombatMetrics(stats, result) {
  const combat = stats.combat;
  combat.fightsWithMetrics += 1;

  for (const key of ['A', 'B']) {
    const m = result.combatMetrics[key];
    combat.takedownAttempts += m.takedownAttempts;
    combat.takedownSuccess += m.takedownSuccess;
    combat.takedownDefended += m.takedownDefended;
    combat.standingRounds += m.standingRounds;
    combat.clinchRounds += m.clinchRounds;
    combat.groundRounds += m.groundRounds;
    combat.standingDamageDealt += m.standingDamageDealt;
    combat.groundDamageDealt += m.groundDamageDealt;
    combat.submissionAttempts += m.submissionAttempts;
    combat.submissionSuccess += m.submissionSuccess;
    combat.countersTriggered += m.countersTriggered;
    combat.judgePointsFromDamage += m.judgePointsFromDamage;
    combat.judgePointsFromGroundControl += m.judgePointsFromGroundControl;

    for (const bucketKey of ACTION_BUCKET_KEYS) {
      const src = m.actionMetrics[bucketKey];
      const dst = combat.actionMetrics[bucketKey];
      dst.attempts += src.attempts;
      dst.successes += src.successes;
      dst.totalDamage += src.totalDamage;
      dst.totalScorePoints += src.totalScorePoints;
      dst.totalControlRounds += src.totalControlRounds;
      dst.totalDamageTaken += src.totalDamageTaken;
      dst.totalStaminaPenalty += src.totalStaminaPenalty;
      dst.totalMomentumPenalty += src.totalMomentumPenalty;
    }
    for (const tempoKey of TEMPO_KEYS) {
      const src = m.tempoMetrics[tempoKey];
      const dst = combat.tempoMetrics[tempoKey];
      dst.rounds += src.rounds;
      dst.totalDamage += src.totalDamage;
      dst.totalScorePoints += src.totalScorePoints;
    }
  }

  const groundControlA = result.combatMetrics.A.judgePointsFromGroundControl;
  const groundControlB = result.combatMetrics.B.judgePointsFromGroundControl;

  if (DECISION_METHODS.includes(result.method) && result.winner !== null) {
    combat.decisionFights += 1;
    if (groundControlA !== groundControlB) {
      combat.groundDominantDecisionFights += 1;
      const groundDominantKey = groundControlA > groundControlB ? 'A' : 'B';
      if (result.winner === groundDominantKey) combat.groundDominantWins += 1;
    }
  }
}

/** Credits the winning corner's style with a win by this fight's finish method (Win Condition Report). Draws credit nobody. */
function recordStyleWinMethod(stats, fighterA, fighterB, result) {
  if (result.winner === null) return;
  const winnerStyle = result.winner === 'A' ? fighterA.identity.style : fighterB.identity.style;
  stats.styleWinMethods[winnerStyle][result.method] += 1;
}

/** Folds both corners' one-time styleIdentityScores (see CombatEngine's _computeStyleIdentityScore) into the per-style running average. */
function recordStyleIdentity(stats, fighterA, fighterB, result) {
  for (const [fighter, key] of [[fighterA, 'A'], [fighterB, 'B']]) {
    const score = result.styleIdentityScores[key];
    if (score === null) continue; // Freestyle/DEFAULT has no distance affinity to score against
    const bucket = stats.styleIdentity[fighter.identity.style];
    bucket.totalScore += score;
    bucket.samples += 1;
  }
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
    combatEngine.setGameplan('A', gameplanForStyle(fighterA.identity.style, rng));
    combatEngine.setGameplan('B', gameplanForStyle(fighterB.identity.style, rng));
    const result = combatEngine.simulateFullMatch();
    fightsBooked += 1;

    stats.fights.total += 1;
    stats.fights.byMethod[result.method] = (stats.fights.byMethod[result.method] ?? 0) + 1;
    recordStyleMatchup(stats, fighterA.identity.style, fighterB.identity.style, result);
    recordCombatMetrics(stats, result);
    recordStyleWinMethod(stats, fighterA, fighterB, result);
    recordStyleIdentity(stats, fighterA, fighterB, result);

    // Phase 3.1 v1: Average Readiness "le jour du combat" — combatMetrics'
    // readiness field is a weigh-in-time snapshot (see CombatEngine's
    // _processWeighIn/_processPostMatchRewards), so it's only meaningful
    // for fights that actually happened, recorded here rather than in
    // recordWeeklyPlanningTelemetry (which runs every week, fight or not).
    stats.weeklyPlanning.readinessOnFightDaySum += result.combatMetrics.A.readiness + result.combatMetrics.B.readiness;
    stats.weeklyPlanning.readinessOnFightDaySamples += 2;

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

/**
 * Phase 3.1 v2's weekly-planning coach AI: replaces v1's 4 synthetic,
 * hash-assigned "planning styles" with the fighter's own REAL
 * archetype+traits, via engine/PersonalityEngine.js#computeActivityWeights
 * — "transformer les comportements d'archetypes en probabilites
 * d'attraction (non-scriptees)" per the spec. Every slot is an independent
 * weighted-random pick over that fighter's own activity-attraction profile;
 * there is no scripted fixed sequence and, deliberately, no
 * archetype-specific forced-rest override like v1 had — letting emergent
 * behavior (including runaway Fatigue for low-PHYSIO_REST-weight
 * archetypes) show up honestly in the telemetry rather than being
 * safety-netted away. The one remaining hard override is a real game-state
 * constraint, not a personality choice: an injured fighter cannot train.
 */
function weightedPick(rng, weights) {
  const entries = Object.entries(weights);
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = rng() * total;
  for (const [key, weight] of entries) {
    if (roll < weight) return key;
    roll -= weight;
  }
  return entries[entries.length - 1][0];
}

/** Sets this week's 3-slot weekly plan for every fighter: PHYSIO_REST-only while injured, otherwise a per-fighter archetype/trait-weighted pick per slot (see computeActivityWeights). */
function assignWeeklyPlan(playerState, worldState, rng) {
  const slotCount = BALANCE.WEEKLY_PLANNING.SLOTS_PER_WEEK;

  for (const fighter of playerState.roster) {
    const injured = fighter.isInjured(worldState.currentDay);
    const weights = injured ? null : computeActivityWeights(fighter);

    for (let slot = 0; slot < slotCount; slot += 1) {
      const activityKey = injured ? 'PHYSIO_REST' : weightedPick(rng, weights);
      fighter.setWeeklyPlanSlot(slot, activityKey);
    }
  }
}

/** Physical Fatigue level at/above which a fighter-week counts as "surmenage massif" for the Decision Quality Index below — this implementation's own chosen definition (the spec frames a qualitative "sans... surmenage massif" goal, not a fixed number). */
const MASSIVE_OVERHEAT_FATIGUE_THRESHOLD = 90;

/**
 * Folds one week's processWeeklyPlan() report into the run-wide Phase 3.1
 * v1/v2 telemetry: which activities got used, globally and per archetype
 * (Training Diversity Index / Archetype Activity Distribution), whether
 * each fighter ended the week at/over the massive-overheat Physical
 * Fatigue threshold (Decision Quality Index), and this week's Physical vs
 * Mental Fatigue snapshot (see tools/BalanceReporter.js). Average
 * Readiness on fight day is recorded separately, in bookWeeklyFights,
 * since it's only meaningful the week a fight actually happens.
 */
function recordWeeklyPlanningTelemetry(stats, playerState, weeklyPlanReport) {
  const wp = stats.weeklyPlanning;

  for (const entry of weeklyPlanReport.activityLog) {
    wp.activityUsageCount[entry.activity] += 1;
    wp.totalSlotsResolved += 1;

    const fighter = playerState.getFighter(entry.fighterId);
    if (fighter) wp.byArchetype[fighter.psychology.personality.archetype].activityUsageCount[entry.activity] += 1;
  }

  for (const fighter of playerState.roster) {
    const archetype = fighter.psychology.personality.archetype;
    wp.byArchetype[archetype].fighterWeeks += 1;
    if (fighter.attributes.physicalFatigue >= MASSIVE_OVERHEAT_FATIGUE_THRESHOLD) {
      wp.byArchetype[archetype].overheatWeeks += 1;
    }

    wp.physicalFatigueSum += fighter.attributes.physicalFatigue;
    wp.mentalFatigueSum += fighter.attributes.mentalFatigue;
    wp.fatigueSamples += 1;
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
    spawnFighter(playerState, stats, rng, nextFighterId);
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

  const stats = createStatsAccumulator();
  const nextFighterId = createFighterIdSequencer();
  const actualRosterSize = ensureRosterCapacity(playerState, rosterSize);
  for (let i = 0; i < actualRosterSize; i += 1) {
    spawnFighter(playerState, stats, rng, nextFighterId);
  }
  seedRivalGyms(worldState, rng);

  const combatEngine = new CombatEngine({ playerState, worldState, rng });
  const engines = createReactiveEngines();
  attachReactiveEngines(engines, playerState, worldState);

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

      assignWeeklyPlan(playerState, worldState, rng);
      const weeklyPlanReport = processWeeklyPlan(playerState, worldState, { rng });
      recordWeeklyPlanningTelemetry(stats, playerState, weeklyPlanReport);

      const dramaReport = processWeeklyDrama(playerState, worldState, { rng });
      recordDramaTelemetry(stats, dramaReport);
      narrativeBeatsThisWeek += dramaReport.events.length;

      const summary = advanceWeek(gameState, { rng });

      for (const injury of summary.trainingReport.injuries) recordInjury(stats, injury, 'TRAINING');
      for (const injury of weeklyPlanReport.injuries) recordInjury(stats, injury, 'SPARRING_SESSION');
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

/**
 * Turns the raw combat-metrics sums (see emptyCombatMetricsAccumulator) into
 * report-ready rates. Two are deliberately named as "opportunity"/"defense"
 * rather than "success" — CombatEngine doesn't model a takedown *contest*
 * (no defense roll) or a counter-attack *resolution* (no counter-damage
 * roll) yet, only the raw signals (see CombatEngine's
 * _recordFighterCombatMetrics) — so reporting a fabricated success rate for
 * either would overstate what's actually simulated today.
 */
function finalizeCombatMetrics(combat) {
  const totalRounds = combat.standingRounds + combat.clinchRounds + combat.groundRounds;
  return {
    fightsWithMetrics: combat.fightsWithMetrics,
    takedownAttempts: combat.takedownAttempts,
    takedownSuccess: combat.takedownSuccess,
    takedownDefended: combat.takedownDefended,
    takedownSuccessRate: combat.takedownAttempts > 0 ? combat.takedownSuccess / combat.takedownAttempts : null,
    takedownDefenseRate: combat.takedownAttempts > 0 ? combat.takedownDefended / combat.takedownAttempts : null,
    standingRounds: combat.standingRounds,
    clinchRounds: combat.clinchRounds,
    groundRounds: combat.groundRounds,
    totalRounds,
    standingTimeShare: totalRounds > 0 ? combat.standingRounds / totalRounds : null,
    clinchTimeShare: totalRounds > 0 ? combat.clinchRounds / totalRounds : null,
    groundTimeShare: totalRounds > 0 ? combat.groundRounds / totalRounds : null,
    avgStandingDamagePerRound: combat.standingRounds > 0 ? combat.standingDamageDealt / combat.standingRounds : null,
    avgGroundDamagePerRound: combat.groundRounds > 0 ? combat.groundDamageDealt / combat.groundRounds : null,
    submissionAttempts: combat.submissionAttempts,
    submissionSuccess: combat.submissionSuccess,
    submissionSuccessRate: combat.submissionAttempts > 0 ? combat.submissionSuccess / combat.submissionAttempts : null,
    countersTriggered: combat.countersTriggered,
    counterOpportunityRate: combat.submissionAttempts > 0 ? combat.countersTriggered / combat.submissionAttempts : null,
    judgePointsFromDamage: combat.judgePointsFromDamage,
    judgePointsFromGroundControl: combat.judgePointsFromGroundControl,
    avgJudgePointsGapPerFight:
      combat.fightsWithMetrics > 0
        ? (combat.judgePointsFromGroundControl - combat.judgePointsFromDamage) / combat.fightsWithMetrics
        : null,
    decisionFights: combat.decisionFights,
    groundDominantDecisionFights: combat.groundDominantDecisionFights,
    groundDominantWinRate:
      combat.groundDominantDecisionFights > 0 ? combat.groundDominantWins / combat.groundDominantDecisionFights : null,
    actionMetrics: finalizeActionMetrics(combat.actionMetrics),
    tempoMetrics: finalizeTempoMetrics(combat.tempoMetrics),
  };
}

function finalizeActivityUsage(activityUsageCount, totalSlotsResolved) {
  const usage = {};
  for (const [key, count] of Object.entries(activityUsageCount)) {
    usage[key] = { count, share: totalSlotsResolved > 0 ? count / totalSlotsResolved : null };
  }
  return usage;
}

/**
 * Phase 3.1 v1/v2 telemetry: Training Diversity Index (per-activity usage
 * share — "verifier qu'aucun choix ne depasse 50%"), Average Readiness on
 * fight day, Mental vs Physical Fatigue, Archetype Activity Distribution
 * ("aucun archetype ne depasse 60% d'utilisation sur une seule activite" —
 * per-archetype version of the same idea), and a Decision Quality Index
 * blending gym-wide solvency with how often each archetype ran a fighter
 * into massive Physical Fatigue overheat (MASSIVE_OVERHEAT_FATIGUE_THRESHOLD)
 * — this implementation's own operationalization of the spec's qualitative
 * "plusieurs strategies... viables sans faillite ni surmenage massif" goal,
 * documented here rather than asserted as an official game-design formula.
 */
function finalizeWeeklyPlanning(wp, insolvencyRate) {
  const activityUsage = finalizeActivityUsage(wp.activityUsageCount, wp.totalSlotsResolved);
  const maxActivityShare = Math.max(...Object.values(activityUsage).map((a) => a.share ?? 0));

  const byArchetype = {};
  let totalFighterWeeks = 0;
  let totalOverheatWeeks = 0;
  let maxArchetypeActivityShare = 0;
  for (const [archetype, bucket] of Object.entries(wp.byArchetype)) {
    const archetypeSlotsResolved = Object.values(bucket.activityUsageCount).reduce((sum, c) => sum + c, 0);
    const archetypeActivityUsage = finalizeActivityUsage(bucket.activityUsageCount, archetypeSlotsResolved);
    const archetypeMaxActivityShare = Math.max(...Object.values(archetypeActivityUsage).map((a) => a.share ?? 0));
    maxArchetypeActivityShare = Math.max(maxArchetypeActivityShare, archetypeMaxActivityShare);

    byArchetype[archetype] = {
      fighterWeeks: bucket.fighterWeeks,
      overheatWeeks: bucket.overheatWeeks,
      overheatRate: bucket.fighterWeeks > 0 ? bucket.overheatWeeks / bucket.fighterWeeks : null,
      activityUsage: archetypeActivityUsage,
      maxActivityShare: archetypeMaxActivityShare,
    };
    totalFighterWeeks += bucket.fighterWeeks;
    totalOverheatWeeks += bucket.overheatWeeks;
  }
  const overallOverheatRate = totalFighterWeeks > 0 ? totalOverheatWeeks / totalFighterWeeks : null;

  const solvencyScore = insolvencyRate !== null ? clamp01(1 - insolvencyRate) * 100 : null;
  const noMassiveOverheatScore = overallOverheatRate !== null ? clamp01(1 - overallOverheatRate) * 100 : null;
  const decisionQualityIndex =
    solvencyScore !== null && noMassiveOverheatScore !== null
      ? Math.round((solvencyScore + noMassiveOverheatScore) / 2)
      : null;

  return {
    activityUsage,
    totalSlotsResolved: wp.totalSlotsResolved,
    maxActivityShare,
    averageReadinessOnFightDay:
      wp.readinessOnFightDaySamples > 0 ? wp.readinessOnFightDaySum / wp.readinessOnFightDaySamples : null,
    averagePhysicalFatigue: wp.fatigueSamples > 0 ? wp.physicalFatigueSum / wp.fatigueSamples : null,
    averageMentalFatigue: wp.fatigueSamples > 0 ? wp.mentalFatigueSum / wp.fatigueSamples : null,
    byArchetype,
    maxArchetypeActivityShare,
    overallOverheatRate,
    decisionQualityIndex,
  };
}

/**
 * Turns raw actionMetrics sums into per-attempt rates — "EV" here means
 * average judge-score points generated per attempt, the one currency both
 * damage-based and control-based actions are ultimately converted into (see
 * CombatEngine's _computeScoreBreakdown). SUBMISSION_ATTEMPT is a deliberate
 * subset of TAKEDOWN's rounds (both fire on every GROUND round) — don't sum
 * bucket totals together expecting them to add up to a round count.
 *
 * Test A3 adds `failures`/`avgPenaltyOnFailure` for the Risk/Reward Index:
 * only TAKEDOWN and SUBMISSION_ATTEMPT carry a real pass/fail roll (see
 * CombatEngine's _recordFighterCombatMetrics — every other bucket's
 * `success` is hardcoded true, no discrete failure exists to condition on),
 * so `avgPenaltyOnFailure` is null for HEAD_STRIKE/BODY_STRIKE/LEG_STRIKE/CLINCH.
 */
function finalizeActionMetrics(actionMetrics) {
  const result = {};
  for (const [bucketKey, bucket] of Object.entries(actionMetrics)) {
    const failures = bucket.attempts - bucket.successes;
    result[bucketKey] = {
      attempts: bucket.attempts,
      successes: bucket.successes,
      failures,
      successRate: bucket.attempts > 0 ? bucket.successes / bucket.attempts : null,
      avgDamage: bucket.attempts > 0 ? bucket.totalDamage / bucket.attempts : null,
      avgScorePoints: bucket.attempts > 0 ? bucket.totalScorePoints / bucket.attempts : null,
      controlRate: bucket.attempts > 0 ? bucket.totalControlRounds / bucket.attempts : null,
      avgDamageOnSuccess: bucket.successes > 0 ? bucket.totalDamage / bucket.successes : null,
      avgScorePointsOnSuccess: bucket.successes > 0 ? bucket.totalScorePoints / bucket.successes : null,
      controlRateOnSuccess: bucket.successes > 0 ? bucket.totalControlRounds / bucket.successes : null,
      avgDamageTakenOnFailure: failures > 0 ? bucket.totalDamageTaken / failures : null,
      avgStaminaPenaltyOnFailure: failures > 0 ? bucket.totalStaminaPenalty / failures : null,
      avgMomentumPenaltyOnFailure: failures > 0 ? bucket.totalMomentumPenalty / failures : null,
    };
  }
  return result;
}

/** Tempo ("aggressiveness") payoff: average damage/score per round for each tempo choice — see the tempoMetrics doc comment in CombatEngine. */
function finalizeTempoMetrics(tempoMetrics) {
  const result = {};
  for (const [tempoKey, bucket] of Object.entries(tempoMetrics)) {
    result[tempoKey] = {
      rounds: bucket.rounds,
      avgDamage: bucket.rounds > 0 ? bucket.totalDamage / bucket.rounds : null,
      avgScorePoints: bucket.rounds > 0 ? bucket.totalScorePoints / bucket.rounds : null,
    };
  }
  return result;
}

function finalizeStyleMatchups(matrix) {
  const result = {};
  for (const rowStyle of Object.keys(matrix)) {
    result[rowStyle] = {};
    for (const colStyle of Object.keys(matrix[rowStyle])) {
      const cell = matrix[rowStyle][colStyle];
      result[rowStyle][colStyle] = { wins: cell.wins, losses: cell.losses, draws: cell.draws, winRate: winRate(cell) };
    }
  }
  return result;
}

/** Win Condition Report: for each style, its wins broken down by finish method. */
function finalizeStyleWinMethods(styleWinMethods, styles) {
  const result = {};
  for (const [style, methods] of Object.entries(styleWinMethods)) {
    const totalWins = styles[style].wins;
    const byMethod = {};
    for (const [method, count] of Object.entries(methods)) {
      byMethod[method] = { count, share: totalWins > 0 ? count / totalWins : null };
    }
    result[style] = { totalWins, byMethod };
  }
  return result;
}

/** Style Identity Score per style: average fidelity (0-100) across every fighter-appearance sampled — see CombatEngine's _computeStyleIdentityScore. */
function finalizeStyleIdentity(styleIdentity) {
  const result = {};
  for (const [style, bucket] of Object.entries(styleIdentity)) {
    result[style] = bucket.samples > 0 ? bucket.totalScore / bucket.samples : null;
  }
  return result;
}

/**
 * Normalized Shannon entropy (0-100) of a set of non-negative counts: 100
 * means every bucket carries an equal share (maximal diversity), 0 means a
 * single bucket accounts for everything. Used both as the standalone
 * DIVERSITY INDEX and as one input to the Meta Health Index.
 * @param {number[]} counts
 * @returns {number|null}
 */
function computeDiversityIndex(counts) {
  const total = counts.reduce((sum, v) => sum + v, 0);
  const bucketCount = counts.length;
  if (total <= 0 || bucketCount <= 1) return total > 0 ? 100 : null;

  const entropy = counts.reduce((sum, count) => {
    if (count <= 0) return sum;
    const share = count / total;
    return sum - share * Math.log(share);
  }, 0);
  const maxEntropy = Math.log(bucketCount);
  return Math.round((entropy / maxEntropy) * 100);
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

/**
 * How far, on average, each style's winrate sits from a perfectly balanced
 * 50% — 100 means every style hovers at exactly 50%, 0 means every style
 * sits at the extreme (100% or 0%).
 */
function computeBalanceScore(styles) {
  const rates = Object.values(styles)
    .map((bucket) => winRate(bucket))
    .filter((rate) => rate !== null);
  if (rates.length === 0) return null;

  const avgDeviation = average(rates.map((rate) => Math.abs(rate - 0.5)));
  return Math.round(clamp01(1 - avgDeviation * 2) * 100);
}

/**
 * Meta Health Index (0-100): an equally-weighted average of four already-
 * independently-reported sub-scores — diversity (style representation
 * evenness), balance (how close every style's winrate sits to 50%),
 * financial health (the inverse of the insolvency rate), and fun (the
 * inverse of the dull-week rate). Deliberately simple and auditable (equal
 * weights, every component shown on its own in the report) rather than a
 * tuned/opaque formula — this is a diagnostic tool, not a scoring gate.
 */
function computeMetaHealthIndex({ diversityScore, balanceScore, financialHealthScore, funScore }) {
  const components = [diversityScore, balanceScore, financialHealthScore, funScore].filter((v) => v !== null);
  if (components.length === 0) return null;
  return Math.round(average(components));
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

  /** Combined record across every GROUND-affinity style (see GRAPPLING_STYLE_KEYS) — used by BalanceReporter's Version History Tracker to isolate the effect of judge-scoring changes on grappling as a whole. */
  const grapplingBucket = GRAPPLING_STYLE_KEYS.reduce(
    (acc, style) => {
      const bucket = stats.styles[style];
      acc.wins += bucket.wins;
      acc.losses += bucket.losses;
      acc.draws += bucket.draws;
      return acc;
    },
    { wins: 0, losses: 0, draws: 0 }
  );
  const grappling = {
    styles: GRAPPLING_STYLE_KEYS,
    wins: grapplingBucket.wins,
    losses: grapplingBucket.losses,
    draws: grapplingBucket.draws,
    winRate: winRate(grapplingBucket),
  };

  const bySeverity = Object.fromEntries(
    Object.entries(stats.health.bySeverity).map(([severity, bucket]) => [
      severity,
      { count: bucket.count, avgRecoveryDays: bucket.count > 0 ? bucket.totalRecoveryDays / bucket.count : null },
    ])
  );

  const econ = stats.economy;
  const insolvencyRate = econ.weeksSimulated > 0 ? econ.insolvencyWeeks / econ.weeksSimulated : null;
  const dullWeekRate = stats.fun.totalWeeks > 0 ? stats.fun.dullWeeks / stats.fun.totalWeeks : null;

  const totalFightersGenerated = Object.values(stats.fighterCountsByStyle).reduce((sum, v) => sum + v, 0);
  const diversity = {
    byStyle: Object.fromEntries(
      Object.entries(stats.fighterCountsByStyle).map(([style, count]) => [
        style,
        { count, share: totalFightersGenerated > 0 ? count / totalFightersGenerated : null },
      ])
    ),
    diversityIndex: computeDiversityIndex(Object.values(stats.fighterCountsByStyle)),
  };

  const balanceScore = computeBalanceScore(styles);
  const financialHealthScore = insolvencyRate !== null ? Math.round(clamp01(1 - insolvencyRate) * 100) : null;
  const funScore = dullWeekRate !== null ? Math.round(clamp01(1 - dullWeekRate) * 100) : null;
  const metaHealth = {
    diversityScore: diversity.diversityIndex,
    balanceScore,
    financialHealthScore,
    funScore,
    overallIndex: computeMetaHealthIndex({
      diversityScore: diversity.diversityIndex,
      balanceScore,
      financialHealthScore,
      funScore,
    }),
  };

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
      insolvencyRate,
    },
    archetypes,
    styles,
    grappling,
    styleMatchups: finalizeStyleMatchups(stats.styleMatchups),
    styleWinMethods: finalizeStyleWinMethods(stats.styleWinMethods, styles),
    styleIdentity: finalizeStyleIdentity(stats.styleIdentity),
    diversity,
    combat: finalizeCombatMetrics(stats.combat),
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
      dullWeekRate,
    },
    narrative: stats.narrative,
    metaHealth,
    weeklyPlanning: finalizeWeeklyPlanning(stats.weeklyPlanning, insolvencyRate),
    drama: finalizeDrama(stats.drama),
    weeklyMetrics: stats.weeklyMetrics,
    seasonalMetrics: stats.seasonalMetrics,
  };
}

/**
 * Phase 3.2 telemetry: average events resolved per week (verifies the
 * "0.8 a 1.2" target), and per-event Event Choice Distribution — each
 * choice's share of that event's own total resolutions, plus the run-wide
 * max share across every event (for the ">= 70%" alert threshold).
 */
function finalizeDrama(drama) {
  const byEvent = {};
  let maxChoiceShare = 0;
  for (const [eventId, bucket] of Object.entries(drama.byEvent)) {
    const choices = {};
    for (const [choiceId, count] of Object.entries(bucket.choiceCounts)) {
      const share = bucket.totalCount > 0 ? count / bucket.totalCount : null;
      choices[choiceId] = { count, share };
      if (share !== null) maxChoiceShare = Math.max(maxChoiceShare, share);
    }
    byEvent[eventId] = { category: bucket.category, totalCount: bucket.totalCount, choices };
  }

  return {
    totalEventsResolved: drama.totalEventsResolved,
    weeksSimulated: drama.weeksSimulated,
    averageEventsPerWeek: drama.weeksSimulated > 0 ? drama.totalEventsResolved / drama.weeksSimulated : null,
    byEvent,
    maxChoiceShare,
  };
}

export { SIM_DEFAULTS };
