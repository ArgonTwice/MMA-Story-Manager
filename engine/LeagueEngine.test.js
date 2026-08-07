/**
 * engine/LeagueEngine.test.js
 * Run with: node --test engine/LeagueEngine.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import BALANCE from '../data/balance.js';
import PlayerState from '../state/PlayerState.js';
import {
  getCurrentTier,
  getWinrate,
  evaluateLeagueStanding,
  recordLeagueFightResult,
  getPurseMultiplier,
  getPassiveIncomeMultiplier,
  getPromotionProgress,
} from './LeagueEngine.js';

test('a fresh gym starts in the bottom tier (LOCAL_UNDERGROUND) with a 1x purse/passive-income multiplier', () => {
  const playerState = new PlayerState({ money: 25000 });
  const tier = getCurrentTier(playerState);
  assert.equal(tier.id, BALANCE.LEAGUE_PYRAMID.TIER_ORDER[0]);
  assert.equal(getPurseMultiplier(playerState), 1);
  assert.equal(getPassiveIncomeMultiplier(playerState), 1);
});

test('getWinrate is null with no fight history, then reflects wins/total as results are recorded', () => {
  const playerState = new PlayerState({ money: 25000, reputation: 0 });
  assert.equal(getWinrate(playerState), null);

  recordLeagueFightResult(playerState, true);
  recordLeagueFightResult(playerState, false);
  assert.equal(getWinrate(playerState), 0.5);
});

test('recentFightResults is capped at FIGHT_HISTORY_WINDOW (FIFO — oldest dropped first)', () => {
  const playerState = new PlayerState({ money: 25000, reputation: 0 });
  const window = BALANCE.LEAGUE_PYRAMID.FIGHT_HISTORY_WINDOW;
  for (let i = 0; i < window + 5; i += 1) recordLeagueFightResult(playerState, i % 2 === 0);
  assert.equal(playerState.recentFightResults.length, window);
});

test('promotion requires BOTH sufficient Reputation AND winrate >= PROMOTION_WINRATE_THRESHOLD, not either alone', () => {
  const cfg = BALANCE.LEAGUE_PYRAMID;
  const nextTier = cfg.TIERS[cfg.TIER_ORDER[1]];

  // High reputation, but a losing record — must NOT promote.
  const lowWinrateGym = new PlayerState({ money: 25000, reputation: nextTier.promotionReputationThreshold + 10 });
  for (let i = 0; i < cfg.MIN_FIGHTS_FOR_EVALUATION; i += 1) recordLeagueFightResult(lowWinrateGym, false);
  assert.equal(lowWinrateGym.leagueTier, cfg.TIER_ORDER[0]);

  // Good record, but reputation too low — must NOT promote.
  const lowRepGym = new PlayerState({ money: 25000, reputation: 0 });
  for (let i = 0; i < cfg.MIN_FIGHTS_FOR_EVALUATION; i += 1) recordLeagueFightResult(lowRepGym, true);
  assert.equal(lowRepGym.leagueTier, cfg.TIER_ORDER[0]);

  // Both conditions met — must promote.
  const readyGym = new PlayerState({ money: 25000, reputation: nextTier.promotionReputationThreshold + 10 });
  let lastEvaluation;
  for (let i = 0; i < cfg.MIN_FIGHTS_FOR_EVALUATION; i += 1) lastEvaluation = recordLeagueFightResult(readyGym, true);
  assert.equal(readyGym.leagueTier, nextTier.id);
  assert.equal(lastEvaluation.changed, true);
  assert.equal(lastEvaluation.direction, 'PROMOTED');
});

test('relegation triggers on winrate < RELEGATION_WINRATE_THRESHOLD alone, even with high reputation', () => {
  const cfg = BALANCE.LEAGUE_PYRAMID;
  const nationalTierId = cfg.TIER_ORDER[1];
  const playerState = new PlayerState({ money: 25000, reputation: 100, leagueTier: nationalTierId });

  let lastEvaluation;
  for (let i = 0; i < cfg.MIN_FIGHTS_FOR_EVALUATION; i += 1) lastEvaluation = recordLeagueFightResult(playerState, false);

  assert.equal(playerState.leagueTier, cfg.TIER_ORDER[0]);
  assert.equal(lastEvaluation.direction, 'RELEGATED');
});

test('no promotion/relegation evaluated below MIN_FIGHTS_FOR_EVALUATION, even with a perfect or winless record', () => {
  const playerState = new PlayerState({ money: 25000, reputation: 100 });
  recordLeagueFightResult(playerState, true);
  const evaluation = evaluateLeagueStanding(playerState);
  assert.equal(evaluation.changed, false);
});

test('the top tier never promotes further, and the bottom tier never relegates further', () => {
  const cfg = BALANCE.LEAGUE_PYRAMID;
  const topTierId = cfg.TIER_ORDER[cfg.TIER_ORDER.length - 1];
  const topGym = new PlayerState({ money: 25000, reputation: 100, leagueTier: topTierId });
  for (let i = 0; i < cfg.MIN_FIGHTS_FOR_EVALUATION; i += 1) recordLeagueFightResult(topGym, true);
  assert.equal(topGym.leagueTier, topTierId);

  const bottomGym = new PlayerState({ money: 25000, reputation: 0 });
  for (let i = 0; i < cfg.MIN_FIGHTS_FOR_EVALUATION; i += 1) recordLeagueFightResult(bottomGym, false);
  assert.equal(bottomGym.leagueTier, cfg.TIER_ORDER[0]);
});

test('getPromotionProgress reports null progress fields with no fight history, and 0-1 progress once fights are logged', () => {
  const playerState = new PlayerState({ money: 25000, reputation: 10 });
  const emptyProgress = getPromotionProgress(playerState);
  assert.equal(emptyProgress.winrateProgress, null);

  recordLeagueFightResult(playerState, true);
  const progress = getPromotionProgress(playerState);
  assert.ok(progress.winrateProgress >= 0 && progress.winrateProgress <= 1);
  assert.ok(progress.reputationProgress >= 0 && progress.reputationProgress <= 1);
  assert.equal(progress.nextTier.id, BALANCE.LEAGUE_PYRAMID.TIER_ORDER[1]);
});

test('a higher league tier scales purses and passive income up (ELITE_MONDIALE > NATIONAL > LOCAL_UNDERGROUND)', () => {
  const cfg = BALANCE.LEAGUE_PYRAMID;
  const local = new PlayerState({ money: 25000, leagueTier: cfg.TIER_ORDER[0] });
  const national = new PlayerState({ money: 25000, leagueTier: cfg.TIER_ORDER[1] });
  const elite = new PlayerState({ money: 25000, leagueTier: cfg.TIER_ORDER[2] });

  assert.ok(getPurseMultiplier(national) > getPurseMultiplier(local));
  assert.ok(getPurseMultiplier(elite) > getPurseMultiplier(national));
  assert.ok(getPassiveIncomeMultiplier(elite) > getPassiveIncomeMultiplier(local));
});
