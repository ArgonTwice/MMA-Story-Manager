/**
 * engine/SocialFeedEngine.js
 * ---------------------------------------------------------------------------
 * V3.5 "Community Manager": the gym's TikTok/YouTube-style subscriber count
 * (PlayerState#subscribers) and the weekly merchandising/monetization income
 * it generates, plus the "Filmer les combattants" toggle
 * (PlayerState#filmingEnabled) that boosts both at the cost of morale for
 * Introverti roster fighters — see BALANCE.COMMUNITY_MANAGER.
 *
 * Deliberately SEPARATE from engine/SocialEngine.js, which is a reactive,
 * always-on fan/journalist/rival-trash-talk POST generator (no economic
 * effect of its own) — the two never read each other. Also separate from
 * data/balance.js's own dormant SOCIAL_MEDIA.STARTING_FOLLOWERS/
 * BASE_WEEKLY_GROWTH_PERCENT (a per-FIGHTER follower concept that was
 * planned but never wired to anything) — this module's subscribers are
 * GYM-wide, and is the one of the two actually implemented.
 *
 * Pure functions only, like engine/StaffEngine.js/engine/GymInfrastructure.js:
 * every effect is computed here and applied through PlayerState/Fighter's
 * own public mutators, called once per week from
 * engine/ProgressionEngine.js#advanceWeek alongside the other Phase F/V3.5
 * weekly-resolution calls.
 * ---------------------------------------------------------------------------
 */

import BALANCE from '../data/balance.js';

/**
 * @param {Object} playerState
 * @returns {number} How many subscribers the gym gains this week, before
 *   applying it — always >= 0 (subscribers never shrink from this
 *   formula; only a real narrative event could someday cost them).
 */
export function computeWeeklySubscriberGrowth(playerState) {
  const cfg = BALANCE.COMMUNITY_MANAGER;
  const growth = cfg.BASE_WEEKLY_GROWTH + playerState.hype * cfg.GROWTH_PER_HYPE_POINT;
  return playerState.filmingEnabled ? growth * cfg.FILMING_GROWTH_MULTIPLIER : growth;
}

/**
 * @param {Object} playerState
 * @returns {number} This week's merchandising/monetization income, from
 *   the CURRENT (pre-growth) subscriber count.
 */
export function computeWeeklyMerchandisingIncome(playerState) {
  const cfg = BALANCE.COMMUNITY_MANAGER;
  return (playerState.subscribers / 1000) * cfg.INCOME_PER_1000_SUBSCRIBERS_WEEKLY;
}

/**
 * Applies FILMING_INTROVERT_MORALE_PENALTY to every roster fighter
 * carrying the 'Introverti' trait — "fait perdre du moral aux combattants
 * timides/introvertis." No-ops entirely (returns []) when filming is off.
 * @param {Object} playerState
 * @returns {string[]} The fighterIds actually docked this week.
 */
export function applyFilmingMoralePenalty(playerState) {
  if (!playerState.filmingEnabled) return [];

  const cfg = BALANCE.COMMUNITY_MANAGER;
  const affected = [];
  for (const fighter of playerState.roster) {
    if (!fighter.psychology.personality.traits.includes('Introverti')) continue;
    fighter.adjustMorale(cfg.FILMING_INTROVERT_MORALE_PENALTY);
    affected.push(fighter.identity.id);
  }
  return affected;
}

/**
 * Runs the full weekly Community Manager resolution: subscriber growth,
 * merchandising income, and (if filming is on) the introvert morale
 * penalty — call once per week (see engine/ProgressionEngine.js#advanceWeek).
 * @param {Object} playerState
 * @returns {{ subscriberGrowth: number, subscribersAfter: number, merchandisingIncome: number, introvertFightersDocked: string[] }}
 */
export function processWeeklyCommunityManagement(playerState) {
  const merchandisingIncome = computeWeeklyMerchandisingIncome(playerState);
  if (merchandisingIncome > 0) playerState.changeMoney(merchandisingIncome, 'COMMUNITY_MANAGER:MERCHANDISING');

  const subscriberGrowth = computeWeeklySubscriberGrowth(playerState);
  const subscribersAfter = playerState.changeSubscribers(subscriberGrowth, 'COMMUNITY_MANAGER:WEEKLY_GROWTH');

  const introvertFightersDocked = applyFilmingMoralePenalty(playerState);

  return { subscriberGrowth, subscribersAfter, merchandisingIncome, introvertFightersDocked };
}

export default {
  computeWeeklySubscriberGrowth,
  computeWeeklyMerchandisingIncome,
  applyFilmingMoralePenalty,
  processWeeklyCommunityManagement,
};
