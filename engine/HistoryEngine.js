/**
 * engine/HistoryEngine.js — Phase 4.2 ("Memoire du Monde, Legacy Engine &
 * Attachement au Roster")
 * ---------------------------------------------------------------------------
 * Two related but independently-triggered responsibilities:
 *
 *   1. World records (reactive, class HistoryEngine below): on every
 *      'combat:finished', checks whether this fight set a new
 *      youngestChampion or longestWinStreak world record (see
 *      WorldState#defaultRecords/trySetRecord). Same decoupled shape as the
 *      pre-existing engine/WorldMemory.js (fastestKO/biggestFight/
 *      longestTitleReign/mostTitles) — imports only core/EventBus.js and
 *      data/balance.js, and reads every fact it needs straight off the
 *      'combat:finished' payload (ages/winStreaks/careerTitlesCount), never
 *      a PlayerState/roster lookup.
 *
 *   2. Hall of Fame induction (pure functions below, NOT event-reactive):
 *      eligibility is a career-resume bar checked at the exact moment a
 *      fighter retires, which has no corresponding EventBus event today —
 *      engine/LegacyEngine.js#processRetirement calls
 *      evaluateHallOfFameEligibility()/induct() directly, synchronously,
 *      as the first step of resolving a retirement.
 * ---------------------------------------------------------------------------
 */

import EventBus from '../core/EventBus.js';
import BALANCE from '../data/balance.js';

class HistoryEngine {
  /**
   * @param {Object} [options]
   * @param {Object|null} [options.worldState] - A WorldState instance. Can
   *   also be supplied later via attach().
   */
  constructor(options = {}) {
    this.worldState = options.worldState ?? null;
    this._unsubs = [];
  }

  /**
   * @param {Object} [worldState] - Rebinds the target WorldState if provided.
   * @returns {HistoryEngine} this, for chaining.
   */
  attach(worldState) {
    if (worldState) this.worldState = worldState;
    this._unsubs.push(EventBus.subscribe('combat:finished', (payload) => this._onCombatFinished(payload)));
    return this;
  }

  /** Unsubscribes from every event this engine listens to. */
  detach() {
    this._unsubs.forEach((unsubscribe) => unsubscribe());
    this._unsubs = [];
  }

  // ---- event handler ------------------------------------------------------

  _onCombatFinished(payload) {
    if (!this.worldState) return;

    this._checkLongestWinStreak(payload);
    this._checkYoungestChampion(payload);
  }

  // ---- record checks --------------------------------------------------------

  _checkLongestWinStreak(payload) {
    if (payload.winner === null) return;

    const winnerKey = payload.winner;
    const streak = payload.winStreaks?.[winnerKey];
    if (typeof streak !== 'number') return;

    const winnerName = payload.names?.[winnerKey] ?? payload.fighters[winnerKey];

    this.worldState.trySetRecord('longestWinStreak', streak, {
      betterIf: 'HIGHER',
      detail: `${winnerName} porte sa serie de victoires a ${streak}.`,
      meta: { fighterId: payload.fighters[winnerKey] },
    });
  }

  _checkYoungestChampion(payload) {
    if (!payload.titleOnTheLine || payload.winner === null) return;

    const winnerKey = payload.winner;
    // Only a fighter's FIRST title counts — careerTitlesCount is already
    // post-fight (see CombatEngine#_processPostMatchRewards), so ===1 means
    // this exact win was the one that captured it.
    if (payload.careerTitlesCount?.[winnerKey] !== 1) return;

    const age = payload.ages?.[winnerKey];
    if (typeof age !== 'number') return;

    const winnerName = payload.names?.[winnerKey] ?? payload.fighters[winnerKey];
    const weightClass = payload.weightClasses?.[winnerKey] ?? 'Inconnu';

    this.worldState.trySetRecord('youngestChampion', age, {
      betterIf: 'LOWER',
      detail: `${winnerName} devient champion ${weightClass} a ${age} ans.`,
      meta: { fighterId: payload.fighters[winnerKey] },
    });
  }
}

const instance = new HistoryEngine();
export default instance;
export { HistoryEngine };

// ---- Hall of Fame induction (retirement-triggered, not event-reactive) ------

/**
 * Career resume bar for Hall of Fame induction (see BALANCE.LEGACY_ENGINE's
 * own doc comment for why this is win-record-based rather than
 * title-based). Pure function — no RNG, no mutation.
 *
 * @param {Object} fighter - A Fighter instance (or anything shaped like one).
 * @returns {boolean}
 */
export function evaluateHallOfFameEligibility(fighter) {
  const cfg = BALANCE.LEGACY_ENGINE;
  const { wins, losses, draws } = fighter.career;
  const total = wins + losses + draws;
  if (total === 0) return false;
  const winRate = wins / total;
  return wins >= cfg.HALL_OF_FAME_MIN_WINS && winRate >= cfg.HALL_OF_FAME_MIN_WIN_RATE;
}

/**
 * Finds this fighter's most significant historical rivalry from
 * WorldState.relationships — the pair involving fighterId with the highest
 * `tension` gauge, the same signal engine/StoryEngine.js already reads to
 * detect rivalry-worthy conflict (see its _detectRivalryIgnited/tension
 * usage). Best-effort only: returns null if the fighter has no tracked
 * relationships at all.
 *
 * @param {string} fighterId
 * @param {Object} worldState
 * @param {Object|null} [playerState] - Optional, used only to resolve the
 *   rival's current display name if they're still on the roster.
 * @returns {Object|null}
 */
function findBiggestRival(fighterId, worldState, playerState) {
  let best = null;
  let bestOpponentId = null;

  for (const record of Object.values(worldState.relationships)) {
    if (record.entityA !== fighterId && record.entityB !== fighterId) continue;
    if (!best || record.gauges.tension > best.gauges.tension) {
      best = record;
      bestOpponentId = record.entityA === fighterId ? record.entityB : record.entityA;
    }
  }

  if (!best) return null;

  const rivalFighter = playerState?.getFighter?.(bestOpponentId);
  return {
    fighterId: bestOpponentId,
    fighterName: rivalFighter?.identity.name ?? bestOpponentId,
    tension: best.gauges.tension,
    relation: best.gauges.relation,
  };
}

/**
 * Immortalizes a retiring fighter in WorldState.hallOfFame and flips
 * career.hallOfFameStatus to 'inducted'. Caller (engine/LegacyEngine.js)
 * is responsible for having already checked evaluateHallOfFameEligibility().
 *
 * @param {Object} fighter - A Fighter instance.
 * @param {Object} worldState
 * @param {Object|null} [playerState] - Optional, only used for the
 *   biggest-rival name lookup (see findBiggestRival).
 * @returns {Object} The stored Hall of Fame entry.
 */
export function induct(fighter, worldState, playerState = null) {
  fighter.career.hallOfFameStatus = 'inducted';

  const entry = worldState.addHallOfFameEntry({
    fighterId: fighter.identity.id,
    name: fighter.identity.name,
    nickname: fighter.identity.nickname,
    style: fighter.identity.style,
    archetype: fighter.psychology.personality.archetype,
    retiredAtAge: fighter.identity.age,
    record: `${fighter.career.wins}-${fighter.career.losses}-${fighter.career.draws}`,
    wins: fighter.career.wins,
    losses: fighter.career.losses,
    draws: fighter.career.draws,
    finishes: fighter.career.finishes,
    titles: [...fighter.career.titles],
    longestWinStreak: fighter.career.longestWinStreak,
    biggestRival: findBiggestRival(fighter.identity.id, worldState, playerState),
  });

  return entry;
}
