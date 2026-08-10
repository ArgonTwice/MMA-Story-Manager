/**
 * engine/LeagueEngine.test.js
 * Run with: node --test engine/LeagueEngine.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import BALANCE from '../data/balance.js';
import Fighter from '../models/Fighter.js';
import PlayerState from '../state/PlayerState.js';
import WorldState from '../state/WorldState.js';
import {
  getCurrentTier,
  getWinrate,
  evaluateLeagueStanding,
  recordLeagueFightResult,
  getPurseMultiplier,
  getPassiveIncomeMultiplier,
  getPromotionProgress,
  resolveRegionalOrg,
  getWeightClassRanking,
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

// ---- V3.5: regional organizations -----------------------------------------

test('resolveRegionalOrg matches Brazil/Europe/USA countries case-insensitively, and falls back to GLOBAL (WFC) otherwise', () => {
  assert.equal(resolveRegionalOrg('Bresil').id, BALANCE.REGIONAL_ORGS.BRAZIL.id);
  assert.equal(resolveRegionalOrg('BRAZIL').id, BALANCE.REGIONAL_ORGS.BRAZIL.id);
  assert.equal(resolveRegionalOrg('France').id, BALANCE.REGIONAL_ORGS.EUROPE.id);
  assert.equal(resolveRegionalOrg('USA').id, BALANCE.REGIONAL_ORGS.USA.id);
  assert.equal(resolveRegionalOrg('Atlantis').id, BALANCE.REGIONAL_ORGS.GLOBAL.id);
  assert.equal(resolveRegionalOrg('').id, BALANCE.REGIONAL_ORGS.GLOBAL.id);
  assert.equal(resolveRegionalOrg(null).id, BALANCE.REGIONAL_ORGS.GLOBAL.id);
});

test('resolveRegionalOrg defaults every unmatched/empty country to the same \'WFC\' id every pre-V3.5 fixture already assumes', () => {
  assert.equal(resolveRegionalOrg(undefined).id, 'WFC');
});

test('getWeightClassRanking gathers the player\'s roster and every rival gym\'s roster in one weight class, sorted by rating descending', () => {
  const playerState = new PlayerState({ gymName: 'My Gym', money: 25000 });
  const worldState = new WorldState();

  const strongPlayer = new Fighter({
    identity: { name: 'Strong Player', weightClass: 'Poids Welter' },
    attributes: { skills: { boxe: 90, jambes: 90, sol: 90, soumission: 90, cardio: 90, intelligence: 90 } },
  });
  const weakPlayer = new Fighter({
    identity: { name: 'Weak Player', weightClass: 'Poids Welter' },
    attributes: { skills: { boxe: 10, jambes: 10, sol: 10, soumission: 10, cardio: 10, intelligence: 10 } },
  });
  const otherWeightClass = new Fighter({ identity: { name: 'Off Class', weightClass: 'Poids Lourd' } });
  playerState.addFighter(strongPlayer);
  playerState.addFighter(weakPlayer);
  playerState.addFighter(otherWeightClass);

  const rivalFighter = new Fighter({
    identity: { name: 'Rival Mid', weightClass: 'Poids Welter' },
    attributes: { skills: { boxe: 50, jambes: 50, sol: 50, soumission: 50, cardio: 50, intelligence: 50 } },
  });
  worldState.addRivalGym({ name: 'Rival Gym', reputation: 50, roster: [rivalFighter.toJSON()] });

  const ranking = getWeightClassRanking(playerState, worldState, 'Poids Welter');
  assert.equal(ranking.length, 3);
  assert.equal(ranking[0].name, 'Strong Player');
  assert.equal(ranking[ranking.length - 1].name, 'Weak Player');
  assert.ok(!ranking.some((entry) => entry.name === 'Off Class'), 'a different weight class should never appear in this ranking');
  assert.ok(ranking.every((entry) => typeof entry.overallRating === 'number'));
});

test('getWeightClassRanking respects the limit parameter', () => {
  const playerState = new PlayerState({ gymName: 'My Gym', money: 25000 });
  const worldState = new WorldState();
  for (let i = 0; i < 5; i += 1) {
    playerState.addFighter(new Fighter({ identity: { name: `Fighter ${i}`, weightClass: 'Poids Welter' } }));
  }
  const ranking = getWeightClassRanking(playerState, worldState, 'Poids Welter', 2);
  assert.equal(ranking.length, 2);
});
