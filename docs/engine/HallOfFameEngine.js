/**
 * engine/HallOfFameEngine.js
 * ---------------------------------------------------------------------------
 * The 20-badge achievement catalog (BALANCE.HALL_OF_FAME_BADGES.CATALOG) and
 * the "Livre d'Or" season-recap generator, layered on top of the
 * PRE-EXISTING Hall of Fame legend registry (engine/HistoryEngine.js's
 * evaluateHallOfFameEligibility/induct, WorldState.hallOfFame — a retired
 * fighter's full bio/palmares/biggest-rival card) — this module never
 * touches that, it only adds badges and the golden book on top.
 *
 * Two unlock mechanisms, split by whether the condition can be observed at
 * any moment or only at the instant of a specific fight:
 *   - THRESHOLD badges (evaluateBadgeUnlocks, pure, called periodically —
 *     see web/app.js's weekly resolution): re-checked every call against
 *     current PlayerState/WorldState; anything already unlocked is skipped.
 *   - REACTIVE badges (the HallOfFameEngine class below, mirroring
 *     engine/SocialEngine.js/HistoryEngine.js's always-on subscriber
 *     pattern): UPSET_DU_SIECLE depends on THIS fight's own pre-fight
 *     rating gap, a fact with no lasting state to re-derive later.
 *
 * Every unlock goes through PlayerState#unlockBadge(), which is itself
 * idempotent (returns false if already owned) — so both mechanisms can run
 * as often as convenient without ever double-unlocking or double-toasting.
 * ---------------------------------------------------------------------------
 */

import EventBus from '../core/EventBus.js';
import BALANCE from '../data/balance.js';
import { COMBAT_EVENTS } from './CombatEngine.js';

/** @returns {Object} BALANCE.HALL_OF_FAME_BADGES.CATALOG[badgeId], or undefined. */
export function getBadgeDefinition(badgeId) {
  return BALANCE.HALL_OF_FAME_BADGES.CATALOG[badgeId];
}

/** @returns {Object[]} Every badge definition in the catalog, in declaration order. */
export function getAllBadgeDefinitions() {
  return Object.values(BALANCE.HALL_OF_FAME_BADGES.CATALOG);
}

// ---- threshold badges (state observable at any moment) ---------------------

/** Each evaluator returns true once its condition holds, given { playerState, worldState }. */
const THRESHOLD_EVALUATORS = Object.freeze({
  PREMIER_SANG: ({ playerState }) => playerState.roster.some((fighter) => fighter.career.finishes >= 1),
  PREMIERE_SIGNATURE: ({ playerState }) => playerState.roster.length >= 1,
  CHAMPION_DU_MONDE: ({ playerState, worldState }) =>
    playerState.roster.some((fighter) => fighter.career.titles.length >= 1) ||
    worldState.hallOfFame.some((entry) => entry.titles?.length >= 1),
  DYNASTIE: ({ playerState }) => playerState.roster.some((fighter) => fighter.career.titles.length >= 3),
  MILLIONNAIRE: ({ playerState }) => playerState.money >= 1_000_000,
  ICONE_MEDIATIQUE: ({ playerState }) => playerState.hype >= BALANCE.GYM.HYPE.MAX,
  RESEAU_ETABLI: ({ playerState }) => playerState.socialFeed.length >= 50,
  EMPIRE_IMMOBILIER: ({ playerState }) => playerState.equipLevel >= BALANCE.GYM.TIERS.length - 1,
  ARSENAL_COMPLET: ({ playerState }) => {
    const ownedIds = new Set(playerState.equipment.map((item) => item.id));
    return Object.keys(BALANCE.EQUIPMENT.DEFINITIONS).every((id) => ownedIds.has(id));
  },
  ELITE_MONDIALE: ({ playerState }) =>
    playerState.leagueTier === BALANCE.LEAGUE_PYRAMID.TIER_ORDER[BALANCE.LEAGUE_PYRAMID.TIER_ORDER.length - 1],
  LEGENDE_VIVANTE: ({ worldState }) => worldState.hallOfFame.length >= 1,
  DYNASTIE_DE_LEGENDES: ({ worldState }) => worldState.hallOfFame.length >= 5,
  PALMARES_DORE: ({ playerState }) => playerState.roster.some((fighter) => fighter.career.trophies.length >= 1),
  REPUTATION_INTERNATIONALE: ({ playerState }) => playerState.reputation >= BALANCE.GYM.MAX_REPUTATION,
  SALLE_COMBLE: ({ playerState }) => playerState.roster.length >= playerState.getRosterCapacity(),
  VENERABLE: ({ playerState }) =>
    playerState.roster.some((fighter) => fighter.identity.age >= BALANCE.AGE.RETIREMENT.FORCED_RETIREMENT_AGE - 2),
  STAFF_COMPLET: ({ playerState }) =>
    Object.keys(BALANCE.STAFF.ROLES).every((roleId) => playerState.coaches.some((coach) => coach.role === roleId)),
  INVAINCU: ({ playerState }) => playerState.roster.some((fighter) => fighter.career.wins >= 10 && fighter.career.losses === 0),
  ROI_DE_LA_FINITION: ({ playerState }) => playerState.roster.some((fighter) => fighter.career.finishes >= 5),
});

