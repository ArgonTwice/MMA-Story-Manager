/**
 * engine/StoryAnalyzer.js — Phase V2.6 ("Story Analyzer & Gala de Fin de Saison")
 * ---------------------------------------------------------------------------
 * Compiles a season's worth of already-recorded data — CombatEngine fight
 * results (the same fightResultsThisYear window ui/SeasonSummary.js already
 * consumes), WorldState's relationship graph and rival gyms, and
 * Fighter#career (seasonHistory) — into up to 5 end-of-season trophies,
 * meant to be shown at Week 52 just before the SeasonSummary.
 *
 * Pure analysis, same discipline as ui/SeasonSummary.js/ui/GymHub.js: this
 * module only READS State/Models and returns a structured result — it
 * never mutates anything itself. The caller (web/app.js) decides whether/
 * how to persist the awards (Fighter#addTrophy/PlayerState#awardCoachTrophy).
 *
 * Every trophy is honest-or-null: if the season's real data doesn't support
 * declaring a winner (no fights, no coaches, no rating snapshot to diff
 * against), the corresponding trophy is null rather than fabricated — see
 * each finder function's own header for exactly what it needs and why some
 * seasons simply won't produce every trophy.
 * ---------------------------------------------------------------------------
 */

/** The 5 trophy categories this module can award. */
export const TROPHY_CATEGORIES = Object.freeze({
  RIVALRY_OF_THE_YEAR: 'RIVALRY_OF_THE_YEAR',
  UPSET_OF_THE_YEAR: 'UPSET_OF_THE_YEAR',
  FINISHER_KING: 'FINISHER_KING',
  COACH_OF_THE_YEAR: 'COACH_OF_THE_YEAR',
  GYM_OF_THE_YEAR: 'GYM_OF_THE_YEAR',
});

/** Display labels, French, matching the spec's own trophy names. */
export const TROPHY_LABELS = Object.freeze({
  [TROPHY_CATEGORIES.RIVALRY_OF_THE_YEAR]: "Rivalite de l'Annee",
  [TROPHY_CATEGORIES.UPSET_OF_THE_YEAR]: "Upset de l'Annee",
  [TROPHY_CATEGORIES.FINISHER_KING]: 'Roi de la Finition',
  [TROPHY_CATEGORIES.COACH_OF_THE_YEAR]: "Coach de l'Annee",
  [TROPHY_CATEGORIES.GYM_OF_THE_YEAR]: "Gym de l'Annee",
});

/**
 * "Rivalite de l'Annee": among this year's fights, the pair with the
 * highest current tension gauge on WorldState's relationship graph (see
 * state/WorldState.js#upsertRelationship / engine/RelationshipEngine.js,
 * which raises tension on every combat:finished between two entities).
 * Null if no fight this year has a tracked relationship at all.
 */
function findRivalryOfTheYear({ worldState, fightResultsThisYear }) {
  let best = null;
  for (const fight of fightResultsThisYear) {
    const fighterAId = fight.fighters?.A;
    const fighterBId = fight.fighters?.B;
    if (!fighterAId || !fighterBId) continue;

    const relationship = worldState.getRelationship(fighterAId, fighterBId);
    if (!relationship) continue;

    const tension = relationship.gauges.tension;
    if (!best || tension > best.tension) {
      best = { fight, tension };
    }
  }
  if (!best) return null;

  return {
    category: TROPHY_CATEGORIES.RIVALRY_OF_THE_YEAR,
    label: TROPHY_LABELS[TROPHY_CATEGORIES.RIVALRY_OF_THE_YEAR],
    fighterAId: best.fight.fighters.A,
    fighterBId: best.fight.fighters.B,
    fighterAName: best.fight.names?.A ?? best.fight.fighters.A,
    fighterBName: best.fight.names?.B ?? best.fight.fighters.B,
    tension: Math.round(best.tension),
    method: best.fight.method,
    winnerName: best.fight.winner ? best.fight.names?.[best.fight.winner] ?? null : null,
  };
}

/**
 * "Upset de l'Annee": the win with the largest CombatEngine#preFightRatings
 * gap in the underdog's favor (loser's pre-fight rating minus winner's).
 * Draws never qualify. Null if no fight this year carries preFightRatings
 * (older saves/results predating this field) or no fight was actually an
 * upset (winner's rating >= loser's rating every time).
 */
