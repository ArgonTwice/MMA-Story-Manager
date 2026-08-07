/**
 * engine/LeagueEngine.js
 * ---------------------------------------------------------------------------
 * The PLAYER's own 3-tier competitive pyramid (BALANCE.LEAGUE_PYRAMID):
 * Local/Underground -> National -> Elite Mondiale. Tracks a rolling
 * window of the gym's last FIGHT_HISTORY_WINDOW SANCTIONED fight results
 * (win/loss booleans, oldest first — see PlayerState#recentFightResults)
 * and promotes/relegates by Reputation + winrate:
 *
 *   - Promotion: Reputation >= the next tier's threshold AND winrate over
 *     the window >= PROMOTION_WINRATE_THRESHOLD.
 *   - Relegation: winrate over the window < RELEGATION_WINRATE_THRESHOLD,
 *     regardless of Reputation — a bad record demotes you even if the gym
 *     is still famous.
 *
 * Distinct from data/leagues.js's own LEAGUES catalog (4 entries, used
 * exclusively to tag which purse tier a RIVAL gym's autonomous
 * TransferMarket/ProspectGenerator contracts fall under, by Reputation
 * alone, with no promotion/relegation state) — the two never read each
 * other. Only web/app.js's normal ("WFC") Combat-tab fights count toward
 * league history; Underground Circuit bouts are explicitly "hors sanction
 * officielle" and never call recordLeagueFightResult.
 * ---------------------------------------------------------------------------
 */

import BALANCE from '../data/balance.js';

/** @returns {Object} BALANCE.LEAGUE_PYRAMID.TIERS[playerState.leagueTier], falling back to the bottom tier for an unrecognized/legacy value. */
export function getCurrentTier(playerState) {
  const cfg = BALANCE.LEAGUE_PYRAMID;
  return cfg.TIERS[playerState.leagueTier] ?? cfg.TIERS[cfg.TIER_ORDER[0]];
}

/** @returns {number|null} Wins / total over the rolling window, or null if the window is empty. */
export function getWinrate(playerState) {
  const history = playerState.recentFightResults;
  if (history.length === 0) return null;
  return history.filter(Boolean).length / history.length;
}

function tierIndex(tierId) {
  return BALANCE.LEAGUE_PYRAMID.TIER_ORDER.indexOf(tierId);
}

/**
 * Evaluates (but does not itself record a result) whether the gym's
 * CURRENT standing should promote or relegate it, given its current
 * Reputation and rolling fight-history winrate. Pure: reads only, never
 * mutates — see recordLeagueFightResult() for the mutating counterpart
 * that actually calls this after logging a fight.
 *
 * @param {Object} playerState
 * @returns {{ changed: boolean, direction: 'PROMOTED'|'RELEGATED'|null, newTierId: string|null }}
 */
export function evaluateLeagueStanding(playerState) {
  const cfg = BALANCE.LEAGUE_PYRAMID;
  const winrate = getWinrate(playerState);
  if (winrate === null || playerState.recentFightResults.length < cfg.MIN_FIGHTS_FOR_EVALUATION) {
    return { changed: false, direction: null, newTierId: null };
  }

  const currentIndex = tierIndex(playerState.leagueTier);

  const nextTierId = cfg.TIER_ORDER[currentIndex + 1];
  if (nextTierId) {
    const nextTier = cfg.TIERS[nextTierId];
    if (playerState.reputation >= nextTier.promotionReputationThreshold && winrate >= cfg.PROMOTION_WINRATE_THRESHOLD) {
      return { changed: true, direction: 'PROMOTED', newTierId: nextTierId };
    }
  }

  const prevTierId = cfg.TIER_ORDER[currentIndex - 1];
  if (prevTierId && winrate < cfg.RELEGATION_WINRATE_THRESHOLD) {
    return { changed: true, direction: 'RELEGATED', newTierId: prevTierId };
  }

  return { changed: false, direction: null, newTierId: null };
}

/**
 * Logs one sanctioned fight's outcome into the rolling window (FIFO,
 * capped at FIGHT_HISTORY_WINDOW), then evaluates and applies any
 * resulting promotion/relegation. Call once per completed normal (WFC)
 * Combat-tab fight — never for Underground Circuit bouts or sparring.
 *
 * @param {Object} playerState
 * @param {boolean} won
 * @returns {{ changed: boolean, direction: 'PROMOTED'|'RELEGATED'|null, newTierId: string|null }}
 */
export function recordLeagueFightResult(playerState, won) {
  const cfg = BALANCE.LEAGUE_PYRAMID;
  playerState.recentFightResults = [...playerState.recentFightResults, won].slice(-cfg.FIGHT_HISTORY_WINDOW);

  const evaluation = evaluateLeagueStanding(playerState);
  if (evaluation.changed) playerState.leagueTier = evaluation.newTierId;
  return evaluation;
}

/**
 * @param {Object} playerState
 * @returns {number} Fight purses scale by this multiplier at the gym's
 *   current league tier — see engine/CombatEngine.js#_computePurses.
 */
export function getPurseMultiplier(playerState) {
  return getCurrentTier(playerState).purseMultiplier;
}

/**
 * @param {Object} playerState
 * @returns {number} Weekly passive income ("retombees de sponsors") scales
 *   by this multiplier at the gym's current league tier — see
 *   engine/EconomyEngine.js#processWeeklyExpenses.
 */
export function getPassiveIncomeMultiplier(playerState) {
  return getCurrentTier(playerState).passiveIncomeMultiplier;
}

/**
 * @param {Object} playerState
 * @returns {{ tier: Object, nextTier: Object|null, winrate: number|null, reputationProgress: number|null, winrateProgress: number|null }}
 *   A UI-ready snapshot for a "progress toward promotion" readout (see
 *   web/app.js's Hub "Staff & Competitions" section). Progress values are
 *   0-1, or null when there's no next tier (already at the top) or no
 *   fight history yet.
 */
export function getPromotionProgress(playerState) {
  const cfg = BALANCE.LEAGUE_PYRAMID;
  const tier = getCurrentTier(playerState);
  const nextTierId = cfg.TIER_ORDER[tierIndex(tier.id) + 1];
  const nextTier = nextTierId ? cfg.TIERS[nextTierId] : null;
  const winrate = getWinrate(playerState);

  return {
    tier,
    nextTier,
    winrate,
    reputationProgress: nextTier ? Math.min(1, playerState.reputation / nextTier.promotionReputationThreshold) : null,
    winrateProgress: nextTier && winrate !== null ? Math.min(1, winrate / cfg.PROMOTION_WINRATE_THRESHOLD) : null,
  };
}

export default {
  getCurrentTier,
  getWinrate,
  evaluateLeagueStanding,
  recordLeagueFightResult,
  getPurseMultiplier,
  getPassiveIncomeMultiplier,
  getPromotionProgress,
};