/**
 * Re-checks every THRESHOLD badge not yet unlocked, unlocking any that now
 * qualify. Safe to call as often as convenient (weekly, post-fight...) —
 * already-unlocked badges are skipped by PlayerState#unlockBadge() itself.
 *
 * @param {Object} playerState
 * @param {Object} worldState
 * @returns {Object[]} The badge definitions newly unlocked by this call (empty if none).
 */
export function evaluateBadgeUnlocks(playerState, worldState) {
  const unlocked = [];
  const ctx = { playerState, worldState };

  for (const [badgeId, evaluator] of Object.entries(THRESHOLD_EVALUATORS)) {
    if (playerState.unlockedBadges.includes(badgeId)) continue;
    if (!evaluator(ctx)) continue;
    if (playerState.unlockBadge(badgeId)) unlocked.push(getBadgeDefinition(badgeId));
  }

  return unlocked;
}

// ---- Livre d'Or (season recap) ---------------------------------------------

/**
 * Composes one short, deterministic recap sentence for the season just
 * ended, from the same StoryAnalyzer.analyzeSeason() result web/app.js's
 * Gala already computes (rather than re-deriving trophy-worthy facts a
 * second time) plus this year's roster win/loss tally.
 *
 * @param {Object} playerState
 * @param {Object} worldState
 * @param {Object} seasonAnalysis - A StoryAnalyzer#analyzeSeason() result (year, rivalryOfTheYear, upsetOfTheYear, finisherKing, coachOfTheYear, gymOfTheYear).
 * @param {{ wins: number, losses: number, draws: number }} [seasonRecord] - This year's roster-wide fight tally, if known.
 * @returns {{ year: number, text: string }}
 */
export function generateGoldenBookEntry(playerState, worldState, seasonAnalysis, seasonRecord = null) {
  const { year } = seasonAnalysis;
  const gymName = playerState.gymName || 'La salle';

  const highlights = [];
  if (seasonAnalysis.gymOfTheYear) highlights.push('sacree Gym de l\'Annee');
  if (seasonAnalysis.finisherKing) highlights.push(`portee par ${seasonAnalysis.finisherKing.fighterName ?? seasonAnalysis.finisherKing.name ?? 'son roster'}, Roi de la Finition`);
  if (seasonAnalysis.upsetOfTheYear) highlights.push('marquee par un upset retentissant');
  if (seasonAnalysis.rivalryOfTheYear) highlights.push('nourrie par une rivalite intense');

  let text;
  if (highlights.length > 0) {
    text = `An ${year} : ${gymName}, ${highlights.join(', ')}.`;
  } else if (seasonRecord && seasonRecord.wins + seasonRecord.losses + seasonRecord.draws > 0) {
    text = `An ${year} : ${gymName} termine la saison sur un bilan de ${seasonRecord.wins}-${seasonRecord.losses}-${seasonRecord.draws}.`;
  } else {
    text = `An ${year} : ${gymName} poursuit son chemin, une saison tranquille de plus dans le grand livre du sport.`;
  }

  return { year, text };
}

// ---- reactive badges (point-in-time fight events) ---------------------------

class HallOfFameEngine {
  /**
   * @param {Object} [options]
   * @param {Object|null} [options.playerState] - A PlayerState instance. Can also be supplied later via attach().
   */
  constructor(options = {}) {
    this.playerState = options.playerState ?? null;
    this._unsubs = [];
  }

  /**
   * @param {Object} [playerState] - Rebinds the target PlayerState if provided.
   * @returns {HallOfFameEngine} this, for chaining.
   */
  attach(playerState) {
    if (playerState) this.playerState = playerState;
    this._unsubs.push(EventBus.subscribe(COMBAT_EVENTS.FINISHED, (payload) => this._onCombatFinished(payload)));
    return this;
  }

  /** Unsubscribes from every event this engine listens to. */
  detach() {
    this._unsubs.forEach((unsubscribe) => unsubscribe());
    this._unsubs = [];
  }

  _onCombatFinished(payload) {
    if (!this.playerState) return;
    if (payload.winner === null) return; // A draw never counts as an upset win.

    const winnerKey = payload.winner;
    const winnerId = payload.fighters?.[winnerKey];
    const isPlayerFighter = this.playerState.roster.some((fighter) => fighter.identity.id === winnerId);
    if (!isPlayerFighter) return;

    const loserKey = winnerKey === 'A' ? 'B' : 'A';
    const ratingGap = (payload.preFightRatings?.[loserKey] ?? 0) - (payload.preFightRatings?.[winnerKey] ?? 0);
    if (ratingGap >= BALANCE.HALL_OF_FAME_BADGES.UPSET_RATING_GAP_THRESHOLD) {
      this.playerState.unlockBadge('UPSET_DU_SIECLE');
    }
  }
}

const instance = new HallOfFameEngine();
export default instance;
export { HallOfFameEngine };