function findUpsetOfTheYear({ fightResultsThisYear }) {
  let best = null;
  for (const fight of fightResultsThisYear) {
    if (fight.winner === null || fight.winner === undefined) continue;
    if (!fight.preFightRatings) continue;

    const winnerKey = fight.winner;
    const loserKey = winnerKey === 'A' ? 'B' : 'A';
    const winnerRating = fight.preFightRatings[winnerKey];
    const loserRating = fight.preFightRatings[loserKey];
    if (typeof winnerRating !== 'number' || typeof loserRating !== 'number') continue;

    const gap = loserRating - winnerRating;
    if (gap <= 0) continue;
    if (!best || gap > best.gap) {
      best = { fight, gap, winnerKey, loserKey };
    }
  }
  if (!best) return null;

  return {
    category: TROPHY_CATEGORIES.UPSET_OF_THE_YEAR,
    label: TROPHY_LABELS[TROPHY_CATEGORIES.UPSET_OF_THE_YEAR],
    fighterId: best.fight.fighters[best.winnerKey],
    fighterName: best.fight.names?.[best.winnerKey] ?? best.fight.fighters[best.winnerKey],
    opponentId: best.fight.fighters[best.loserKey],
    opponentName: best.fight.names?.[best.loserKey] ?? best.fight.fighters[best.loserKey],
    ratingGap: Math.round(best.gap * 10) / 10,
    method: best.fight.method,
  };
}

/**
 * "Roi de la Finition": the active roster fighter with the most finishes
 * (KOs + Submissions) THIS year, read straight off Fighter#career.seasonHistory
 * (see Fighter#recordFightResult's seasonContext param). Only considers
 * fighters still on the roster — a fighter released/retired mid-year drops
 * out of contention, a known, accepted simplification (their seasonHistory
 * row isn't queryable once they've left playerState.roster).
 */
function findFinisherKing({ playerState, year }) {
  let best = null;
  for (const fighter of playerState.roster) {
    const finishesThisYear = fighter.career.seasonHistory
      .filter((row) => row.year === year)
      .reduce((sum, row) => sum + row.koWins + row.subWins, 0);
    if (finishesThisYear <= 0) continue;
    if (!best || finishesThisYear > best.finishes) {
      const koWins = fighter.career.seasonHistory.filter((row) => row.year === year).reduce((sum, row) => sum + row.koWins, 0);
      const subWins = fighter.career.seasonHistory.filter((row) => row.year === year).reduce((sum, row) => sum + row.subWins, 0);
      best = { fighter, finishes: finishesThisYear, koWins, subWins };
    }
  }
  if (!best) return null;

  return {
    category: TROPHY_CATEGORIES.FINISHER_KING,
    label: TROPHY_LABELS[TROPHY_CATEGORIES.FINISHER_KING],
    fighterId: best.fighter.identity.id,
    fighterName: best.fighter.identity.name,
    finishes: best.finishes,
    koWins: best.koWins,
    subWins: best.subWins,
  };
}

/**
 * "Coach de l'Annee": there's no per-coach training attribution in this
 * codebase (engine/TrainingEngine.js#computeCoachMultiplier applies the
 * single BEST-matching coach's bonus to every fighter's training uniformly
 * — see its own header), so true causal "this coach grew this fighter"
 * data doesn't exist. This trophy instead credits the team's real
 * aggregate progression this year (sum of each roster fighter's
 * getOverallRating() delta since yearStartRosterRatings, a snapshot the
 * caller must supply — see web/app.js) to the gym's single highest-skill
 * coach, as a transparent simplification rather than fabricated per-coach
 * causality. Null with no coaches on staff, or no rating snapshot supplied.
 */
function findCoachOfTheYear({ playerState, yearStartRosterRatings }) {
  if (!playerState.coaches || playerState.coaches.length === 0) return null;
  if (!yearStartRosterRatings) return null;

  let teamProgression = 0;
  let fightersTracked = 0;
  for (const fighter of playerState.roster) {
    const startRating = yearStartRosterRatings[fighter.identity.id];
    if (typeof startRating !== 'number') continue;
    teamProgression += fighter.getOverallRating() - startRating;
    fightersTracked += 1;
  }
  if (fightersTracked === 0) return null;

  const bestCoach = [...playerState.coaches].sort((a, b) => (b.skill ?? 0) - (a.skill ?? 0))[0];

  return {
    category: TROPHY_CATEGORIES.COACH_OF_THE_YEAR,
    label: TROPHY_LABELS[TROPHY_CATEGORIES.COACH_OF_THE_YEAR],
    coachId: bestCoach.id,
    coachName: bestCoach.name ?? bestCoach.id,
    teamProgression: Math.round(teamProgression * 10) / 10,
    fightersTracked,
  };
}

/**
 * "Gym de l'Annee": compares the player's gym against every rival gym on
 * the ONE axis both sides genuinely track — Reputation (worldState.rivalGyms
 * only carries a drifting reputation/activity pair, see
 * engine/ProgressionEngine.js#processRivalGyms; it has no real win/loss
 * ledger to compare fairly). Wins this year are reported alongside as
 * player-gym color, never used to inflate the comparison against rivals
 * who don't have an equivalent figure — so a rival CAN genuinely win this
 * trophy if their reputation outpaces the player's. Null if there is
 * nothing at all to compare (should not happen: the player's own gym is
 * always a candidate).
 */
function findGymOfTheYear({ playerState, worldState, fightResultsThisYear }) {
  const candidates = [
    { id: 'PLAYER_GYM', name: playerState.gymName, reputation: playerState.reputation, isPlayerGym: true },
    ...worldState.rivalGyms.map((gym) => ({ id: gym.id, name: gym.name ?? gym.id, reputation: gym.reputation ?? 0, isPlayerGym: false })),
  ];
  if (candidates.length === 0) return null;

  const best = candidates.reduce((leader, candidate) => (candidate.reputation > leader.reputation ? candidate : leader));
  const playerWinsThisYear = fightResultsThisYear.filter((fight) => fight.winner !== null && fight.winner !== undefined).length;

  return {
    category: TROPHY_CATEGORIES.GYM_OF_THE_YEAR,
    label: TROPHY_LABELS[TROPHY_CATEGORIES.GYM_OF_THE_YEAR],
    gymId: best.id,
    gymName: best.name,
    reputation: Math.round(best.reputation),
    isPlayerGym: best.isPlayerGym,
    playerWinsThisYear,
  };
}

/**
 * @param {Object} options
 * @param {Object} options.playerState - A PlayerState instance.
 * @param {Object} options.worldState - A WorldState instance.
 * @param {number} options.year - The year being recapped (the season that
 *   JUST ended — since WorldState.year has typically already rolled over
 *   to the new year by the time this runs, the caller must pass the year
 *   explicitly rather than this module inferring it, exactly like
 *   ui/SeasonSummary.js accepts startDay/startMoney explicitly).
 * @param {Object[]} [options.fightResultsThisYear] - Every CombatEngine
 *   result fought during that year (same window ui/SeasonSummary.js#build
 *   consumes as `fightResults`).
 * @param {Object<string, number>|null} [options.yearStartRosterRatings] -
 *   { [fighterId]: getOverallRating() } snapshot taken at the start of the
 *   year, for the Coach of the Year trophy. Null skips that trophy.
 * @returns {{ year: number, rivalryOfTheYear: Object|null, upsetOfTheYear: Object|null, finisherKing: Object|null, coachOfTheYear: Object|null, gymOfTheYear: Object|null }}
 */
export function analyzeSeason({ playerState, worldState, year, fightResultsThisYear = [], yearStartRosterRatings = null }) {
  return {
    year,
    rivalryOfTheYear: findRivalryOfTheYear({ worldState, fightResultsThisYear }),
    upsetOfTheYear: findUpsetOfTheYear({ fightResultsThisYear }),
    finisherKing: findFinisherKing({ playerState, year }),
    coachOfTheYear: findCoachOfTheYear({ playerState, yearStartRosterRatings }),
    gymOfTheYear: findGymOfTheYear({ playerState, worldState, fightResultsThisYear }),
  };
}

/**
 * @param {Object} analysis - An analyzeSeason() result.
 * @returns {boolean} True if at least one trophy was awarded — the caller
 *   (web/app.js) uses this to decide whether the Gala ceremony is worth
 *   showing at all this year.
 */
export function hasAnyTrophy(analysis) {
  return Boolean(
    analysis.rivalryOfTheYear || analysis.upsetOfTheYear || analysis.finisherKing || analysis.coachOfTheYear || analysis.gymOfTheYear
  );
}

export default { TROPHY_CATEGORIES, TROPHY_LABELS, analyzeSeason, hasAnyTrophy };
